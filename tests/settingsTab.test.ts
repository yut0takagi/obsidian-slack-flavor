import { beforeEach, describe, expect, it } from "vitest";
import type SlackFlavorPlugin from "../main";
import { createStrings } from "../src/i18n";
import { SlackFlavorSettingTab } from "../src/obsidian/settingsTab";
import { DEFAULT_SETTINGS } from "../src/settings";
import { fake, resetFake } from "./fakes/obsidian";

const MB = 1024 * 1024;
const s = createStrings("en");

/** A plugin as on a fresh install; the cache reports its size only once idle() resolves, like at startup. */
function freshPlugin(): SlackFlavorPlugin {
  let bytes = 0;
  return {
    app: {},
    strings: s,
    settings: structuredClone(DEFAULT_SETTINGS),
    imageCache: {
      usage: () => ({ files: 2, bytes }),
      idle: async () => {
        bytes = 3 * MB;
      },
      enforceLimit: async () => {},
      clear: async () => {},
    },
    saveSettings: async () => {},
    refreshViews: () => {},
  } as unknown as SlackFlavorPlugin;
}

/** Lets pending promises settle. A thenable loop never yields, so this only returns once the fake's cap broke it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SlackFlavorSettingTab", () => {
  beforeEach(resetFake);

  it("opens without a promise adopting a Setting (Obsidian froze on its chaining then(), #4)", async () => {
    new SlackFlavorSettingTab(freshPlugin()).display();
    await settle();
    expect(fake.thenCalls).toBe(0);
  });

  it("shows the cache size once the file sizes have been read", async () => {
    new SlackFlavorSettingTab(freshPlugin()).display();
    await settle();
    const cache = fake.settings.find((x) => x.name === s.settingsCache);
    expect(cache?.descs).toEqual([s.settingsCacheDesc(2, "0.0 MB"), s.settingsCacheDesc(2, "3.0 MB")]);
  });
});
