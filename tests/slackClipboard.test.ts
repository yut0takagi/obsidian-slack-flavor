import { describe, expect, it, vi } from "vitest";
import { markdownToSlackDoc, mrkdwnToSlackDoc } from "../src/convert/slackDoc";
import { slackDocToDelta } from "../src/convert/toDelta";
import { slackDocToHtml } from "../src/convert/toHtml";
import { slackClipboardData } from "../src/convert/clipboardData";
import { writeClipboard } from "../src/obsidian/clipboard";

const delta = (md: string) => slackDocToDelta(markdownToSlackDoc(md)).ops;
const html = (md: string) => slackDocToHtml(markdownToSlackDoc(md));

describe("markdownToSlackDoc", () => {
  it("classifies lines and keeps inline styles as runs", () => {
    expect(markdownToSlackDoc("# 見出し\n- a **b**\n  1. c\n> q\n\n本文")).toEqual([
      { type: "heading", runs: [{ text: "見出し", bold: true }] },
      { type: "bullet", level: 0, runs: [{ text: "a " }, { text: "b", bold: true }] },
      { type: "ordered", level: 1, label: "1.", runs: [{ text: "c" }] },
      { type: "quote", runs: [{ text: "q" }] },
      { type: "text", runs: [] },
      { type: "text", runs: [{ text: "本文" }] },
    ]);
  });

  it("turns links, bare urls and code into runs", () => {
    expect(markdownToSlackDoc("[G](https://g.co) `x` https://a.jp/_b_")[0]).toEqual({
      type: "text",
      runs: [{ text: "G", link: "https://g.co" }, { text: " " }, { text: "x", code: true }, { text: " https://a.jp/_b_" }],
    });
  });

  it("collapses blank lines and trims them at the edges", () => {
    expect(markdownToSlackDoc("\n\na\n\n\n\nb\n\n").map((l) => l.type)).toEqual(["text", "text", "text"]);
  });
});

describe("slackDocToDelta (slack/texty)", () => {
  it("styles text without padding Japanese", () => {
    expect(delta("これは**太字**です")).toEqual([
      { insert: "これは" },
      { insert: "太字", attributes: { bold: true } },
      { insert: "です\n" },
    ]);
  });

  it("maps italic, strike, code and links", () => {
    expect(delta("_i_ ~~s~~ `c` [l](https://x.jp)")).toEqual([
      { insert: "i", attributes: { italic: true } },
      { insert: " " },
      { insert: "s", attributes: { strike: true } },
      { insert: " " },
      { insert: "c", attributes: { code: true } },
      { insert: " " },
      { insert: "l", attributes: { link: "https://x.jp" } },
      { insert: "\n" },
    ]);
  });

  it("puts list, quote and code-block attributes on the line breaks", () => {
    expect(delta("- a\n  - b\n1. c\n> q\n```\nx\ny\n```")).toEqual([
      { insert: "a" },
      { insert: "\n", attributes: { list: "bullet" } },
      { insert: "b" },
      { insert: "\n", attributes: { list: "bullet", indent: 1 } },
      { insert: "c" },
      { insert: "\n", attributes: { list: "ordered" } },
      { insert: "q" },
      { insert: "\n", attributes: { blockquote: true } },
      { insert: "x" },
      { insert: "\n", attributes: { "code-block": true } },
      { insert: "y" },
      { insert: "\n", attributes: { "code-block": true } },
    ]);
  });

  it("writes headings as bold lines and tasks as checkbox lines", () => {
    expect(delta("## 共有\n- [ ] 確認\n- [x] 予約")).toEqual([
      { insert: "共有", attributes: { bold: true } },
      { insert: "\n☐ 確認\n☑ 予約\n" },
    ]);
  });

  it("converts ```slack content from mrkdwn", () => {
    expect(delta("```slack\n*太字* と <https://x.jp|リンク>\n> 引用\n```")).toEqual([
      { insert: "太字", attributes: { bold: true } },
      { insert: " と " },
      { insert: "リンク", attributes: { link: "https://x.jp" } },
      { insert: "\n引用" },
      { insert: "\n", attributes: { blockquote: true } },
    ]);
  });

  it("always ends with a line break", () => {
    expect(slackDocToDelta([]).ops).toEqual([{ insert: "\n" }]);
  });
});

describe("mrkdwnToSlackDoc", () => {
  it("follows Slack's boundary rule and flattens mentions and emoji to text", () => {
    expect(mrkdwnToSlackDoc("これは*太字*です <@U1|山田> :tada:")).toEqual([
      { type: "text", runs: [{ text: "これは*太字*です @山田 :tada:" }] },
    ]);
  });
});

describe("slackDocToHtml", () => {
  it("renders inline styles and escapes text", () => {
    expect(html("**b** _i_ ~~s~~ `c<>` [l](https://x.jp?a=1&b=2) <tag>")).toBe(
      '<b>b</b> <i>i</i> <s>s</s> <code>c&lt;&gt;</code> <a href="https://x.jp?a=1&amp;b=2">l</a> &lt;tag&gt;<br>',
    );
  });

  it("flattens lists to bullets with indentation and groups quotes", () => {
    expect(html("- a\n  - b\n> q1\n> q2\n```\nx < y\n```")).toBe(
      "• a<br>&nbsp;&nbsp;&nbsp;&nbsp;◦ b<br><blockquote>q1<br>q2<br></blockquote><pre>x &lt; y</pre>",
    );
  });
});

describe("slackClipboardData", () => {
  it("provides plain mrkdwn, html and slack/texty together", () => {
    const data = slackClipboardData(markdownToSlackDoc("これは**太字**です"), { spaceAroundMarkers: true });
    expect(data["text/plain"]).toBe("これは *太字* です");
    expect(data["text/html"]).toBe("これは<b>太字</b>です<br>");
    expect(JSON.parse(data["slack/texty"]).ops[1]).toEqual({ insert: "太字", attributes: { bold: true } });
  });
});

describe("writeClipboard", () => {
  it("sets every type in a capturing copy handler and keeps other handlers out", () => {
    const store = new Map<string, string>();
    const other = vi.fn();
    document.addEventListener("copy", other);
    const exec = vi.fn(() => {
      const event = new Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, "clipboardData", { value: { setData: (t: string, v: string) => store.set(t, v) } });
      document.body.dispatchEvent(event);
      return true;
    });

    expect(writeClipboard({ "text/plain": "p", "slack/texty": "{}" }, window, exec)).toBe(true);
    expect(Object.fromEntries(store)).toEqual({ "text/plain": "p", "slack/texty": "{}" });
    expect(exec).toHaveBeenCalledWith("copy");
    expect(other).not.toHaveBeenCalled();
    document.removeEventListener("copy", other);
  });

  it("reports failure when no copy event arrives", () => {
    expect(writeClipboard({ "text/plain": "p" }, window, () => false)).toBe(false);
  });
});
