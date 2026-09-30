/**
 * Slack mrkdwn text, for pasting into Slack with "Format messages with markup" on
 * or for anything that reads plain text.
 *
 * Slack only formats `*` `_` `~` at word boundaries, so markers glued to
 * Japanese text get a half-width space (spaceAroundMarkers, default on).
 */

import { markdownToSlackDoc, type Run, type SlackLine } from "./slackDoc";

export interface ConvertOptions {
  spaceAroundMarkers?: boolean;
}

// Sentinels stand in for markers until padding is decided.
const BOLD = "\u0001";
const ITALIC = "\u0002";
const STRIKE = "\u0003";
const MARK: Record<string, string> = { [BOLD]: "*", [ITALIC]: "_", [STRIKE]: "~" };
const SENTINEL = /[\u0001\u0002\u0003]/;
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

export const BULLETS = ["•", "◦", "▪"];
export const INDENT = "    ";
export const HR_LINE = "──────────";

export function markdownToMrkdwn(markdown: string, opts: ConvertOptions = {}): string {
  return slackDocToMrkdwn(markdownToSlackDoc(markdown), opts);
}

export function slackDocToMrkdwn(doc: SlackLine[], opts: ConvertOptions = {}): string {
  const pad = opts.spaceAroundMarkers ?? true;
  const text = (runs: Run[]) => runsToMrkdwn(runs, pad);
  const out: string[] = [];
  for (const line of doc) {
    switch (line.type) {
      case "text":
      case "heading":
        out.push(text(line.runs));
        break;
      case "bullet":
        out.push(`${INDENT.repeat(line.level)}${BULLETS[Math.min(line.level, BULLETS.length - 1)]} ${text(line.runs)}`);
        break;
      case "ordered":
        out.push(`${INDENT.repeat(line.level)}${line.label} ${text(line.runs)}`);
        break;
      case "task":
        out.push(`${INDENT.repeat(line.level)}${line.done ? "☑" : "☐"} ${text(line.runs)}`);
        break;
      case "quote":
        out.push(`> ${text(line.runs)}`);
        break;
      case "code":
        out.push("```", ...line.lines, "```");
        break;
      case "hr":
        out.push(HR_LINE);
        break;
      case "mrkdwn":
        out.push(line.text);
        break;
    }
  }
  return out
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function runsToMrkdwn(runs: Run[], pad: boolean): string {
  let t = "";
  const open: string[] = [];
  for (const run of runs) {
    const want = [run.bold && BOLD, run.italic && ITALIC, run.strike && STRIKE].filter((m): m is string => !!m);
    // Close from the innermost marker down to the first one this run no longer wants.
    let keep = 0;
    while (keep < open.length && want.includes(open[keep])) keep++;
    while (open.length > keep) t += open.pop();
    for (const m of want) {
      if (!open.includes(m)) {
        t += m;
        open.push(m);
      }
    }
    if (run.code) t += `\`${run.text}\``;
    else if (run.link) t += run.text === run.link ? `<${run.link}>` : `<${run.link}|${run.text}>`;
    else t += run.text;
  }
  while (open.length) t += open.pop();
  return placeMarkers(t, pad);
}

/** Replaces sentinels with Slack markers, padding the ones that touch word characters. */
function placeMarkers(t: string, pad: boolean): string {
  const open: Record<string, boolean> = {};
  let res = "";
  for (let k = 0; k < t.length; k++) {
    const c = t[k];
    if (!SENTINEL.test(c)) {
      res += c;
      continue;
    }
    open[c] = !open[c];
    if (open[c]) {
      if (pad && needsSpace(res[res.length - 1])) res += " ";
      res += MARK[c];
    } else {
      res += MARK[c];
      if (pad && needsSpace(t[k + 1])) res += " ";
    }
  }
  return res;
}

function needsSpace(ch: string | undefined): boolean {
  return ch !== undefined && !/\s/.test(ch) && !ASCII_PUNCT.test(ch) && !SENTINEL.test(ch);
}
