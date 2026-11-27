import { describe, expect, it } from "vitest";
import { checkPostAt, checkPostText, fromLocalInput, MAX_POST_CHARS, MAX_SCHEDULE_DAYS, notifications, toLocalInput } from "../src/slack/post";

describe("notifications", () => {
  it("finds what would notify people when the text is posted", () => {
    expect(notifications("<!here> 定例です <!channel> <!everyone> <@U1> <@U2|山田> <@U1> <!subteam^S1|@devs>")).toEqual({
      broadcasts: ["here", "channel", "everyone"],
      users: 2,
      groups: 1,
    });
  });

  it("does not count plain @words, which the API posts as text", () => {
    expect(notifications("@here @channel @山田 mail@example.com")).toEqual({ broadcasts: [], users: 0, groups: 0 });
  });
});

describe("checkPostText", () => {
  it("refuses empty and over-long text", () => {
    expect(checkPostText("  \n ")).toBe("empty");
    expect(checkPostText("x".repeat(MAX_POST_CHARS + 1))).toBe("too-long");
    expect(checkPostText("hello")).toBeNull();
  });
});

describe("checkPostAt", () => {
  const now = new Date("2026-11-27T10:00:00+09:00");

  it("returns Slack's post_at (seconds) for a time at least a minute ahead", () => {
    expect(checkPostAt(new Date("2026-11-27T11:30:00+09:00"), now)).toEqual({ ok: true, postAt: Date.parse("2026-11-27T11:30:00+09:00") / 1000 });
  });

  it("refuses times in the past or too soon, and beyond Slack's limit", () => {
    expect(checkPostAt(new Date("2026-11-27T09:59:00+09:00"), now)).toEqual({ ok: false, reason: "past" });
    expect(checkPostAt(new Date("2026-11-27T10:00:30+09:00"), now)).toEqual({ ok: false, reason: "past" });
    const tooFar = new Date(now.getTime() + (MAX_SCHEDULE_DAYS + 1) * 86_400_000);
    expect(checkPostAt(tooFar, now)).toEqual({ ok: false, reason: "too-far" });
    expect(checkPostAt(new Date(Number.NaN), now)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("toLocalInput / fromLocalInput", () => {
  it("round-trips a datetime-local value in the local zone", () => {
    const d = new Date(2026, 10, 27, 9, 5);
    expect(toLocalInput(d)).toBe("2026-11-27T09:05");
    expect(fromLocalInput("2026-11-27T09:05").getTime()).toBe(d.getTime());
    expect(Number.isNaN(fromLocalInput("nope").getTime())).toBe(true);
  });
});
