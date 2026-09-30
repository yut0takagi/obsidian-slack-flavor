/**
 * Quill Delta for Slack's composer (clipboard type "slack/texty"). Slack's message box is a
 * Quill editor and reads this before text/html, so lists, quotes and code blocks paste as
 * real Slack formatting whatever the "format messages with markup" preference is.
 * Attribute names follow what Slack itself puts on the clipboard (see slackfmt).
 */

import { HR_LINE } from "./mdToMrkdwn";
import type { Run, SlackLine } from "./slackDoc";

export interface DeltaOp {
  insert: string;
  attributes?: Record<string, string | number | boolean>;
}

const NBSP = " ";

export function slackDocToDelta(doc: SlackLine[]): { ops: DeltaOp[] } {
  const ops: DeltaOp[] = [];
  emitLines(doc, ops);
  if (!ops.length) ops.push({ insert: "\n" });
  return { ops: compact(ops) };
}

function emitLines(doc: SlackLine[], ops: DeltaOp[]): void {
  for (const line of doc) {
    switch (line.type) {
      case "text":
      case "heading":
        emitRuns(line.runs, ops);
        newline(ops);
        break;
      case "bullet":
      case "ordered":
        emitRuns(line.runs, ops);
        newline(ops, { list: line.type, ...(line.level ? { indent: line.level } : {}) });
        break;
      case "task":
        // Slack has no checklists: keep the box as text and the nesting as spaces.
        ops.push({ insert: `${NBSP.repeat(line.level * 4)}${line.done ? "☑" : "☐"} ` });
        emitRuns(line.runs, ops);
        newline(ops);
        break;
      case "quote":
        emitRuns(line.runs, ops);
        newline(ops, { blockquote: true });
        break;
      case "code":
        for (const l of line.lines) {
          if (l) ops.push({ insert: l });
          newline(ops, { "code-block": true });
        }
        break;
      case "hr":
        ops.push({ insert: HR_LINE });
        newline(ops);
        break;
      case "mrkdwn":
        emitLines(line.lines, ops);
        break;
    }
  }
}

function emitRuns(runs: Run[], ops: DeltaOp[]): void {
  for (const run of runs) {
    const attributes: Record<string, string | boolean> = {};
    if (run.bold) attributes.bold = true;
    if (run.italic) attributes.italic = true;
    if (run.strike) attributes.strike = true;
    if (run.code) attributes.code = true;
    if (run.link) attributes.link = run.link;
    ops.push(Object.keys(attributes).length ? { insert: run.text, attributes } : { insert: run.text });
  }
}

function newline(ops: DeltaOp[], attributes?: DeltaOp["attributes"]): void {
  ops.push(attributes ? { insert: "\n", attributes } : { insert: "\n" });
}

/** Merges neighbouring inserts with identical attributes, as Quill itself would. */
function compact(ops: DeltaOp[]): DeltaOp[] {
  const out: DeltaOp[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last && sameAttributes(last.attributes, op.attributes)) last.insert += op.insert;
    else out.push({ ...op });
  }
  return out;
}

function sameAttributes(a: DeltaOp["attributes"], b: DeltaOp["attributes"]): boolean {
  const ka = Object.keys(a ?? {});
  const kb = Object.keys(b ?? {});
  return ka.length === kb.length && ka.every((k) => a?.[k] === b?.[k]);
}
