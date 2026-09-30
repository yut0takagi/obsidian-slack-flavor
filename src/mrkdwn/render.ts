import { append } from "../dom";
import type { EmojiResolver, ResolvedEmoji } from "../emoji/resolver";
import type { Block, Inline } from "./parse";

export interface RenderContext {
  resolveEmoji: EmojiResolver;
}

const SAFE_SCHEMES = /^(https?|mailto|tel|slack|obsidian):/i;
const MENTION_PREFIX = { user: "@", channel: "#", special: "@", usergroup: "@" } as const;
const EMPHASIS_TAG = { bold: "b", italic: "i", strike: "s" } as const;

// DOM is built with createElement/textContent only: message text comes from Slack or other people.
export function renderBlocks(blocks: Block[], parent: HTMLElement, ctx: RenderContext): void {
  const doc = parent.ownerDocument;
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph": {
        const p = append(parent, "div", "sf-p");
        renderInline(block.children, p, ctx);
        break;
      }
      case "quote":
        renderBlocks(block.children, append(parent, "blockquote", "sf-quote"), ctx);
        break;
      case "pre":
        append(append(parent, "pre", "sf-pre"), "code").appendChild(doc.createTextNode(block.text));
        break;
    }
  }
}

export function renderInline(nodes: Inline[], parent: HTMLElement, ctx: RenderContext): void {
  const doc = parent.ownerDocument;
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        parent.appendChild(doc.createTextNode(node.text));
        break;
      case "bold":
      case "italic":
      case "strike":
        renderInline(node.children, append(parent, EMPHASIS_TAG[node.type]), ctx);
        break;
      case "code":
        append(parent, "code", "sf-code").textContent = node.text;
        break;
      case "link":
        renderLink(node.url, node.label ?? node.url, parent);
        break;
      case "mention":
        append(parent, "span", `sf-mention sf-mention-${node.kind}`).textContent = MENTION_PREFIX[node.kind] + node.label;
        break;
      case "emoji": {
        const resolved = ctx.resolveEmoji(node.name, node.skinTone);
        parent.appendChild(resolved ? createEmojiEl(doc, resolved) : doc.createTextNode(node.raw));
        break;
      }
      case "br":
        append(parent, "br");
        break;
    }
  }
}

function renderLink(url: string, label: string, parent: HTMLElement): void {
  if (!SAFE_SCHEMES.test(url)) {
    parent.appendChild(parent.ownerDocument.createTextNode(label));
    return;
  }
  const a = append(parent, "a", "sf-link external-link");
  a.setAttribute("href", url);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer");
  a.textContent = label;
}

export function createEmojiEl(doc: Document, emoji: ResolvedEmoji): HTMLElement {
  const title = `:${emoji.name}:`;
  if (emoji.kind === "unicode") {
    const span = doc.createElement("span");
    span.className = "sf-emoji sf-emoji-unicode";
    span.setAttribute("title", title);
    span.textContent = emoji.char;
    return span;
  }
  const img = doc.createElement("img");
  img.className = "sf-emoji";
  img.setAttribute("src", emoji.url);
  img.setAttribute("alt", title);
  img.setAttribute("title", title);
  img.setAttribute("draggable", "false");
  return img;
}

/** Slack enlarges messages that contain nothing but emoji. */
export function isEmojiOnly(blocks: Block[], ctx: RenderContext): boolean {
  if (blocks.length !== 1 || blocks[0].type !== "paragraph") return false;
  let emoji = 0;
  for (const node of blocks[0].children) {
    if (node.type === "text" && !node.text.trim()) continue;
    if (node.type !== "emoji" || !ctx.resolveEmoji(node.name, node.skinTone)) return false;
    emoji++;
  }
  return emoji > 0;
}
