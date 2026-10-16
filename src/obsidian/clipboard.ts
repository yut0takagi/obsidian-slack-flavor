/**
 * Writes several clipboard types at once, including custom ones like "slack/texty".
 * The async Clipboard API cannot write custom types that Slack reads, but a copy event's
 * DataTransfer can: Chromium stores them as web custom data, the same way Slack does.
 */
export function writeClipboard(
  data: Record<string, string>,
  win: Window = window,
  exec: (command: string) => boolean = (command) => win.document.execCommand(command),
): boolean {
  let wrote = false;
  const onCopy = (event: Event) => {
    const clipboard = (event as ClipboardEvent).clipboardData;
    if (!clipboard) return;
    for (const [type, value] of Object.entries(data)) clipboard.setData(type, value);
    event.preventDefault();
    // The editor's own copy handler would otherwise replace our data with the selection.
    event.stopImmediatePropagation();
    wrote = true;
  };
  win.addEventListener("copy", onCopy, true);
  try {
    exec("copy");
  } finally {
    win.removeEventListener("copy", onCopy, true);
  }
  return wrote;
}

export type CopyOutcome = { kind: "rich" } | { kind: "html" } | { kind: "plain" } | { kind: "failed"; error: unknown };

export interface ClipboardWriters {
  /** Every type at once through a copy event (Slack's own format included). */
  rich: (data: Record<string, string>) => boolean;
  /** The async Clipboard API with HTML and text; missing where ClipboardItem is not available. */
  html?: (html: string, text: string) => Promise<void>;
  text?: (text: string) => Promise<void>;
}

/**
 * Tries Slack's rich format, then HTML, then the plain mrkdwn alone. Some platforms (mobile WebViews
 * in particular) refuse the first two; plain mrkdwn still pastes as formatted text in Slack when
 * "Format messages with markup" is on, so it is better than copying nothing.
 */
export async function copyWithFallback(data: Record<string, string>, writers: ClipboardWriters): Promise<CopyOutcome> {
  let error: unknown = new Error("Clipboard is not available");
  try {
    if (writers.rich(data)) return { kind: "rich" };
  } catch (err) {
    error = err;
  }
  const text = data["text/plain"] ?? "";
  if (writers.html) {
    try {
      await writers.html(data["text/html"] ?? "", text);
      return { kind: "html" };
    } catch (err) {
      error = err;
    }
  }
  if (writers.text) {
    try {
      await writers.text(text);
      return { kind: "plain" };
    } catch (err) {
      error = err;
    }
  }
  return { kind: "failed", error };
}

/** The writers available in this window; ClipboardItem and navigator.clipboard are optional on some platforms. */
export function browserClipboardWriters(win: Window = window): ClipboardWriters {
  const clipboard = win.navigator.clipboard as Clipboard | undefined;
  const Item = (win as Window & { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  return {
    rich: (data) => writeClipboard(data, win),
    html:
      clipboard && Item
        ? (html, text) =>
            clipboard.write([
              new Item({
                "text/html": new Blob([html], { type: "text/html" }),
                "text/plain": new Blob([text], { type: "text/plain" }),
              }),
            ])
        : undefined,
    text: clipboard ? (text) => clipboard.writeText(text) : undefined,
  };
}
