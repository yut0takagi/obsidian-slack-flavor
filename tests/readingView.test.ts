import { describe, expect, it } from "vitest";
import { resolveEmoji } from "../src/emoji/resolver";
import { renderNoteEmoji } from "../src/obsidian/readingView";

const resolve = (name: string, tone?: number) => resolveEmoji(name, { parrot: "https://e/p.gif" }, tone);

function run(html: string): string {
  const el = document.createElement("div");
  el.innerHTML = html;
  renderNoteEmoji(el, resolve);
  return el.innerHTML;
}

describe("renderNoteEmoji", () => {
  it("replaces emoji codes in paragraphs and nested inline elements", () => {
    expect(run("<p>hi :parrot: <strong>ok :tada:</strong></p>")).toBe(
      '<p>hi <img class="sf-emoji" src="https://e/p.gif" alt=":parrot:" title=":parrot:" draggable="false"> ' +
        '<strong>ok <span class="sf-emoji sf-emoji-unicode" title=":tada:">🎉</span></strong></p>',
    );
  });

  it("leaves code, rendered slack blocks and unknown codes alone", () => {
    const html = '<p><code>:tada:</code></p><pre><code>:tada:</code></pre><div class="sf-block"><p>:tada:</p></div><p>:nope: 10:30</p>';
    expect(run(html)).toBe(html);
  });
});
