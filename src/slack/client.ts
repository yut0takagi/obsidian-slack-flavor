/** Minimal Slack Web API client. HTTP is injected: Obsidian's requestUrl in the app, a fake in tests. */

export interface HttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  json: unknown;
}

export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;
export type SleepFn = (ms: number) => Promise<void>;

export interface SlackApiMessage {
  ts: string;
  text?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  bot_profile?: { name?: string };
  subtype?: string;
  thread_ts?: string;
  reactions?: { name: string; count: number }[];
  files?: SlackFile[];
}

/** The parts of a Slack file object the plugin reads. */
export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  permalink?: string;
  mimetype?: string;
  /** Needs the token (files:read) to download. */
  url_private?: string;
  url_private_download?: string;
  size?: number;
  /** "hidden_by_limit" on plans that hide old files; such files have no URLs. */
  mode?: string;
}

export interface AuthInfo {
  team: string;
  team_id: string;
  url: string;
  user_id: string;
}

export interface SlackChannel {
  id: string;
  name: string;
  private: boolean;
}

export interface ScheduledMessage {
  id: string;
  channel: string;
  /** Unix seconds. */
  postAt: number;
  text: string;
}

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly needed?: string,
  ) {
    super(`${method}: ${code}${needed ? ` (needs ${needed})` : ""}`);
    this.name = "SlackApiError";
  }
}

type Params = Record<string, string | number | undefined>;

const API = "https://slack.com/api/";
const MAX_RETRIES = 3;
const PAGE_SIZE = 200;
const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SlackClient {
  private readonly users = new Map<string, Promise<string>>();

  constructor(
    private readonly token: string,
    private readonly http: HttpFn,
    private readonly sleep: SleepFn = defaultSleep,
  ) {}

  async call<T>(method: string, params: Params = {}): Promise<T> {
    const body = Object.entries(params)
      .filter((e): e is [string, string | number] => e[1] !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");

    for (let attempt = 0; ; attempt++) {
      const res = await this.http({
        url: API + method,
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
        body,
      });
      if (res.status === 429) {
        if (attempt >= MAX_RETRIES - 1) throw new SlackApiError(method, "ratelimited");
        await this.sleep(Number(res.headers["retry-after"] ?? 1) * 1000);
        continue;
      }
      const json = (res.json ?? {}) as { ok?: boolean; error?: string; needed?: string };
      if (!json.ok) throw new SlackApiError(method, json.error ?? `http_${res.status}`, json.needed);
      return json as T;
    }
  }

  authTest(): Promise<AuthInfo> {
    return this.call<AuthInfo>("auth.test");
  }

  async emojiList(): Promise<Record<string, string>> {
    return (await this.call<{ emoji: Record<string, string> }>("emoji.list")).emoji;
  }

  /** The thread rooted at `ts` (just the message itself when it has no replies). */
  async replies(channel: string, ts: string): Promise<SlackApiMessage[]> {
    const messages: SlackApiMessage[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.call<{ messages: SlackApiMessage[]; response_metadata?: { next_cursor?: string } }>(
        "conversations.replies",
        { channel, ts, limit: PAGE_SIZE, cursor },
      );
      messages.push(...page.messages);
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return messages;
  }

  /** Display name as Slack shows it; falls back to the id so an import never fails on one user. */
  userName(id: string): Promise<string> {
    let name = this.users.get(id);
    if (!name) {
      name = this.call<{ user: { name?: string; real_name?: string; profile?: { display_name?: string } } }>("users.info", { user: id })
        .then(({ user }) => user.profile?.display_name || user.real_name || user.name || id)
        .catch(() => id);
      this.users.set(id, name);
    }
    return name;
  }

  /** Public and private channels the token's user is in (where they can post). */
  async memberChannels(): Promise<SlackChannel[]> {
    const channels: SlackChannel[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.call<{ channels: { id: string; name: string; is_private?: boolean }[]; response_metadata?: { next_cursor?: string } }>(
        "users.conversations",
        { types: "public_channel,private_channel", exclude_archived: "true", limit: PAGE_SIZE, cursor },
      );
      for (const c of page.channels) channels.push({ id: c.id, name: c.name, private: !!c.is_private });
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return channels;
  }

  /**
   * Posts as the token's user. A network error is not retried (the message may already be posted);
   * only Slack's own 429, which means nothing was done, is.
   */
  async postMessage(channel: string, text: string, threadTs?: string): Promise<{ channel: string; ts: string }> {
    const res = await this.call<{ channel: string; ts: string }>("chat.postMessage", { channel, text, thread_ts: threadTs });
    return { channel: res.channel, ts: res.ts };
  }

  /** `postAt` is Unix seconds. */
  async scheduleMessage(channel: string, text: string, postAt: number, threadTs?: string): Promise<{ id: string; postAt: number }> {
    const res = await this.call<{ scheduled_message_id: string; post_at: number }>("chat.scheduleMessage", {
      channel,
      text,
      post_at: postAt,
      thread_ts: threadTs,
    });
    return { id: res.scheduled_message_id, postAt: res.post_at };
  }

  /** Messages this token scheduled that have not been sent yet. */
  async scheduledMessages(): Promise<ScheduledMessage[]> {
    const out: ScheduledMessage[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.call<{
        scheduled_messages: { id: string; channel_id: string; post_at: number; text?: string }[];
        response_metadata?: { next_cursor?: string };
      }>("chat.scheduledMessages.list", { limit: PAGE_SIZE, cursor });
      for (const m of page.scheduled_messages) out.push({ id: m.id, channel: m.channel_id, postAt: m.post_at, text: m.text ?? "" });
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }

  async deleteScheduledMessage(channel: string, id: string): Promise<void> {
    await this.call("chat.deleteScheduledMessage", { channel, scheduled_message_id: id });
  }

  async permalink(channel: string, ts: string): Promise<string | undefined> {
    try {
      return (await this.call<{ permalink: string }>("chat.getPermalink", { channel, message_ts: ts })).permalink;
    } catch {
      return undefined;
    }
  }

  async channelName(id: string): Promise<string | undefined> {
    try {
      const { channel } = await this.call<{ channel: { name?: string } }>("conversations.info", { channel: id });
      return channel.name;
    } catch {
      return undefined;
    }
  }
}
