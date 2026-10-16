/** Where ```slack blocks sit in a note's lines, so a command can rewrite one in place. */

export interface SlackBlockRange {
  /** Line of the opening fence. */
  start: number;
  /** Line of the closing fence. */
  end: number;
  /** The lines between the fences. */
  content: string;
}

// CommonMark fences: up to three spaces of indent, three or more backticks or tildes.
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

/** Closed ```slack (or ~~~slack) blocks; fences inside other code blocks are skipped like Markdown does. */
export function findSlackBlocks(lines: string[]): SlackBlockRange[] {
  const blocks: SlackBlockRange[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]);
    if (!open) continue;
    const marker = open[1];
    let end = i + 1;
    while (end < lines.length && !isClosing(lines[end], marker)) end++;
    if (end >= lines.length) break; // unclosed: it runs to the end of the note
    if (open[2].toLowerCase() === "slack") blocks.push({ start: i, end, content: lines.slice(i + 1, end).join("\n") });
    i = end;
  }
  return blocks;
}

function isClosing(line: string, marker: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return !!m && m[1][0] === marker[0] && m[1].length >= marker.length;
}

/** The block under the cursor line, or the note's only `refreshable` block when the cursor is elsewhere. */
export function pickBlock(
  blocks: SlackBlockRange[],
  line: number,
  refreshable: (block: SlackBlockRange) => boolean,
): SlackBlockRange | undefined {
  const under = blocks.find((b) => line >= b.start && line <= b.end);
  if (under) return under;
  const candidates = blocks.filter(refreshable);
  return candidates.length === 1 ? candidates[0] : undefined;
}
