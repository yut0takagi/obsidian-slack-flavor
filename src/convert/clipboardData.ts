import { slackDocToMrkdwn, type ConvertOptions } from "./mdToMrkdwn";
import type { SlackLine } from "./slackDoc";
import { slackDocToDelta } from "./toDelta";
import { slackDocToHtml } from "./toHtml";

/** Everything "Copy as Slack text" puts on the clipboard; Slack prefers slack/texty. */
export function slackClipboardData(doc: SlackLine[], opts: ConvertOptions): Record<string, string> {
  return {
    "text/plain": slackDocToMrkdwn(doc, opts),
    "text/html": slackDocToHtml(doc),
    "slack/texty": JSON.stringify(slackDocToDelta(doc)),
  };
}
