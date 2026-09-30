import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { findEmoji } from "../emoji/noteEmoji";
import type { ResolvedEmoji } from "../emoji/resolver";
import { createEmojiEl } from "../mrkdwn/render";
import type SlackFlavorPlugin from "../../main";

/** Syntax nodes whose text must stay literal (code, math, frontmatter, URLs). */
const LITERAL_NODE = /code|math|frontmatter|url|hmd-internal-link/i;

class EmojiWidget extends WidgetType {
  constructor(private readonly emoji: ResolvedEmoji) {
    super();
  }

  override eq(other: EmojiWidget): boolean {
    const a = this.emoji;
    const b = other.emoji;
    return a.name === b.name && (a.kind === "custom" ? b.kind === "custom" && a.url === b.url : b.kind === "unicode" && a.char === b.char);
  }

  toDOM(view: EditorView): HTMLElement {
    return createEmojiEl(view.dom.ownerDocument, this.emoji);
  }
}

/** Shows :emoji: as images in live preview, except where the cursor is, so the code stays editable. */
export function emojiLivePreview(plugin: SlackFlavorPlugin): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(u: ViewUpdate): void {
        const modeChanged = u.startState.field(editorLivePreviewField, false) !== u.state.field(editorLivePreviewField, false);
        // updateOptions() (called after emoji are fetched) arrives as a reconfiguring transaction.
        if (u.docChanged || u.viewportChanged || u.selectionSet || modeChanged || u.transactions.some((t) => t.reconfigured)) {
          this.decorations = this.build(u.view);
        }
      }

      build(view: EditorView): DecorationSet {
        const { state } = view;
        if (!plugin.settings.renderEmojiInNotes || !state.field(editorLivePreviewField, false)) return Decoration.none;
        const path = state.field(editorInfoField, false)?.file?.path ?? "";
        const resolve = plugin.resolverFor(plugin.workspaceForPath(path));
        const builder = new RangeSetBuilder<Decoration>();
        for (const { from, to } of view.visibleRanges) {
          for (const m of findEmoji(state.sliceDoc(from, to), resolve)) {
            const a = from + m.from;
            const b = from + m.to;
            if (touchesSelection(state, a, b) || isLiteral(state, a)) continue;
            builder.add(a, b, Decoration.replace({ widget: new EmojiWidget(m.emoji) }));
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}

function touchesSelection(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

function isLiteral(state: EditorState, pos: number): boolean {
  for (let node: { name: string; parent: unknown } | null = syntaxTree(state).resolveInner(pos, 1); node; ) {
    if (LITERAL_NODE.test(node.name)) return true;
    node = node.parent as typeof node;
  }
  return false;
}
