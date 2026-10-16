import { describe, expect, it } from "vitest";
import { checkRefreshSource, refreshSummary } from "../src/slack/refresh";
import { parsePermalink, type Permalink } from "../src/slack/permalink";
import type { WorkspaceConfig } from "../src/settings";

const workspace: WorkspaceConfig = { id: "ws-a", name: "Acme", secret: "slack-acme", domain: "acme.slack.com" };
const link = (url: string): Permalink => {
  const p = parsePermalink(url);
  if (!p) throw new Error(`bad test link ${url}`);
  return p;
};

describe("checkRefreshSource", () => {
  it("accepts a source on the chosen workspace's domain", () => {
    expect(checkRefreshSource(link("https://acme.slack.com/archives/C1/p1790731800000100"), workspace)).toEqual({ ok: true });
    expect(checkRefreshSource(link("https://ACME.slack.com/archives/C1/p1790731800000100"), workspace)).toEqual({ ok: true });
  });

  it("refuses a source from another workspace", () => {
    expect(checkRefreshSource(link("https://other.slack.com/archives/C1/p1790731800000100"), workspace)).toEqual({
      ok: false,
      reason: "other-workspace",
      host: "other.slack.com",
    });
    expect(checkRefreshSource(link("https://app.slack.com/client/T1/C1/thread/C1-1790731800.000100"), workspace)).toMatchObject({
      ok: false,
      reason: "other-workspace",
    });
  });

  it("refuses when the workspace's domain is not known yet", () => {
    const { domain: _, ...unknown } = workspace;
    expect(checkRefreshSource(link("https://acme.slack.com/archives/C1/p1790731800000100"), unknown)).toEqual({
      ok: false,
      reason: "unknown-domain",
      host: "acme.slack.com",
    });
  });
});

describe("refreshSummary", () => {
  it("describes what will be read from the link and Slack, not from the block's own lines", () => {
    const summary = refreshSummary(workspace, link("https://acme.slack.com/archives/C0SECRET/p1790731800000100"), "private-plans", "Asia/Tokyo");
    expect(summary).toEqual({ workspace: "Acme (acme.slack.com)", channel: "#private-plans (C0SECRET)", time: "2026-09-30 10:30" });
  });

  it("falls back to the channel id and uses the thread root for reply links", () => {
    const reply = link("https://acme.slack.com/archives/C1/p1790731920000200?thread_ts=1790731800.000100");
    expect(refreshSummary(workspace, reply, undefined, "Asia/Tokyo")).toMatchObject({ channel: "C1", time: "2026-09-30 10:30" });
  });
});
