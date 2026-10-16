import { describe, expect, it, vi } from "vitest";
import { resolveEmoji, withImageUrl } from "../src/emoji/resolver";
import { parseMrkdwn } from "../src/mrkdwn/parse";
import { renderBlocks } from "../src/mrkdwn/render";
import { DEFAULT_SETTINGS } from "../src/settings";
import { cacheFileName, EmojiImageCache, type CacheAdapter, type FetchedImage, type ImageFetch } from "../src/store/imageCache";

const DIR = ".obsidian/plugins/slack-flavor/emoji-cache";
const PARROT = "https://emoji.slack-edge.com/T1/parrot/abc.gif";
const SHIP = "https://emoji.slack-edge.com/T1/shipit/def.png";
const BLOB = "https://emoji.slack-edge.com/T1/blob/ghi.png";
const FILE_IN_DIR = new RegExp(`^${DIR.replace(/\./g, "\\.")}/[0-9a-f]{16}\\.(png|gif)$`);

const image = (bytes: number, contentType = "image/png"): FetchedImage => ({ status: 200, contentType, data: new ArrayBuffer(bytes) });

function memoryAdapter(extraListing: string[] = []) {
  const files = new Map<string, { data: ArrayBuffer; mtime: number }>();
  let clock = 0;
  const adapter: CacheAdapter = {
    exists: async (p) => files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)) || extraListing.length > 0,
    list: async (p) => ({ files: [...[...files.keys()].filter((k) => k.slice(0, k.lastIndexOf("/")) === p), ...extraListing], folders: [] }),
    stat: async (p) => {
      const f = files.get(p);
      return f ? { size: f.data.byteLength, mtime: f.mtime } : null;
    },
    writeBinary: async (p, data) => void files.set(p, { data, mtime: ++clock }),
    mkdir: async () => {},
    remove: async (p) => void files.delete(p),
    rmdir: async (p) => {
      for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k);
    },
    getResourcePath: (p) => `app://local/${p}`,
  };
  return { adapter, files };
}

function newCache(adapter: CacheAdapter, fetchImage: ImageFetch, maxBytes = 1024 * 1024, now = () => 0) {
  return new EmojiImageCache(adapter, DIR, fetchImage, { maxBytes: () => maxBytes, now });
}

describe("cacheFileName", () => {
  it("hashes the url and keeps only a known image extension", () => {
    expect(cacheFileName(PARROT)).toMatch(/^[0-9a-f]{16}\.gif$/);
    expect(cacheFileName(SHIP)).toMatch(/^[0-9a-f]{16}\.png$/);
    expect(cacheFileName("https://e.example/x.JPEG")).toMatch(/\.jpg$/);
    expect(cacheFileName("https://e.example/x.svg?.png")).toMatch(/^[0-9a-f]{16}\.png$/);
    expect(cacheFileName(PARROT)).toBe(cacheFileName(PARROT));
    expect(cacheFileName(PARROT)).not.toBe(cacheFileName(SHIP));
  });

  it("never lets the emoji name or path reach the file name", () => {
    const name = cacheFileName("https://emoji.slack-edge.com/T1/..%2F..%2Fevil/../../../x.png");
    expect(name).toMatch(/^[0-9a-f]{16}\.png$/);
  });

  it("refuses urls that are not https", () => {
    expect(cacheFileName("http://emoji.slack-edge.com/a.png")).toBeNull();
    expect(cacheFileName("file:///etc/passwd")).toBeNull();
    expect(cacheFileName("not a url")).toBeNull();
  });
});

describe("EmojiImageCache", () => {
  it("defaults to a 50 MB limit", () => {
    expect(DEFAULT_SETTINGS.emojiCacheMB).toBe(50);
  });

  it("saves a displayed image in its folder and serves it from there next time", async () => {
    const { adapter, files } = memoryAdapter();
    const fetchImage = vi.fn(async () => image(10, "image/gif"));
    const cache = newCache(adapter, fetchImage);
    await cache.load();

    expect(cache.displayUrl(PARROT)).toBe(PARROT);
    await cache.idle();
    const [path] = [...files.keys()];
    expect(path).toMatch(FILE_IN_DIR);
    expect(cache.displayUrl(PARROT)).toBe(`app://local/${path}`);
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(fetchImage).toHaveBeenCalledWith(PARROT);
    expect(cache.usage()).toEqual({ files: 1, bytes: 10 });
  });

  it("shows cached emoji after a restart without a network", async () => {
    const { adapter, files } = memoryAdapter();
    const online = newCache(adapter, async () => image(10, "image/gif"));
    await online.load();
    online.displayUrl(PARROT);
    await online.idle();
    const [path] = [...files.keys()];

    const offlineFetch = vi.fn(async (): Promise<FetchedImage> => {
      throw new Error("net::ERR_INTERNET_DISCONNECTED");
    });
    const offline = newCache(adapter, offlineFetch);
    await offline.load();
    const resolve = withImageUrl((name) => resolveEmoji(name, { parrot: PARROT }), (url) => offline.displayUrl(url));
    const el = document.createElement("div");
    renderBlocks(parseMrkdwn("hi :parrot: :tada:"), el, { resolveEmoji: resolve });
    await offline.idle();

    expect(el.querySelector("img")?.getAttribute("src")).toBe(`app://local/${path}`);
    expect(el.querySelector(".sf-emoji-unicode")?.textContent).toBe("🎉");
    expect(offlineFetch).not.toHaveBeenCalled();
    expect(offline.usage()).toEqual({ files: 1, bytes: 10 });
  });

  it("downloads an image once however often it is shown", async () => {
    const { adapter } = memoryAdapter();
    const fetchImage = vi.fn(async () => image(10));
    const cache = newCache(adapter, fetchImage);
    await cache.load();
    for (let i = 0; i < 5; i++) cache.displayUrl(SHIP);
    await cache.idle();
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it("looks up a cached copy without downloading anything", async () => {
    const { adapter } = memoryAdapter();
    const fetchImage = vi.fn(async () => image(10));
    const cache = newCache(adapter, fetchImage);
    await cache.load();
    expect(cache.cachedUrl(SHIP)).toBeNull();
    await cache.idle();
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("only keeps https responses that are images of a sane size", async () => {
    const { adapter, files } = memoryAdapter();
    const responses: Record<string, FetchedImage> = {
      "https://e.example/html.png": { status: 200, contentType: "text/html", data: new ArrayBuffer(10) },
      "https://e.example/vector.png": { status: 200, contentType: "image/svg+xml", data: new ArrayBuffer(10) },
      "https://e.example/missing.png": { status: 404, contentType: "image/png", data: new ArrayBuffer(10) },
      "https://e.example/empty.png": image(0),
      "https://e.example/huge.png": image(5 * 1024 * 1024),
    };
    const fetchImage = vi.fn(async (url: string) => responses[url]);
    const cache = newCache(adapter, fetchImage, 50 * 1024 * 1024);
    await cache.load();
    expect(cache.displayUrl("http://e.example/plain.png")).toBe("http://e.example/plain.png");
    for (const url of Object.keys(responses)) cache.displayUrl(url);
    await cache.idle();
    expect(fetchImage).toHaveBeenCalledTimes(5);
    expect(files.size).toBe(0);
  });

  it("waits before retrying a failed download", async () => {
    const { adapter } = memoryAdapter();
    let now = 0;
    const fetchImage = vi.fn(async (): Promise<FetchedImage> => {
      throw new Error("offline");
    });
    const cache = newCache(adapter, fetchImage, 1024 * 1024, () => now);
    await cache.load();
    cache.displayUrl(SHIP);
    await cache.idle();
    cache.displayUrl(SHIP);
    await cache.idle();
    expect(fetchImage).toHaveBeenCalledTimes(1);
    now += 11 * 60_000;
    cache.displayUrl(SHIP);
    await cache.idle();
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it("removes the oldest images to stay under the size limit", async () => {
    const { adapter, files } = memoryAdapter();
    let now = 0;
    const cache = newCache(adapter, async () => image(10), 25, () => ++now);
    await cache.load();
    for (const url of [PARROT, SHIP, BLOB]) {
      cache.displayUrl(url);
      await cache.idle();
    }
    expect(cache.usage()).toEqual({ files: 2, bytes: 20 });
    expect(files.size).toBe(2);
    expect(cache.cachedUrl(PARROT)).toBeNull();
    expect(cache.cachedUrl(SHIP)).not.toBeNull();
    expect(cache.cachedUrl(BLOB)).not.toBeNull();
  });

  it("does not cache when the limit is 0 and empties itself when the limit drops", async () => {
    const { adapter, files } = memoryAdapter();
    let max = 100;
    const fetchImage = vi.fn(async () => image(10));
    const cache = new EmojiImageCache(adapter, DIR, fetchImage, { maxBytes: () => max });
    await cache.load();
    cache.displayUrl(SHIP);
    await cache.idle();
    expect(files.size).toBe(1);

    max = 0;
    await cache.enforceLimit();
    expect(files.size).toBe(0);
    cache.displayUrl(PARROT);
    await cache.idle();
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it("clears every cached image", async () => {
    const { adapter, files } = memoryAdapter();
    const cache = newCache(adapter, async () => image(10));
    await cache.load();
    cache.displayUrl(SHIP);
    await cache.idle();
    await cache.clear();
    expect(files.size).toBe(0);
    expect(cache.usage()).toEqual({ files: 0, bytes: 0 });
    expect(cache.cachedUrl(SHIP)).toBeNull();
  });

  it("ignores anything in the folder listing it did not write itself", async () => {
    const valid = `${DIR}/0123456789abcdef.png`;
    const { adapter, files } = memoryAdapter([
      `${DIR}/../outside.png`,
      `${DIR}/notes.md`,
      `${DIR}/sub/0123456789abcdef.png`,
      ".obsidian/0123456789abcdef.png",
      `${DIR}/0123456789ABCDEF.png`,
    ]);
    files.set(valid, { data: new ArrayBuffer(7), mtime: 1 });
    const cache = newCache(adapter, async () => image(10));
    await cache.load();
    await cache.idle();
    expect(cache.usage()).toEqual({ files: 1, bytes: 7 });
  });
});
