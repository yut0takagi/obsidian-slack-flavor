import { type Editor, type EditorPosition, EditorSuggest, type EditorSuggestContext, type EditorSuggestTriggerInfo, type TFile } from "obsidian";
import { searchEmoji, type ResolvedEmoji } from "../emoji/resolver";
import { createEmojiEl } from "../mrkdwn/render";
import type SlackFlavorPlugin from "../../main";

// ":" + at least two name characters, not right after a letter/digit (so "10:30" does not trigger).
const TRIGGER = /(?:^|[^A-Za-z0-9:])(:([^\s:`]{2,}))$/;
const MAX_SUGGESTIONS = 30;

/** Slack-style emoji picker: type ":pa" to get workspace and standard emoji. */
export class EmojiSuggest extends EditorSuggest<ResolvedEmoji> {
  constructor(private readonly plugin: SlackFlavorPlugin) {
    super(plugin.app);
    this.limit = MAX_SUGGESTIONS;
  }

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    const m = TRIGGER.exec(editor.getLine(cursor.line).slice(0, cursor.ch));
    if (!m) return null;
    return { start: { line: cursor.line, ch: cursor.ch - m[1].length }, end: cursor, query: m[2] };
  }

  getSuggestions(context: EditorSuggestContext): ResolvedEmoji[] {
    const workspace = this.plugin.workspaceForPath(context.file?.path ?? "");
    return searchEmoji(context.query, this.plugin.emojiFor(workspace), MAX_SUGGESTIONS);
  }

  renderSuggestion(emoji: ResolvedEmoji, el: HTMLElement): void {
    el.addClass("sf-suggest-item");
    el.appendChild(createEmojiEl(el.ownerDocument, emoji));
    el.createSpan({ cls: "sf-suggest-name", text: `:${emoji.name}:` });
  }

  selectSuggestion(emoji: ResolvedEmoji): void {
    if (!this.context) return;
    this.context.editor.replaceRange(`:${emoji.name}: `, this.context.start, this.context.end);
  }
}
