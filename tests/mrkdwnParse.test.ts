import { describe, expect, it } from "vitest";
import { parseInline, parseMrkdwn } from "../src/mrkdwn/parse";

const text = (t: string) => ({ type: "text", text: t });

describe("parseInline: emphasis", () => {
  it("parses bold, italic and strike at word boundaries", () => {
    expect(parseInline("a *b* c")).toEqual([text("a "), { type: "bold", children: [text("b")] }, text(" c")]);
    expect(parseInline("_i_")).toEqual([{ type: "italic", children: [text("i")] }]);
    expect(parseInline("~s~")).toEqual([{ type: "strike", children: [text("s")] }]);
  });

  it("nests emphasis", () => {
    expect(parseInline("*_bi_*")).toEqual([{ type: "bold", children: [{ type: "italic", children: [text("bi")] }] }]);
  });

  it("treats ASCII punctuation as a boundary", () => {
    expect(parseInline("(*b*).")).toEqual([text("("), { type: "bold", children: [text("b")] }, text(").")]);
  });

  it("does not format when a marker touches a word character", () => {
    expect(parseInline("snake_case_name")).toEqual([text("snake_case_name")]);
    expect(parseInline("a*b*c")).toEqual([text("a*b*c")]);
  });

  it("does not format markers that hug whitespace", () => {
    expect(parseInline("* b*")).toEqual([text("* b*")]);
    expect(parseInline("*b *")).toEqual([text("*b *")]);
    expect(parseInline("**")).toEqual([text("**")]);
  });

  it("strict mode: Japanese next to a marker blocks formatting, like Slack", () => {
    expect(parseInline("これは*太字*です")).toEqual([text("これは*太字*です")]);
    expect(parseInline("これは *太字* です")).toEqual([
      text("これは "),
      { type: "bold", children: [text("太字")] },
      text(" です"),
    ]);
  });

  it("lenient mode: anything but ASCII alphanumerics is a boundary", () => {
    expect(parseInline("これは*太字*です", { strict: false })).toEqual([
      text("これは"),
      { type: "bold", children: [text("太字")] },
      text("です"),
    ]);
    expect(parseInline("snake_case_name", { strict: false })).toEqual([text("snake_case_name")]);
  });
});

describe("parseInline: code, links, mentions, emoji", () => {
  it("keeps code literal and lets it shield markers", () => {
    expect(parseInline("`*x*`")).toEqual([{ type: "code", text: "*x*" }]);
    expect(parseInline("*a `b*` c*")).toEqual([
      { type: "bold", children: [text("a "), { type: "code", text: "b*" }, text(" c")] },
    ]);
  });

  it("parses <url|label>, <url> and bare urls", () => {
    expect(parseInline("<https://ex.com|Ex>")).toEqual([{ type: "link", url: "https://ex.com", label: "Ex" }]);
    expect(parseInline("<https://ex.com>")).toEqual([{ type: "link", url: "https://ex.com" }]);
    expect(parseInline("see https://ex.com/a_b_c です")).toEqual([
      text("see "),
      { type: "link", url: "https://ex.com/a_b_c" },
      text(" です"),
    ]);
    expect(parseInline("<mailto:a@b.jp|mail>")).toEqual([{ type: "link", url: "mailto:a@b.jp", label: "mail" }]);
  });

  it("parses user, channel, special and usergroup mentions", () => {
    expect(parseInline("<@U12AB>")).toEqual([{ type: "mention", kind: "user", id: "U12AB", label: "U12AB" }]);
    expect(parseInline("<@U12AB|田中>")).toEqual([{ type: "mention", kind: "user", id: "U12AB", label: "田中" }]);
    expect(parseInline("<@山田>")).toEqual([{ type: "mention", kind: "user", label: "山田" }]);
    expect(parseInline("<#C1|general>")).toEqual([{ type: "mention", kind: "channel", id: "C1", label: "general" }]);
    expect(parseInline("<!here>")).toEqual([{ type: "mention", kind: "special", label: "here" }]);
    expect(parseInline("<!subteam^S1|@dev>")).toEqual([{ type: "mention", kind: "usergroup", id: "S1", label: "dev" }]);
    expect(parseInline("<!date^1392734382^{date}|Feb 18>")).toEqual([text("Feb 18")]);
  });

  it("leaves unknown angle brackets as text", () => {
    expect(parseInline("a <b c")).toEqual([text("a <b c")]);
    expect(parseInline("<not a link>")).toEqual([text("<not a link>")]);
  });

  it("parses emoji with an optional skin tone", () => {
    expect(parseInline("hi :tada:")).toEqual([text("hi "), { type: "emoji", name: "tada", raw: ":tada:" }]);
    expect(parseInline(":+1::skin-tone-3:")).toEqual([
      { type: "emoji", name: "+1", skinTone: 3, raw: ":+1::skin-tone-3:" },
    ]);
    expect(parseInline("了解:承知:です")).toEqual([text("了解"), { type: "emoji", name: "承知", raw: ":承知:" }, text("です")]);
    expect(parseInline("10:30 と 11:00")).toEqual([text("10:30 と 11:00")]);
  });

  it("decodes Slack's HTML entities", () => {
    expect(parseInline("a &lt;b&gt; &amp; c")).toEqual([text("a <b> & c")]);
    expect(parseInline("`&lt;x&gt;`")).toEqual([{ type: "code", text: "<x>" }]);
  });
});

describe("parseMrkdwn: blocks", () => {
  it("joins lines of a paragraph with line breaks", () => {
    expect(parseMrkdwn("a\nb")).toEqual([{ type: "paragraph", children: [text("a"), { type: "br" }, text("b")] }]);
  });

  it("groups quote lines, including API-escaped &gt;", () => {
    expect(parseMrkdwn("> q1\n&gt; q2\nafter")).toEqual([
      { type: "quote", children: [{ type: "paragraph", children: [text("q1"), { type: "br" }, text("q2")] }] },
      { type: "paragraph", children: [text("after")] },
    ]);
  });

  it("quotes everything after >>>", () => {
    expect(parseMrkdwn("x\n>>> a\nb")).toEqual([
      { type: "paragraph", children: [text("x")] },
      { type: "quote", children: [{ type: "paragraph", children: [text("a"), { type: "br" }, text("b")] }] },
    ]);
  });

  it("parses fenced pre blocks, inline or multi-line", () => {
    expect(parseMrkdwn("before\n```\nconst a = *1*;\n```\nafter")).toEqual([
      { type: "paragraph", children: [text("before")] },
      { type: "pre", text: "const a = *1*;" },
      { type: "paragraph", children: [text("after")] },
    ]);
    expect(parseMrkdwn("```one line```")).toEqual([{ type: "pre", text: "one line" }]);
  });

  it("keeps an unclosed fence as text", () => {
    expect(parseMrkdwn("a ```b")).toEqual([{ type: "paragraph", children: [text("a ```b")] }]);
  });

  it("returns nothing for empty input", () => {
    expect(parseMrkdwn("")).toEqual([]);
  });
});
