import { describe, expect, it } from "vitest";
import { resolveEmoji } from "../src/emoji/resolver";
import { parseMrkdwn } from "../src/mrkdwn/parse";
import { isEmojiOnly, renderBlocks, type RenderContext } from "../src/mrkdwn/render";

const custom = { parrot: "https://emoji.slack-edge.com/T1/parrot/a.gif" };
const ctx: RenderContext = { resolveEmoji: (name, tone) => resolveEmoji(name, custom, tone) };

function html(src: string): string {
  const el = document.createElement("div");
  renderBlocks(parseMrkdwn(src), el, ctx);
  return el.innerHTML;
}

describe("renderBlocks", () => {
  it("renders emphasis and code", () => {
    expect(html("*b* _i_ ~s~ `c`")).toBe(
      '<div class="sf-p"><b>b</b> <i>i</i> <s>s</s> <code class="sf-code">c</code></div>',
    );
  });

  it("renders quotes, pre blocks and line breaks", () => {
    expect(html("> q\na\nb")).toBe(
      '<blockquote class="sf-quote"><div class="sf-p">q</div></blockquote><div class="sf-p">a<br>b</div>',
    );
    expect(html("```x < y```")).toBe('<pre class="sf-pre"><code>x &lt; y</code></pre>');
  });

  it("renders links that open externally", () => {
    expect(html("<https://ex.com|Ex>")).toBe(
      '<div class="sf-p"><a class="sf-link external-link" href="https://ex.com" target="_blank" rel="noopener noreferrer">Ex</a></div>',
    );
  });

  it("refuses unsafe link schemes", () => {
    expect(html("<javascript:alert(1)|click>")).toBe('<div class="sf-p">click</div>');
  });

  it("renders mentions with Slack's prefixes", () => {
    expect(html("<@U1|田中> <#C1|general> <!here> <!subteam^S1|@dev>")).toBe(
      '<div class="sf-p"><span class="sf-mention sf-mention-user">@田中</span> ' +
        '<span class="sf-mention sf-mention-channel">#general</span> ' +
        '<span class="sf-mention sf-mention-special">@here</span> ' +
        '<span class="sf-mention sf-mention-usergroup">@dev</span></div>',
    );
  });

  it("renders custom emoji as images, standard as text, unknown as the raw code", () => {
    expect(html(":parrot: :tada: :nope:")).toBe(
      '<div class="sf-p"><img class="sf-emoji" src="https://emoji.slack-edge.com/T1/parrot/a.gif" alt=":parrot:" title=":parrot:" draggable="false"> ' +
        '<span class="sf-emoji sf-emoji-unicode" title=":tada:">🎉</span> :nope:</div>',
    );
  });

  it("escapes text instead of interpreting it as HTML", () => {
    expect(html("&lt;img src=x onerror=alert(1)&gt;")).toBe('<div class="sf-p">&lt;img src=x onerror=alert(1)&gt;</div>');
  });
});

describe("isEmojiOnly", () => {
  const only = (src: string) => isEmojiOnly(parseMrkdwn(src), ctx);

  it("is true for messages made only of resolvable emoji and spaces", () => {
    expect(only(":parrot: :tada:")).toBe(true);
  });

  it("is false when there is text, an unknown emoji, or nothing", () => {
    expect(only(":tada: ok")).toBe(false);
    expect(only(":nope:")).toBe(false);
    expect(only("")).toBe(false);
  });
});
