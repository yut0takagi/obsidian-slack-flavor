/**
 * HTML for the clipboard, for apps other than Slack (and as Slack's fallback).
 * Block structure is flattened to lines with <br>, the shape Slack's paste handling
 * copes with best; lists become indented bullet characters.
 */

import { BULLETS, HR_LINE } from "./mdToMrkdwn";
import type { Run, SlackLine } from "./slackDoc";

const NBSP4 = "&nbsp;".repeat(4);

export function slackDocToHtml(doc: SlackLine[]): string {
  let html = "";
  let quote = "";
  const flushQuote = () => {
    if (quote) html += `<blockquote>${quote}</blockquote>`;
    quote = "";
  };

  const emit = (lines: SlackLine[]) => {
    for (const line of lines) {
      if (line.type === "quote") {
        quote += `${runsHtml(line.runs)}<br>`;
        continue;
      }
      flushQuote();
      switch (line.type) {
        case "text":
        case "heading":
          html += `${runsHtml(line.runs)}<br>`;
          break;
        case "bullet":
          html += `${NBSP4.repeat(line.level)}${BULLETS[Math.min(line.level, BULLETS.length - 1)]} ${runsHtml(line.runs)}<br>`;
          break;
        case "ordered":
          html += `${NBSP4.repeat(line.level)}${escapeHtml(line.label)} ${runsHtml(line.runs)}<br>`;
          break;
        case "task":
          html += `${NBSP4.repeat(line.level)}${line.done ? "☑" : "☐"} ${runsHtml(line.runs)}<br>`;
          break;
        case "code":
          html += `<pre>${escapeHtml(line.lines.join("\n"))}</pre>`;
          break;
        case "hr":
          html += `${HR_LINE}<br>`;
          break;
        case "mrkdwn":
          emit(line.lines);
          break;
      }
    }
  };
  emit(doc);
  flushQuote();
  return html;
}

function runsHtml(runs: Run[]): string {
  return runs
    .map((r) => {
      let h = escapeHtml(r.text).replace(/\n/g, "<br>");
      if (r.code) h = `<code>${h}</code>`;
      if (r.strike) h = `<s>${h}</s>`;
      if (r.italic) h = `<i>${h}</i>`;
      if (r.bold) h = `<b>${h}</b>`;
      if (r.link) h = `<a href="${escapeHtml(r.link)}">${h}</a>`;
      return h;
    })
    .join("");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
