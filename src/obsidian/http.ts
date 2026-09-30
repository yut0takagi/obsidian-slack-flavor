import { requestUrl } from "obsidian";
import type { HttpFn } from "../slack/client";

/** requestUrl bypasses CORS, which Slack's Web API does not allow from app://obsidian.md. */
export const obsidianHttp: HttpFn = async (req) => {
  const { "Content-Type": contentType, ...headers } = req.headers;
  const res = await requestUrl({ url: req.url, method: req.method, headers, contentType, body: req.body, throw: false });
  let json: unknown = null;
  try {
    json = res.json;
  } catch {
    // Non-JSON body (e.g. an HTML error page); the client reports it by status.
  }
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) lower[k.toLowerCase()] = v;
  return { status: res.status, headers: lower, json };
};
