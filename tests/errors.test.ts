import { describe, expect, it } from "vitest";
import { createStrings } from "../src/i18n";
import { SlackApiError } from "../src/slack/client";
import { describeError } from "../src/slack/errors";

const s = createStrings("ja");

describe("describeError", () => {
  it("explains Slack error codes", () => {
    expect(describeError(new SlackApiError("emoji.list", "missing_scope", "emoji:read"), s)).toBe(
      "トークンに必要なスコープがありません（emoji:read）。",
    );
    expect(describeError(new SlackApiError("auth.test", "invalid_auth"), s)).toBe(s.errAuth);
    expect(describeError(new SlackApiError("conversations.replies", "not_in_channel"), s)).toBe(s.errChannel);
    expect(describeError(new SlackApiError("conversations.replies", "thread_not_found"), s)).toBe(s.errMessage);
    expect(describeError(new SlackApiError("emoji.list", "ratelimited"), s)).toBe(s.errRateLimited);
    expect(describeError(new SlackApiError("x", "fatal_error"), s)).toBe("Slackのエラー: fatal_error");
  });

  it("falls back to the message of other errors", () => {
    expect(describeError(new Error("net::ERR_INTERNET_DISCONNECTED"), s)).toBe("net::ERR_INTERNET_DISCONNECTED");
    expect(describeError("boom", s)).toBe("boom");
  });
});
