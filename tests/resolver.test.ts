import { describe, expect, it } from "vitest";
import { resolveEmoji, searchEmoji } from "../src/emoji/resolver";

const custom = {
  party_parrot: "https://emoji.slack-edge.com/T1/party_parrot/abc.gif",
  parrot: "alias:party_parrot",
  like: "alias:+1",
  zzloop_a: "alias:zzloop_b",
  zzloop_b: "alias:zzloop_a",
  承知: "https://emoji.slack-edge.com/T1/shouchi/def.png",
  smile: "https://emoji.slack-edge.com/T1/smile/override.png",
};

describe("resolveEmoji", () => {
  it("resolves standard emoji by any of its short names", () => {
    expect(resolveEmoji("tada")).toEqual({ kind: "unicode", name: "tada", char: "🎉" });
    expect(resolveEmoji("+1")?.kind).toBe("unicode");
    expect(resolveEmoji("thumbsup")).toEqual({ kind: "unicode", name: "thumbsup", char: "👍" });
  });

  it("applies skin tones 2-6 and ignores them for emoji without variants", () => {
    expect(resolveEmoji("+1", undefined, 3)).toEqual({ kind: "unicode", name: "+1", char: "👍🏼" });
    expect(resolveEmoji("thumbsup", undefined, 6)).toMatchObject({ char: "👍🏿" });
    expect(resolveEmoji("tada", undefined, 3)).toMatchObject({ char: "🎉" });
  });

  it("resolves custom emoji to its image url", () => {
    expect(resolveEmoji("party_parrot", custom)).toEqual({
      kind: "custom",
      name: "party_parrot",
      url: "https://emoji.slack-edge.com/T1/party_parrot/abc.gif",
    });
    expect(resolveEmoji("承知", custom)).toMatchObject({ kind: "custom" });
  });

  it("follows aliases to custom and standard emoji, keeping the requested name", () => {
    expect(resolveEmoji("parrot", custom)).toMatchObject({ kind: "custom", name: "parrot", url: custom.party_parrot });
    expect(resolveEmoji("like", custom)).toEqual({ kind: "unicode", name: "like", char: "👍" });
  });

  it("returns null for alias loops and unknown names", () => {
    expect(resolveEmoji("zzloop_a", custom)).toBeNull();
    expect(resolveEmoji("no_such_emoji", custom)).toBeNull();
    expect(resolveEmoji("")).toBeNull();
  });

  it("prefers the workspace emoji when a custom name shadows a standard one", () => {
    expect(resolveEmoji("smile", custom)).toMatchObject({ kind: "custom" });
    expect(resolveEmoji("smile")).toMatchObject({ kind: "unicode", char: "😄" });
  });

  it("falls back to lowercase", () => {
    expect(resolveEmoji("TADA")).toMatchObject({ char: "🎉" });
  });
});

describe("searchEmoji", () => {
  it("lists workspace emoji before standard ones and prefix matches before substring matches", () => {
    const names = searchEmoji("par", custom, 50).map((e) => e.name);
    expect(names.slice(0, 2)).toEqual(["parrot", "party_parrot"]);
    expect(names).toContain("parking");
    expect(names.indexOf("parking")).toBeGreaterThan(names.indexOf("party_parrot"));
  });

  it("drops aliases that do not resolve and respects the limit", () => {
    expect(searchEmoji("zzloop", custom, 10)).toEqual([]);
    expect(searchEmoji("a", custom, 5)).toHaveLength(5);
  });

  it("matches case-insensitively", () => {
    expect(searchEmoji("TAD", undefined, 5).map((e) => e.name)).toContain("tada");
  });
});
