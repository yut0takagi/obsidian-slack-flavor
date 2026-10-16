import { describe, expect, it } from "vitest";
import { parseSlackBlock } from "../src/block/parse";
import { mrkdwnToMarkdown, slackBlockToMarkdown } from "../src/convert/toMarkdown";
import { threadToSlackBlock } from "../src/slack/toBlock";
import type { SlackApiMessage } from "../src/slack/client";

const SRC = "https://acme.slack.com/archives/C1/p1790731800000100";

describe("mrkdwnToMarkdown", () => {
  it("turns Slack emphasis and code into Markdown", () => {
    expect(mrkdwnToMarkdown("*太字* と _斜体_ と ~取消~ と `code`")).toBe("**太字** と *斜体* と ~~取消~~ と `code`");
    expect(mrkdwnToMarkdown("*_両方_*")).toBe("***両方***");
  });

  it("writes links as Markdown links and drops unsafe ones to their label", () => {
    expect(mrkdwnToMarkdown("<https://x.jp/a_(b)|リンク> https://a.jp/_b_ <javascript:alert(1)|x> <mailto:a@b.jp>")).toBe(
      "[リンク](https://x.jp/a_%28b%29) <https://a.jp/_b_> x <mailto:a@b.jp>",
    );
  });

  it("flattens mentions to text and keeps emoji codes for the note renderer", () => {
    expect(mrkdwnToMarkdown("<@U1|山田> <#C9|random> <!here> <!subteam^S1|@devs> :party_parrot: :+1::skin-tone-2:")).toBe(
      "@山田 \\#random @here @devs :party_parrot: :+1::skin-tone-2:",
    );
  });

  it("escapes characters that would format in Obsidian but are plain in Slack", () => {
    expect(mrkdwnToMarkdown("これは*太字*です 2*3 [x] # ==y== %%c%% $5 a|b x^2 <b>")).toBe(
      "これは\\*太字\\*です 2\\*3 \\[x\\] \\# \\=\\=y\\=\\= \\%\\%c\\%\\% \\$5 a\\|b x\\^2 \\<b>",
    );
  });

  it("follows the lenient boundary rule when asked", () => {
    expect(mrkdwnToMarkdown("これは*太字*です", { strict: false })).toBe("これは**太字**です");
  });

  it("keeps line breaks, quotes and code blocks", () => {
    expect(mrkdwnToMarkdown("a\n\nb\n> 引用\n```\nx `y`\n```")).toBe("a\n\nb\n> 引用\n```\nx `y`\n```");
  });

  it("keeps a lone dashes line from turning the line above into a heading", () => {
    expect(mrkdwnToMarkdown("見出しではない\n---")).toBe("見出しではない\n\\---");
  });
});

describe("slackBlockToMarkdown", () => {
  it("writes a thread as one callout with the channel linked to the source", () => {
    const block = parseSlackBlock(
      [
        "channel: #general",
        `source: ${SRC}`,
        "",
        "@田中 2026-09-30 10:30",
        "<@U2|山田 太郎> 定例は *14時* から",
        "+:tada: 3 :eyes: 1",
        "",
        "↳ @山田 太郎 2026-09-30 10:32",
        "了解です",
        "> 引用",
      ].join("\n"),
    );
    expect(slackBlockToMarkdown(block)).toBe(
      [
        `> [!quote] [\\#general](${SRC})`,
        "> **田中** 2026-09-30 10:30",
        "> @山田 太郎 定例は **14時** から",
        "> :tada: 3 · :eyes: 1",
        ">",
        "> ↳ **山田 太郎** 2026-09-30 10:32",
        "> 了解です",
        "> > 引用",
      ].join("\n"),
    );
  });

  it("escapes author names and leaves the title empty when there is no channel", () => {
    expect(slackBlockToMarkdown(parseSlackBlock("@a_b*c\nhi"))).toBe("> [!quote]\n> **a\\_b\\*c**\n> hi");
  });

  it("does not link a source that is not a Slack link", () => {
    expect(slackBlockToMarkdown(parseSlackBlock("title: 定例\nsource: javascript:alert(1)\n\n@a\nhi")).split("\n")[0]).toBe("> [!quote] 定例");
  });

  it("converts a block without messages as a single message", () => {
    expect(slackBlockToMarkdown(parseSlackBlock("*太字*\n\n次の段落"))).toBe("> [!quote]\n> **太字**\n>\n> 次の段落");
  });
});

describe("threadToSlackBlock", () => {
  it("builds the thread tree that both output formats share", async () => {
    const messages: SlackApiMessage[] = [
      { ts: "1790731800.000100", user: "U1", text: "<@U2> 確認お願いします", reactions: [{ name: "eyes", count: 2 }] },
      { ts: "1790731920.000200", user: "U2", text: "了解です", thread_ts: "1790731800.000100" },
    ];
    const names: Record<string, string> = { U1: "田中", U2: "山田 太郎" };
    const block = await threadToSlackBlock(messages, {
      userName: async (id) => names[id] ?? id,
      channelName: async () => undefined,
      timeZone: "Asia/Tokyo",
      channel: "general",
      source: SRC,
    });
    expect(block).toEqual({
      meta: { channel: "#general", source: SRC },
      text: "",
      messages: [
        {
          author: "田中",
          time: "2026-09-30 10:30",
          body: "<@U2|山田 太郎> 確認お願いします",
          reactions: [{ emoji: ":eyes:", count: 2 }],
          replies: [{ author: "山田 太郎", time: "2026-09-30 10:32", body: "了解です", reactions: [], replies: [] }],
        },
      ],
    });
  });
});
