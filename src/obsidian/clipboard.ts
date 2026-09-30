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
