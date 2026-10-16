import { describe, expect, it } from "vitest";
import { DAY_MS, isEmojiStale, refreshStaleEmoji } from "../src/emoji/autoRefresh";
import { DEFAULT_SETTINGS, type WorkspaceConfig } from "../src/settings";

const NOW = Date.UTC(2026, 9, 1);
const ws = (id: string, extra: Partial<WorkspaceConfig> = {}): WorkspaceConfig => ({ id, name: id, secret: `slack-${id}`, ...extra });

describe("isEmojiStale", () => {
  it("is stale once the list is as old as the interval", () => {
    expect(isEmojiStale(ws("a", { emojiFetchedAt: NOW - 7 * DAY_MS }), 7, NOW)).toBe(true);
    expect(isEmojiStale(ws("a", { emojiFetchedAt: NOW - 7 * DAY_MS + 1 }), 7, NOW)).toBe(false);
    expect(isEmojiStale(ws("a", { emojiFetchedAt: NOW - 2 * DAY_MS }), 1, NOW)).toBe(true);
  });

  it("treats a workspace with a token but no list yet as stale", () => {
    expect(isEmojiStale(ws("a"), 7, NOW)).toBe(true);
  });

  it("refetches a list stamped in the future (the clock was wrong)", () => {
    expect(isEmojiStale(ws("a", { emojiFetchedAt: NOW + DAY_MS }), 7, NOW)).toBe(true);
  });

  it("never refreshes without a token or when the interval is off", () => {
    expect(isEmojiStale(ws("a", { secret: "" }), 7, NOW)).toBe(false);
    expect(isEmojiStale(ws("a"), 0, NOW)).toBe(false);
    expect(isEmojiStale(ws("a"), Number.NaN, NOW)).toBe(false);
  });

  it("defaults to seven days", () => {
    expect(DEFAULT_SETTINGS.emojiRefreshDays).toBe(7);
  });
});

describe("refreshStaleEmoji", () => {
  it("refreshes only stale workspaces, one at a time", async () => {
    const fresh = ws("fresh", { emojiFetchedAt: NOW - DAY_MS });
    const old = ws("old", { emojiFetchedAt: NOW - 30 * DAY_MS });
    const never = ws("never");
    let running = 0;
    let maxRunning = 0;
    const seen: string[] = [];
    const outcome = await refreshStaleEmoji([fresh, old, never], 7, NOW, async (w) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await Promise.resolve();
      seen.push(w.id);
      running--;
    });
    expect(seen).toEqual(["old", "never"]);
    expect(maxRunning).toBe(1);
    expect(outcome.refreshed.map((w) => w.id)).toEqual(["old", "never"]);
    expect(outcome.failed).toEqual([]);
  });

  it("keeps going after a failure and reports it once", async () => {
    const boom = new Error("offline");
    const outcome = await refreshStaleEmoji([ws("a"), ws("b"), ws("c")], 7, NOW, async (w) => {
      if (w.id === "b") throw boom;
    });
    expect(outcome.refreshed.map((w) => w.id)).toEqual(["a", "c"]);
    expect(outcome.failed).toEqual([{ workspace: expect.objectContaining({ id: "b" }), error: boom }]);
  });

  it("does nothing when refreshing is turned off", async () => {
    const outcome = await refreshStaleEmoji([ws("a")], 0, NOW, async () => {
      throw new Error("should not run");
    });
    expect(outcome).toEqual({ refreshed: [], failed: [] });
  });
});
