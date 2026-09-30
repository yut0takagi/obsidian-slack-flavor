import { describe, expect, it } from "vitest";
import { resolveEmoji } from "../src/emoji/resolver";
import { findEmoji } from "../src/emoji/noteEmoji";
import { EmojiStore, type StoreAdapter } from "../src/store/emojiStore";

const custom = { parrot: "https://e/p.gif" };
const resolve = (name: string, tone?: number) => resolveEmoji(name, custom, tone);

describe("findEmoji", () => {
  it("returns ranges of resolvable emoji only", () => {
    const text = "hi :parrot: and :tada: but not :nope:";
    expect(findEmoji(text, resolve).map((m) => [text.slice(m.from, m.to), m.emoji.kind])).toEqual([
      [":parrot:", "custom"],
      [":tada:", "unicode"],
    ]);
  });

  it("includes a trailing skin tone in the range", () => {
    const [m] = findEmoji(":+1::skin-tone-4: ok", resolve);
    expect([m.from, m.to]).toEqual([0, 17]);
    expect(m.emoji).toMatchObject({ char: "👍🏽" });
  });

  it("recovers after a colon pair that is not an emoji", () => {
    const text = "10:30:tada: と https://x.jp/a:b";
    expect(findEmoji(text, resolve).map((m) => text.slice(m.from, m.to))).toEqual([":tada:"]);
  });
});

function memoryAdapter(): StoreAdapter & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    exists: async (p) => files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)),
    read: async (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`missing ${p}`);
      return v;
    },
    write: async (p, data) => void files.set(p, data),
    mkdir: async () => {},
    remove: async (p) => void files.delete(p),
  };
}

describe("EmojiStore", () => {
  it("saves, caches and reloads a workspace's emoji", async () => {
    const adapter = memoryAdapter();
    const store = new EmojiStore(adapter, ".obsidian/plugins/slack-flavor");
    await store.save("ws-1", custom);
    expect(store.get("ws-1")).toEqual(custom);
    expect([...adapter.files.keys()]).toEqual([".obsidian/plugins/slack-flavor/emoji/ws-1.json"]);

    const fresh = new EmojiStore(adapter, ".obsidian/plugins/slack-flavor");
    expect(fresh.get("ws-1")).toBeUndefined();
    expect(await fresh.load("ws-1")).toEqual(custom);
    expect(fresh.get("ws-1")).toEqual(custom);
  });

  it("loads an empty map when nothing was saved or the file is broken", async () => {
    const adapter = memoryAdapter();
    const store = new EmojiStore(adapter, "d");
    expect(await store.load("none")).toEqual({});
    adapter.files.set("d/emoji/bad.json", "{oops");
    expect(await store.load("bad")).toEqual({});
  });

  it("removes a workspace's file and cache", async () => {
    const adapter = memoryAdapter();
    const store = new EmojiStore(adapter, "d");
    await store.save("ws", custom);
    await store.remove("ws");
    expect(store.get("ws")).toBeUndefined();
    expect(adapter.files.size).toBe(0);
  });

  it("refuses ids that could escape the folder", async () => {
    const store = new EmojiStore(memoryAdapter(), "d");
    await expect(store.save("../x", custom)).rejects.toThrow();
  });
});
