/**
 * Images attached to Slack messages, saved into the vault when a thread is imported. Downloading
 * needs the user's token, so it only ever goes to https://files.slack.com, and only for URLs Slack's
 * own API returned (never URLs from note text). File names come from Slack's file id alone.
 */
import type { SlackFile } from "./client";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Image types worth keeping, with the extension to save them under. No SVG: it can carry scripts. */
const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const FILE_ID = /^F[A-Z0-9]+$/;

export interface FetchedFile {
  status: number;
  contentType?: string;
  data: ArrayBuffer;
}

/** Downloads a Slack file with the token. Implementations must refuse URLs that fail isSlackFileUrl. */
export type FileFetch = (url: string, token: string) => Promise<FetchedFile>;

export type ImageCheck = { ok: true } | { ok: false; reason: "status" | "login" | "not-image" | "too-large" };

function mimeOf(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/** `slack-<file id>.<ext>`, or null when the file is not an image the plugin keeps. */
export function imageFileName(file: SlackFile): string | null {
  const ext = IMAGE_TYPES[mimeOf(file.mimetype)];
  if (!ext || !file.id || !FILE_ID.test(file.id)) return null;
  return `slack-${file.id}.${ext}`;
}

/** True only for https://files.slack.com/… with no credentials or port in the URL. */
export function isSlackFileUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname === "files.slack.com" && !parsed.port && !parsed.username && !parsed.password;
}

/** Where to download an image from, or null when it should stay a link (not an image, hidden, too big, odd URL). */
export function imageDownloadUrl(file: SlackFile): string | null {
  if (!imageFileName(file) || file.mode === "hidden_by_limit") return null;
  if (file.size !== undefined && file.size > MAX_IMAGE_BYTES) return null;
  const url = file.url_private_download ?? file.url_private;
  return url && isSlackFileUrl(url) ? url : null;
}

/** Checks what came back before anything is written to the vault. */
export function checkImageResponse(res: FetchedFile): ImageCheck {
  const mime = mimeOf(res.contentType);
  // Without files:read, Slack answers with its sign-in page rather than an error status.
  if (mime === "text/html") return { ok: false, reason: "login" };
  if (res.status !== 200) return { ok: false, reason: "status" };
  if (!IMAGE_TYPES[mime] || res.data.byteLength === 0) return { ok: false, reason: "not-image" };
  if (res.data.byteLength > MAX_IMAGE_BYTES) return { ok: false, reason: "too-large" };
  return { ok: true };
}
