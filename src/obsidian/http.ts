import { requestUrl } from "obsidian";
import type { HttpFn } from "../slack/client";
import type { ImageFetch } from "../store/imageCache";

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

/** Plain GET for emoji images. No Authorization header: the image host never sees the token. */
export const obsidianImageFetch: ImageFetch = async (url) => {
  const res = await requestUrl({ url, method: "GET", throw: false });
  const type = Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1];
  return { status: res.status, contentType: type, data: res.arrayBuffer };
};
