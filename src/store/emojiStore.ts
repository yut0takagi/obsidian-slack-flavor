import type { CustomEmojiMap } from "../emoji/resolver";

/** The slice of Obsidian's DataAdapter the store needs. */
export interface StoreAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Keeps each workspace's emoji list in <plugin dir>/emoji/<id>.json so data.json stays small. */
export class EmojiStore {
  private readonly cache = new Map<string, CustomEmojiMap>();

  constructor(
    private readonly adapter: StoreAdapter,
    private readonly pluginDir: string,
  ) {}

  get(id: string): CustomEmojiMap | undefined {
    return this.cache.get(id);
  }

  async load(id: string): Promise<CustomEmojiMap> {
    const path = this.pathOf(id);
    let map: CustomEmojiMap = {};
    if (await this.adapter.exists(path)) {
      try {
        map = JSON.parse(await this.adapter.read(path)) as CustomEmojiMap;
      } catch {
        map = {};
      }
    }
    this.cache.set(id, map);
    return map;
  }

  async save(id: string, map: CustomEmojiMap): Promise<void> {
    const path = this.pathOf(id);
    const dir = `${this.pluginDir}/emoji`;
    if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
    await this.adapter.write(path, JSON.stringify(map));
    this.cache.set(id, map);
  }

  async remove(id: string): Promise<void> {
    const path = this.pathOf(id);
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
    this.cache.delete(id);
  }

  private pathOf(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid workspace id: ${id}`);
    return `${this.pluginDir}/emoji/${id}.json`;
  }
}
