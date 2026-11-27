/**
 * Checks before posting to Slack. A post cannot be taken back, so the confirmation shows exactly what
 * will be sent and who it will notify, and nothing is sent for text or times Slack would refuse.
 */

/** Slack truncates longer text. */
export const MAX_POST_CHARS = 40_000;
/** chat.scheduleMessage accepts up to 120 days ahead. */
export const MAX_SCHEDULE_DAYS = 120;
const MIN_LEAD_MS = 60_000;

export interface Notifications {
  /** `<!here>`, `<!channel>`, `<!everyone>` in the text, in the order first seen. */
  broadcasts: ("here" | "channel" | "everyone")[];
  /** Distinct users mentioned with `<@U…>`. */
  users: number;
  /** Distinct user groups mentioned with `<!subteam^…>`. */
  groups: number;
}

/** Who the text will notify. Plain "@name" is posted as text by the API (no link_names), so it does not count. */
export function notifications(text: string): Notifications {
  const broadcasts: Notifications["broadcasts"] = [];
  for (const m of text.matchAll(/<!(here|channel|everyone)(?:\|[^>]*)?>/g)) {
    const b = m[1] as Notifications["broadcasts"][number];
    if (!broadcasts.includes(b)) broadcasts.push(b);
  }
  const users = new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]));
  const groups = new Set([...text.matchAll(/<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]));
  return { broadcasts, users: users.size, groups: groups.size };
}

export function checkPostText(text: string): "empty" | "too-long" | null {
  if (!text.trim()) return "empty";
  if (text.length > MAX_POST_CHARS) return "too-long";
  return null;
}

export type PostAtCheck = { ok: true; postAt: number } | { ok: false; reason: "invalid" | "past" | "too-far" };

/** Slack's post_at (Unix seconds) for a scheduled time, which must be at least a minute ahead and within 120 days. */
export function checkPostAt(when: Date, now: Date): PostAtCheck {
  const t = when.getTime();
  if (Number.isNaN(t)) return { ok: false, reason: "invalid" };
  if (t - now.getTime() < MIN_LEAD_MS) return { ok: false, reason: "past" };
  if (t - now.getTime() > MAX_SCHEDULE_DAYS * 86_400_000) return { ok: false, reason: "too-far" };
  return { ok: true, postAt: Math.floor(t / 1000) };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A local time as an `<input type="datetime-local">` value (minutes precision). */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Reads a datetime-local value as local time; an invalid value gives an invalid Date. */
export function fromLocalInput(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : new Date(Number.NaN);
}
