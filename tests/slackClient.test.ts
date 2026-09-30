import { describe, expect, it, vi } from "vitest";
import { parsePermalink } from "../src/slack/permalink";
import { SlackApiError, SlackClient, type HttpRequest, type HttpResponse } from "../src/slack/client";

describe("parsePermalink", () => {
  it("parses a message link", () => {
    expect(parsePermalink("https://myteam.slack.com/archives/C0123ABCDEF/p1727671234567890")).toEqual({
      domain: "myteam.slack.com",
      channel: "C0123ABCDEF",
      ts: "1727671234.567890",
    });
  });

  it("reads thread_ts from a reply link", () => {
    expect(
      parsePermalink("https://myteam.slack.com/archives/C1/p1727671300000100?thread_ts=1727671234.567890&cid=C1"),
    ).toEqual({ domain: "myteam.slack.com", channel: "C1", ts: "1727671300.000100", threadTs: "1727671234.567890" });
  });

  it("parses web client thread links and enterprise domains", () => {
    expect(parsePermalink("https://app.slack.com/client/T1/C2/thread/C2-1727671234.567890")).toEqual({
      domain: "app.slack.com",
      channel: "C2",
      ts: "1727671234.567890",
      threadTs: "1727671234.567890",
    });
    expect(parsePermalink("https://org.enterprise.slack.com/archives/G9/p1000000000000001")?.channel).toBe("G9");
  });

  it("rejects other urls", () => {
    expect(parsePermalink("https://example.com/archives/C1/p123")).toBeNull();
    expect(parsePermalink("not a url")).toBeNull();
    expect(parsePermalink("https://x.slack.com/archives/C1")).toBeNull();
  });
});

function fakeHttp(responses: HttpResponse[]) {
  const calls: HttpRequest[] = [];
  const http = vi.fn(async (req: HttpRequest) => {
    calls.push(req);
    const res = responses.shift();
    if (!res) throw new Error("no more responses");
    return res;
  });
  return { http, calls };
}
const ok = (json: object): HttpResponse => ({ status: 200, headers: {}, json: { ok: true, ...json } });

describe("SlackClient", () => {
  it("posts form-encoded params with a bearer token", async () => {
    const { http, calls } = fakeHttp([ok({ team: "CA", team_id: "T1", url: "https://ca.slack.com/", user_id: "U1" })]);
    const client = new SlackClient("xoxp-test", http);
    await expect(client.authTest()).resolves.toMatchObject({ team: "CA", url: "https://ca.slack.com/" });
    expect(calls[0]).toEqual({
      url: "https://slack.com/api/auth.test",
      method: "POST",
      headers: { Authorization: "Bearer xoxp-test", "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "",
    });
  });

  it("returns the emoji map", async () => {
    const { http } = fakeHttp([ok({ emoji: { parrot: "https://e/p.gif", p: "alias:parrot" } })]);
    await expect(new SlackClient("t", http).emojiList()).resolves.toEqual({ parrot: "https://e/p.gif", p: "alias:parrot" });
  });

  it("throws SlackApiError with the error code and needed scope", async () => {
    const { http } = fakeHttp([{ status: 200, headers: {}, json: { ok: false, error: "missing_scope", needed: "emoji:read" } }]);
    const err = await new SlackClient("t", http).emojiList().catch((e) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err).toMatchObject({ code: "missing_scope", needed: "emoji:read", method: "emoji.list" });
  });

  it("waits Retry-After on 429 and retries up to three times", async () => {
    const limited: HttpResponse = { status: 429, headers: { "retry-after": "2" }, json: { ok: false, error: "ratelimited" } };
    const sleep = vi.fn(async () => {});
    const { http } = fakeHttp([limited, limited, ok({ emoji: {} })]);
    await expect(new SlackClient("t", http, sleep).emojiList()).resolves.toEqual({});
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(sleep).toHaveBeenCalledTimes(2);

    const { http: always } = fakeHttp([limited, limited, limited, limited]);
    await expect(new SlackClient("t", always, sleep).emojiList()).rejects.toMatchObject({ code: "ratelimited" });
  });

  it("follows cursors when reading a thread", async () => {
    const { http, calls } = fakeHttp([
      ok({ messages: [{ ts: "1.0", text: "root" }], response_metadata: { next_cursor: "abc" } }),
      ok({ messages: [{ ts: "1.1", text: "reply" }], response_metadata: { next_cursor: "" } }),
    ]);
    const msgs = await new SlackClient("t", http).replies("C1", "1.0");
    expect(msgs.map((m) => m.text)).toEqual(["root", "reply"]);
    expect(calls[0].body).toBe("channel=C1&ts=1.0&limit=200");
    expect(calls[1].body).toBe("channel=C1&ts=1.0&limit=200&cursor=abc");
  });

  it("resolves user names once per id, preferring display name", async () => {
    const { http, calls } = fakeHttp([
      ok({ user: { name: "tanaka", real_name: "田中 花子", profile: { display_name: "田中" } } }),
      ok({ user: { name: "yamada", real_name: "山田 太郎", profile: { display_name: "" } } }),
    ]);
    const client = new SlackClient("t", http);
    expect(await client.userName("U1")).toBe("田中");
    expect(await client.userName("U1")).toBe("田中");
    expect(await client.userName("U2")).toBe("山田 太郎");
    expect(calls).toHaveLength(2);
  });

  it("falls back to the id when a user cannot be read", async () => {
    const { http } = fakeHttp([{ status: 200, headers: {}, json: { ok: false, error: "user_not_found" } }]);
    expect(await new SlackClient("t", http).userName("U404")).toBe("U404");
  });

  it("returns the channel name, or undefined for DMs and errors", async () => {
    const { http } = fakeHttp([
      ok({ channel: { id: "C1", name: "general" } }),
      ok({ channel: { id: "D1", is_im: true } }),
      { status: 200, headers: {}, json: { ok: false, error: "channel_not_found" } },
    ]);
    const client = new SlackClient("t", http);
    expect(await client.channelName("C1")).toBe("general");
    expect(await client.channelName("D1")).toBeUndefined();
    expect(await client.channelName("C404")).toBeUndefined();
  });
});
