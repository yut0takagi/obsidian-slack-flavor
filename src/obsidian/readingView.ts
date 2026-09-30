import { findEmoji } from "../emoji/noteEmoji";
import { createEmojiEl } from "../mrkdwn/render";
import type { EmojiResolver } from "../emoji/resolver";

const SKIP = "code, pre, .sf-block, .frontmatter, .metadata-container, .sf-emoji";

/** Replaces :emoji: in rendered note text (reading view). Code, ```slack blocks and properties are left alone. */
export function renderNoteEmoji(root: HTMLElement, resolve: EmojiResolver): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeValue?.includes(":") && !node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const targets: Text[] = [];
  while (walker.nextNode()) targets.push(walker.currentNode as Text);

  for (const node of targets) {
    const text = node.nodeValue ?? "";
    const matches = findEmoji(text, resolve);
    if (!matches.length) continue;
    const frag = doc.createDocumentFragment();
    let at = 0;
    for (const m of matches) {
      if (m.from > at) frag.appendChild(doc.createTextNode(text.slice(at, m.from)));
      frag.appendChild(createEmojiEl(doc, m.emoji));
      at = m.to;
    }
    if (at < text.length) frag.appendChild(doc.createTextNode(text.slice(at)));
    node.replaceWith(frag);
  }
}
