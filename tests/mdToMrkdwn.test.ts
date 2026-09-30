import { describe, expect, it } from "vitest";
import { markdownToMrkdwn as md } from "../src/convert/mdToMrkdwn";

describe("markdownToMrkdwn: emphasis", () => {
  it("maps bold, italic, strike and highlight", () => {
    expect(md("a **b** c")).toBe("a *b* c");
    expect(md("a __b__ c")).toBe("a *b* c");
    expect(md("*it* and _it_")).toBe("_it_ and _it_");
    expect(md("~~x~~")).toBe("~x~");
    expect(md("==hl==")).toBe("*hl*");
    expect(md("***bi***")).toBe("*_bi_*");
  });

  it("pads markers glued to Japanese so Slack formats them", () => {
    expect(md("これは**太字**です")).toBe("これは *太字* です");
    expect(md("**太字**です")).toBe("*太字* です");
    expect(md("これは~~取消~~。")).toBe("これは ~取消~ 。");
  });

  it("does not pad next to ASCII punctuation or when disabled", () => {
    expect(md("(**bold**).")).toBe("(*bold*).");
    expect(md("これは**太字**です", { spaceAroundMarkers: false })).toBe("これは*太字*です");
  });

  it("leaves non-emphasis asterisks and underscores alone", () => {
    expect(md("snake_case_name")).toBe("snake_case_name");
    expect(md("2 * 3 * 4")).toBe("2 * 3 * 4");
  });

  it("does not touch inline code", () => {
    expect(md("`**x**` と **y**")).toBe("`**x**` と *y*");
  });
});

describe("markdownToMrkdwn: links", () => {
  it("converts markdown links and images", () => {
    expect(md("[Google](https://google.com)")).toBe("<https://google.com|Google>");
    expect(md("[https://a.jp](https://a.jp)")).toBe("<https://a.jp>");
    expect(md('[t](https://a.jp "title")')).toBe("<https://a.jp|t>");
    expect(md("![図](https://x.jp/a.png)")).toBe("<https://x.jp/a.png|図>");
  });

  it("flattens wikilinks and drops embeds", () => {
    expect(md("[[note|別名]] と [[note2]] と [[n#h]]")).toBe("別名 と note2 と n > h");
    expect(md("see ![[a.png]]")).toBe("see");
    expect(md("a\n![[a.png]]\nb")).toBe("a\nb");
  });
});

describe("markdownToMrkdwn: blocks", () => {
  it("turns headings into bold lines", () => {
    expect(md("# 見出し\n本文")).toBe("*見出し*\n本文");
    expect(md("## **強調** 見出し")).toBe("*強調 見出し*");
  });

  it("converts nested bullets using the indentation structure", () => {
    expect(md("- a\n  - b\n    - c\n- d")).toBe("• a\n    ◦ b\n        ▪ c\n• d");
    expect(md("- a\n\t- b")).toBe("• a\n    ◦ b");
    expect(md("* a\n    + b")).toBe("• a\n    ◦ b");
  });

  it("converts tasks and keeps ordered lists", () => {
    expect(md("- [ ] todo\n- [x] done")).toBe("☐ todo\n☑ done");
    expect(md("1. one\n2. **two**")).toBe("1. one\n2. *two*");
  });

  it("flattens nested quotes and converts callouts", () => {
    expect(md("> > q **b**")).toBe("> q *b*");
    expect(md("> [!note] タイトル\n> 本文")).toBe("> *タイトル*\n> 本文");
    expect(md("> [!warning]-\n> x")).toBe("> *Warning*\n> x");
  });

  it("keeps code fences without the language and passes ```slack through as-is", () => {
    expect(md("```js\nconst a = **1**;\n```")).toBe("```\nconst a = **1**;\n```");
    expect(md("```slack\n*already mrkdwn*\n```")).toBe("*already mrkdwn*");
  });

  it("wraps tables in a code block", () => {
    expect(md("前\n| a | b |\n|---|---|\n| 1 | 2 |\n後")).toBe("前\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n後");
  });

  it("strips frontmatter, comments and block ids", () => {
    expect(md("---\ntags: [x]\n---\n本文")).toBe("本文");
    expect(md("a %%secret%% b")).toBe("a b");
    expect(md("a\n%%\nmulti\n%%\nb")).toBe("a\nb");
    expect(md("段落 ^abc123")).toBe("段落");
  });

  it("replaces horizontal rules and collapses extra blank lines", () => {
    expect(md("a\n\n---\n\n\n\nb")).toBe("a\n\n──────────\n\nb");
  });
});
