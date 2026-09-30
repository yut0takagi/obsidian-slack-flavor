/**
 * An intermediate form of a note for Slack: typed lines of styled text runs.
 * One parse feeds every output format (mrkdwn text, Slack's rich clipboard, HTML).
 */

import { parseMrkdwn, type Inline } from "../mrkdwn/parse";

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
}

export type SlackLine =
  | { type: "text"; runs: Run[] }
  | { type: "heading"; runs: Run[] }
  | { type: "bullet"; level: number; runs: Run[] }
  | { type: "ordered"; level: number; label: string; runs: Run[] }
  | { type: "task"; level: number; done: boolean; runs: Run[] }
  | { type: "quote"; runs: Run[] }
  | { type: "code"; lines: string[] }
  | { type: "hr" }
  /** A ```slack block: already mrkdwn, kept verbatim for text and parsed for rich formats. */
  | { type: "mrkdwn"; text: string; lines: SlackLine[] };

type Style = Omit<Run, "text">;

// Sentinels mark emphasis while regexes run; STASH wraps spans the regexes must not touch.
const BOLD = "\u0001";
const ITALIC = "\u0002";
const STRIKE = "\u0003";
const STASH = "\u0000";
const STYLE_OF: Record<string, "bold" | "italic" | "strike"> = { [BOLD]: "bold", [ITALIC]: "italic", [STRIKE]: "strike" };

const FRONTMATTER = /^---\n[\s\S]*?\n---(?:\n|$)/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w-]*)/;
const TABLE_ROW = /^\s*\|/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const CALLOUT = /^\s*>\s*\[!(\w+)\][+-]?\s*(.*)$/;
const QUOTE = /^(?:\s*>)+\s?/;
const BULLET = /^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/;
const ORDERED = /^(\s*)(\d+[.)])\s+(.*)$/;
const BLOCK_ID = /\s+\^[A-Za-z0-9-]+$/;

export function markdownToSlackDoc(markdown: string): SlackLine[] {
  const lines = markdown.replace(/\r\n?/g, "\n").replace(FRONTMATTER, "").split("\n");
  const out: SlackLine[] = [];
  const listIndents: number[] = [];
  let inComment = false;

  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE.exec(lines[i]);
    if (fence && !inComment) {
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(fence[1])) body.push(lines[j++]);
      const text = body.join("\n");
      out.push(fence[2].toLowerCase() === "slack" ? { type: "mrkdwn", text, lines: mrkdwnToSlackDoc(text) } : { type: "code", lines: body });
      i = j;
      listIndents.length = 0;
      continue;
    }

    let line = lines[i];
    const hadContent = line.trim() !== "";
    [line, inComment] = stripComments(line, inComment);
    line = line.replace(BLOCK_ID, "");

    if (TABLE_ROW.test(line) && TABLE_SEPARATOR.test(lines[i + 1] ?? "")) {
      const rows: string[] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(lines[i++]);
      out.push({ type: "code", lines: rows });
      i--;
      continue;
    }

    const parsed = classify(line, listIndents);
    if (hadContent && isBlank(parsed)) continue; // the line held only a comment or an embed
    out.push(parsed);
  }
  return tidyBlankLines(out);
}

/** Slack mrkdwn (a ```slack block) as lines, formatted exactly as Slack would. */
export function mrkdwnToSlackDoc(text: string): SlackLine[] {
  const out: SlackLine[] = [];
  for (const block of parseMrkdwn(text)) {
    if (block.type === "pre") {
      out.push({ type: "code", lines: block.text.split("\n") });
    } else if (block.type === "quote") {
      for (const child of block.children) {
        if (child.type === "paragraph") for (const l of splitLines(child.children)) out.push({ type: "quote", runs: inlineToRuns(l) });
      }
    } else {
      for (const l of splitLines(block.children)) out.push({ type: "text", runs: inlineToRuns(l) });
    }
  }
  return out;
}

function stripComments(line: string, inComment: boolean): [string, boolean] {
  if (inComment) {
    const end = line.indexOf("%%");
    if (end < 0) return ["", true];
    line = line.slice(end + 2);
  }
  line = line.replace(/\s*%%.*?%%/g, "");
  const open = line.indexOf("%%");
  return open < 0 ? [line, false] : [line.slice(0, open), true];
}

function classify(line: string, listIndents: number[]): SlackLine {
  let m: RegExpExecArray | null;

  if ((m = BULLET.exec(line)) && !HR.test(line)) {
    const level = listLevel(m[1], listIndents);
    const runs = inlineRuns(m[3]);
    return m[2] === undefined ? { type: "bullet", level, runs } : { type: "task", level, done: m[2] !== " ", runs };
  }
  if ((m = ORDERED.exec(line))) {
    return { type: "ordered", level: listLevel(m[1], listIndents), label: m[2], runs: inlineRuns(m[3]) };
  }
  listIndents.length = 0;

  if ((m = HEADING.exec(line))) return { type: "heading", runs: emphasize(inlineRuns(m[1].replace(/\*\*|__/g, ""))) };
  if (HR.test(line)) return { type: "hr" };
  if ((m = CALLOUT.exec(line))) {
    const title = m[2] || m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return { type: "quote", runs: emphasize(inlineRuns(title)) };
  }
  if ((m = QUOTE.exec(line))) return { type: "quote", runs: inlineRuns(line.slice(m[0].length)) };
  return { type: "text", runs: inlineRuns(line) };
}

/** Nesting depth from the indentation stack, so 2-space, 4-space and tab lists all work. */
function listLevel(indent: string, stack: number[]): number {
  const width = indent.replace(/\t/g, "    ").length;
  while (stack.length && stack[stack.length - 1] > width) stack.pop();
  if (!stack.length || stack[stack.length - 1] < width) stack.push(width);
  return stack.length - 1;
}

function isBlank(line: SlackLine): boolean {
  return line.type === "text" && line.runs.every((r) => !r.text.trim());
}

/** At most one blank line in a row, none at the start or end. */
function tidyBlankLines(lines: SlackLine[]): SlackLine[] {
  const out: SlackLine[] = [];
  for (const line of lines) {
    const blank = isBlank(line);
    if (blank && (!out.length || isBlank(out[out.length - 1]))) continue;
    out.push(blank ? { type: "text", runs: [] } : line);
  }
  while (out.length && isBlank(out[out.length - 1])) out.pop();
  return out;
}

// --- inline ------------------------------------------------------------------

type Stashed = { text: string; style: Style };

function inlineRuns(text: string): Run[] {
  const stash: Stashed[] = [];
  const keep = (item: Stashed) => `${STASH}${stash.push(item) - 1}${STASH}`;
  const link = (url: string, label: string) => {
    const clean = label.replace(/\*\*|__|~~|==/g, "").trim();
    return keep({ text: clean || url, style: { link: url } });
  };

  let t = text
    .replace(/`([^`]+)`/g, (_, code: string) => keep({ text: code, style: { code: true } }))
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (_, alt: string, url: string) => link(url, alt))
    .replace(/\[([^\]]+)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (_, label: string, url: string) => link(url, label))
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) => alias ?? target.replace(/#\^?/, " > "))
    .replace(/<(https?:\/\/[^\s<>]+)>/g, (_, url: string) => keep({ text: url, style: { link: url } }))
    // Bare URLs stay plain text (Slack links them itself) but must not be read as emphasis.
    .replace(/https?:\/\/[^\s<>]+/g, (url) => keep({ text: url, style: {} }))
    .replace(/<br\s*\/?>/gi, "\n");

  t = t
    .replace(/(\*\*\*|___)(?!\s)(.+?)(?<!\s)\1/g, `${BOLD}${ITALIC}$2${ITALIC}${BOLD}`)
    .replace(/(\*\*|__|==)(?!\s)(.+?)(?<!\s)\1/g, `${BOLD}$2${BOLD}`)
    .replace(/~~(?!\s)(.+?)(?<!\s)~~/g, `${STRIKE}$1${STRIKE}`)
    .replace(/(?<![A-Za-z0-9*\\])\*(?![\s*])(.+?)(?<![\s\\])\*(?![A-Za-z0-9*])/g, `${ITALIC}$1${ITALIC}`)
    .replace(/(?<![\p{L}\p{N}_\\])_(?![\s_])(.+?)(?<![\s\\])_(?![\p{L}\p{N}_])/gu, `${ITALIC}$1${ITALIC}`);

  const runs: Run[] = [];
  const style: Style = {};
  let buf = "";
  const flush = () => {
    pushRun(runs, buf, style);
    buf = "";
  };
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    const key = STYLE_OF[c];
    if (key) {
      flush();
      if (style[key]) delete style[key];
      else style[key] = true;
    } else if (c === STASH) {
      const end = t.indexOf(STASH, i + 1);
      const item = stash[Number(t.slice(i + 1, end))];
      flush();
      pushRun(runs, item.text, { ...style, ...item.style });
      i = end;
    } else {
      buf += c;
    }
  }
  flush();
  return runs;
}

function inlineToRuns(nodes: Inline[], style: Style = {}, runs: Run[] = []): Run[] {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        pushRun(runs, node.text, style);
        break;
      case "bold":
      case "italic":
      case "strike":
        inlineToRuns(node.children, { ...style, [node.type]: true }, runs);
        break;
      case "code":
        pushRun(runs, node.text, { ...style, code: true });
        break;
      case "link":
        pushRun(runs, node.label ?? node.url, { ...style, link: node.url });
        break;
      case "mention":
        pushRun(runs, (node.kind === "channel" ? "#" : "@") + node.label, style);
        break;
      case "emoji":
        pushRun(runs, node.raw, style);
        break;
      case "br":
        pushRun(runs, "\n", style);
        break;
    }
  }
  return runs;
}

function splitLines(nodes: Inline[]): Inline[][] {
  const lines: Inline[][] = [[]];
  for (const n of nodes) {
    if (n.type === "br") lines.push([]);
    else lines[lines.length - 1].push(n);
  }
  return lines;
}

function emphasize(runs: Run[]): Run[] {
  return runs.map((r) => ({ ...r, bold: true }));
}

/** Appends text, merging it into the previous run when the style is identical. */
function pushRun(runs: Run[], text: string, style: Style): void {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && sameStyle(last, style)) {
    last.text += text;
    return;
  }
  const run: Run = { text };
  for (const key of ["bold", "italic", "strike", "code"] as const) if (style[key]) run[key] = true;
  if (style.link) run.link = style.link;
  runs.push(run);
}

function sameStyle(a: Style, b: Style): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.strike === !!b.strike && !!a.code === !!b.code && a.link === b.link;
}
