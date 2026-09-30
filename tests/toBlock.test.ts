import { describe, expect, it } from "vitest";
import { parseSlackBlock } from "../src/block/parse";
import { formatTs, threadToBlock } from "../src/slack/toBlock";
import type { SlackApiMessage } from "../src/slack/client";

const names: Record<string, string> = { U1: "田中", U2: "山田 太郎" };
const deps = {
  userName: async (id: string) => names[id] ?? id,
  channelName: async (id: string) => (id === "C9" ? "random" : undefined),
  timeZone: "Asia/Tokyo",
};

// 2026-09-30 10:30 / 10:32 JST
const ROOT = "1790731800.000100";
const REPLY = "1790731920.000200";

describe("formatTs", () => {
  it("formats a Slack ts in the given time zone", () => {
    expect(formatTs(ROOT, "Asia/Tokyo")).toBe("2026-09-30 10:30");
    expect(formatTs(ROOT, "UTC")).toBe("2026-09-30 01:30");
  });
});

describe("threadToBlock", () => {
  it("writes meta, messages, replies, reactions and resolved mentions", async () => {
    const messages: SlackApiMessage[] = [
      { ts: ROOT, user: "U1", text: "<@U2> 定例は *14時* から <#C9>", reactions: [{ name: "tada", count: 3 }, { name: "+1::skin-tone-2", count: 1 }] },
      { ts: REPLY, user: "U2", text: "了解です", thread_ts: ROOT },
    ];
    const out = await threadToBlock(messages, { ...deps, channel: "general", workspace: "acme" });
    expect(out).toBe(
      [
        "```slack",
        "workspace: acme",
        "channel: #general",
        "",
        "@田中 2026-09-30 10:30",
        "<@U2|山田 太郎> 定例は *14時* から <#C9|random>",
        "+:tada: 3 :+1::skin-tone-2: 1",
        "",
        "↳ @山田 太郎 2026-09-30 10:32",
        "了解です",
        "```",
      ].join("\n"),
    );
  });

  it("round-trips through the block parser", async () => {
    const messages: SlackApiMessage[] = [
      { ts: ROOT, user: "U1", text: "q", reactions: [{ name: "eyes", count: 2 }] },
      { ts: REPLY, user: "U2", text: "a", thread_ts: ROOT },
    ];
    const parsed = parseSlackBlock((await threadToBlock(messages, deps)).split("\n").slice(1, -1).join("\n"));
    expect(parsed.messages).toEqual([
      {
        author: "田中",
        time: "2026-09-30 10:30",
        body: "q",
        reactions: [{ emoji: ":eyes:", count: 2 }],
        replies: [{ author: "山田 太郎", time: "2026-09-30 10:32", body: "a", reactions: [], replies: [] }],
      },
    ]);
  });

  it("names bots and lists attached files", async () => {
    const out = await threadToBlock(
      [{ ts: ROOT, bot_id: "B1", bot_profile: { name: "Deploy Bot" }, text: "done", files: [{ name: "log.txt", permalink: "https://x.slack.com/files/1" }] }],
      deps,
    );
    expect(out).toContain("@Deploy Bot 2026-09-30 10:30\ndone\n📎 <https://x.slack.com/files/1|log.txt>");
  });

  it("uses a longer fence when a message contains ```", async () => {
    const out = await threadToBlock([{ ts: ROOT, user: "U1", text: "```code```" }], deps);
    expect(out.startsWith("````slack\n")).toBe(true);
    expect(out.endsWith("\n````")).toBe(true);
  });
});
