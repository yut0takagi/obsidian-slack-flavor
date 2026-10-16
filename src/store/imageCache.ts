/**
 * Local copies of custom emoji images, so emoji keep showing offline and on flaky mobile connections.
 *
 * Only images that were actually displayed are downloaded, one file per image URL, in a folder inside
 * the plugin's own directory. File names are a hash of the URL plus a fixed extension: nothing from
 * Slack (emoji names, URL paths) ever becomes part of a path.
 */

/** The slice of Obsidian's DataAdapter the cache needs. */
export interface CacheAdapter {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat(path: string): Promise<{ size: number; mtime: number } | null>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
  getResourcePath(path: string): string;
}

export interface FetchedImage {
  status: number;
  contentType?: string;
  data: ArrayBuffer;
}

/** Downloads an image. It is given the URL only: no token or other header goes to the image host. */
export type ImageFetch = (url: string) => Promise<FetchedImage>;

export interface ImageCacheOptions {
  /** Size limit for the whole folder, read on every write so a settings change applies at once. 0 turns caching off. */
  maxBytes: () => number;
  now?: () => number;
  concurrency?: number;
}

const FILE_NAME = /^[0-9a-f]{16}\.(?:png|gif|jpg|webp)$/;
const URL_EXT = /\.(png|gif|jpe?g|webp)$/i;
const IMAGE_TYPE = /^image\/(?:png|gif|jpeg|webp)\b/i;
// Slack caps custom emoji at 128 KB; anything far bigger is not an emoji worth keeping.
const MAX_FILE_BYTES = 1024 * 1024;
const RETRY_AFTER_MS = 10 * 60_000;
const DEFAULT_CONCURRENCY = 3;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;

/** The cache file name for an image URL, or null when the URL may not be cached (anything but https). */
export function cacheFileName(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const ext = URL_EXT.exec(parsed.pathname)?.[1].toLowerCase().replace("jpeg", "jpg") ?? "png";
  return `${fnv1a64(url)}.${ext}`;
}

function fnv1a64(s: string): string {
  let h = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(s)) h = ((h ^ BigInt(byte)) * FNV_PRIME) & U64;
  return h.toString(16).padStart(16, "0");
}

interface Entry {
  size: number;
  at: number;
}

export class EmojiImageCache {
  private readonly entries = new Map<string, Entry>();
  private readonly names = new Map<string, string | null>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly failedAt = new Map<string, number>();
  private readonly waiting: (() => void)[] = [];
  private active = 0;
  private sizing: Promise<void> = Promise.resolve();
  /** Bumped by clear() so downloads already in flight do not write into the emptied folder. */
  private generation = 0;
  private readonly now: () => number;
  private readonly concurrency: number;

  constructor(
    private readonly adapter: CacheAdapter,
    private readonly dir: string,
    private readonly fetchImage: ImageFetch,
    private readonly opts: ImageCacheOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  }

  /**
   * Lists the folder: one call, worth awaiting at startup so the first render can already use the
   * cache offline. File sizes (only needed for the limit) are read in the background.
   */
  async load(): Promise<void> {
    this.entries.clear();
    const files = (await this.adapter.exists(this.dir)) ? (await this.adapter.list(this.dir)).files : [];
    const names: string[] = [];
    for (const path of files) {
      const name = this.nameIn(path);
      if (!name) continue;
      names.push(name);
      this.entries.set(name, { size: 0, at: 0 });
    }
    this.sizing = this.readSizes(names);
  }

  /** The URL to show for an image: the local copy when there is one, otherwise the original (and starts saving it). */
  displayUrl(url: string): string {
    const cached = this.cachedUrl(url);
    if (cached) return cached;
    this.request(url);
    return url;
  }

  /** The local copy's URL, without downloading anything. */
  cachedUrl(url: string): string | null {
    const name = this.nameOf(url);
    return name && this.entries.has(name) ? this.adapter.getResourcePath(this.pathOf(name)) : null;
  }

  usage(): { files: number; bytes: number } {
    let bytes = 0;
    for (const e of this.entries.values()) bytes += e.size;
    return { files: this.entries.size, bytes };
  }

  /** Resolves once sizes are known and no download is running (used by tests and the settings screen). */
  async idle(): Promise<void> {
    await this.sizing;
    while (this.pending.size) await Promise.all([...this.pending.values()]);
  }

  /** Removes the oldest images until the folder fits the limit (all of them when the limit is 0). */
  async enforceLimit(keep?: string): Promise<void> {
    await this.sizing;
    const max = Math.max(0, this.opts.maxBytes());
    let total = this.usage().bytes;
    const oldestFirst = [...this.entries].filter(([name]) => name !== keep).sort((a, b) => a[1].at - b[1].at);
    for (const [name, entry] of oldestFirst) {
      if (max > 0 && total <= max) break;
      await this.removeFile(name);
      total -= entry.size;
    }
  }

  async clear(): Promise<void> {
    this.generation++;
    this.entries.clear();
    this.failedAt.clear();
    if (await this.adapter.exists(this.dir)) await this.adapter.rmdir(this.dir, true);
  }

  private request(url: string): void {
    const name = this.nameOf(url);
    if (!name || this.pending.has(name) || this.opts.maxBytes() <= 0) return;
    const failed = this.failedAt.get(name);
    if (failed !== undefined && this.now() - failed < RETRY_AFTER_MS) return;
    const job = this.limit(() => this.download(url, name)).finally(() => this.pending.delete(name));
    this.pending.set(name, job);
  }

  /** Errors are swallowed on purpose: a missing local copy only means the original URL is shown. */
  private async download(url: string, name: string): Promise<void> {
    const generation = this.generation;
    try {
      await this.sizing;
      if (this.entries.has(name)) return;
      const res = await this.fetchImage(url);
      const size = res.data.byteLength;
      const ok = res.status === 200 && IMAGE_TYPE.test(res.contentType ?? "") && size > 0 && size <= MAX_FILE_BYTES;
      if (!ok || size > this.opts.maxBytes()) throw new Error("not cacheable");
      if (generation !== this.generation) return;
      if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
      await this.adapter.writeBinary(this.pathOf(name), res.data);
      this.entries.set(name, { size, at: this.now() });
      this.failedAt.delete(name);
      await this.enforceLimit(name);
    } catch {
      this.failedAt.set(name, this.now());
    }
  }

  private async limit(task: () => Promise<void>): Promise<void> {
    if (this.active >= this.concurrency) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private async readSizes(names: string[]): Promise<void> {
    for (const name of names) {
      const stat = await this.adapter.stat(this.pathOf(name)).catch(() => null);
      const entry = this.entries.get(name);
      if (!entry) continue;
      if (stat) Object.assign(entry, { size: stat.size, at: stat.mtime });
      else this.entries.delete(name);
    }
  }

  private async removeFile(name: string): Promise<void> {
    this.entries.delete(name);
    try {
      await this.adapter.remove(this.pathOf(name));
    } catch {
      // Already gone.
    }
  }

  private nameOf(url: string): string | null {
    let name = this.names.get(url);
    if (name === undefined) {
      name = cacheFileName(url);
      this.names.set(url, name);
    }
    return name;
  }

  /** A listed path counts only when it sits directly in the folder and has a name this cache would write. */
  private nameIn(path: string): string | null {
    const prefix = `${this.dir}/`;
    if (!path.startsWith(prefix)) return null;
    const name = path.slice(prefix.length);
    return FILE_NAME.test(name) ? name : null;
  }

  private pathOf(name: string): string {
    if (!FILE_NAME.test(name)) throw new Error("Invalid cache file name");
    return `${this.dir}/${name}`;
  }
}
