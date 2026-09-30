import type { Strings } from "../i18n";
import { SlackApiError } from "./client";

const AUTH = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);
const CHANNEL = new Set(["channel_not_found", "not_in_channel", "is_archived"]);
const MESSAGE = new Set(["thread_not_found", "message_not_found"]);

export function describeError(err: unknown, s: Strings): string {
  if (!(err instanceof SlackApiError)) return err instanceof Error ? err.message : String(err);
  if (err.code === "missing_scope") return s.errMissingScope(err.needed);
  if (err.code === "ratelimited") return s.errRateLimited;
  if (AUTH.has(err.code)) return s.errAuth;
  if (CHANNEL.has(err.code)) return s.errChannel;
  if (MESSAGE.has(err.code)) return s.errMessage;
  return s.errOther(err.code);
}
