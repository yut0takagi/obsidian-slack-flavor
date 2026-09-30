import { describe, expect, it, vi } from "vitest";
import { resolveEmoji } from "../src/emoji/resolver";
import { parseSlackBlock } from "../src/block/parse";
import { renderSlackBlock, type BlockRenderContext } from "../src/block/render";

const custom = { parrot: "https://emoji.slack-edge.com/T1/parrot/a.gif" };

function render(src: string, extra: Partial<BlockRenderContext> = {}) {
  const el = document.createElement("div");
  const ctx: BlockRenderContext = {
    resolveEmoji: (name, tone) => resolveEmoji(name, custom, tone),
    strings: { replies: (n) => `${n}件の返信`, copy: "コピー" },
    ...extra,
  };
  renderSlackBlock(parseSlackBlock(src), el, ctx);
  return el;
}

const texts = (el: Element, sel: string) => [...el.querySelectorAll(sel)].map((e) => e.textContent);

describe("renderSlackBlock", () => {
  it("renders the channel header and workspace label", () => {
    const el = render("channel: #general\n\n@a 9:00\nhi", { workspaceLabel: "Acme" });
    expect(texts(el, ".sf-channel")).toEqual(["#general"]);
    expect(texts(el, ".sf-workspace")).toEqual(["Acme"]);
  });

  it("omits the header when there is nothing to show", () => {
    expect(render("@a\nhi").querySelector(".sf-header")).toBeNull();
  });

  it("renders author, time, avatar initial and mrkdwn body", () => {
    const el = render("@田中 10:30\n*定例* です");
    expect(texts(el, ".sf-author")).toEqual(["田中"]);
    expect(texts(el, ".sf-time")).toEqual(["10:30"]);
    expect(texts(el, ".sf-avatar")).toEqual(["田"]);
    expect(el.querySelector(".sf-avatar")?.className).toMatch(/sf-avatar-c[0-7]/);
    expect(el.querySelector(".sf-body b")?.textContent).toBe("定例");
  });

  it("gives the same author the same avatar color", () => {
    const el = render("@a 9:00\nx\n\n@b 9:01\ny\n\n@a 9:30\nz");
    const classes = [...el.querySelectorAll(".sf-avatar")].map((e) => e.className);
    expect(classes[0]).toBe(classes[2]);
  });

  it("collapses consecutive messages from the same author within five minutes", () => {
    const el = render("@a 9:00\nx\n\n@a 9:04\ny\n\n@a 9:30\nz");
    const msgs = el.querySelectorAll(".sf-messages > .sf-message");
    expect([...msgs].map((m) => m.classList.contains("sf-continued"))).toEqual([false, true, false]);
    expect(msgs[1].querySelector(".sf-author")).toBeNull();
  });

  it("adds a divider when the date changes", () => {
    const el = render("@a 2026-09-29 9:00\nx\n\n@a 2026-09-30 9:00\ny");
    expect(texts(el, ".sf-date-divider")).toEqual(["2026-09-29", "2026-09-30"]);
  });

  it("renders reactions with counts", () => {
    const el = render("@a\nhi\n+:parrot: 3 :tada:");
    const reactions = el.querySelectorAll(".sf-reaction");
    expect(reactions).toHaveLength(2);
    expect(reactions[0].querySelector("img")?.getAttribute("src")).toBe(custom.parrot);
    expect(texts(el, ".sf-reaction-count")).toEqual(["3", "1"]);
  });

  it("renders thread replies under their parent with a summary", () => {
    const el = render("@a 9:00\nq\n\n↳ @b 9:01\nr1\n\n↳ @c 9:02\nr2");
    expect(texts(el, ".sf-thread-summary")).toEqual(["2件の返信"]);
    expect(texts(el, ".sf-thread .sf-author")).toEqual(["b", "c"]);
  });

  it("enlarges emoji-only messages", () => {
    const el = render("@a\n:parrot: :tada:\n\n@b\n:tada: ok");
    const bodies = el.querySelectorAll(".sf-body");
    expect(bodies[0].classList.contains("sf-jumbo")).toBe(true);
    expect(bodies[1].classList.contains("sf-jumbo")).toBe(false);
  });

  it("renders a header-less block as plain mrkdwn with a copy button", () => {
    const onCopy = vi.fn();
    const el = render("*太字* :tada:", { onCopy });
    expect(el.querySelector(".sf-messages")).toBeNull();
    expect(el.querySelector(".sf-text b")?.textContent).toBe("太字");
    (el.querySelector(".sf-copy") as HTMLElement).click();
    expect(onCopy).toHaveBeenCalledWith("*太字* :tada:");
  });

  it("copies a single message body", () => {
    const onCopy = vi.fn();
    const el = render("@a\nhello *world*", { onCopy });
    (el.querySelector(".sf-message .sf-copy") as HTMLElement).click();
    expect(onCopy).toHaveBeenCalledWith("hello *world*");
  });

  it("passes parse options through (lenient Japanese emphasis)", () => {
    const el = render("これは*太字*です", { parseOptions: { strict: false } });
    expect(el.querySelector(".sf-text b")?.textContent).toBe("太字");
  });
});
