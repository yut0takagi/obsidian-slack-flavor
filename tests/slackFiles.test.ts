import { describe, expect, it } from "vitest";
import { checkImageResponse, imageDownloadUrl, imageFileName, isSlackFileUrl, MAX_IMAGE_BYTES } from "../src/slack/files";
import type { SlackFile } from "../src/slack/client";

const png: SlackFile = {
  id: "F0123ABCD",
  name: "screen shot.png",
  mimetype: "image/png",
  url_private: "https://files.slack.com/files-pri/T1-F0123ABCD/screen_shot.png",
  url_private_download: "https://files.slack.com/files-pri/T1-F0123ABCD/download/screen_shot.png",
  size: 1234,
};

describe("imageFileName", () => {
  it("names an image after its Slack id, with the extension from its type", () => {
    expect(imageFileName(png)).toBe("slack-F0123ABCD.png");
    expect(imageFileName({ ...png, mimetype: "image/jpeg" })).toBe("slack-F0123ABCD.jpg");
    expect(imageFileName({ ...png, mimetype: "image/gif" })).toBe("slack-F0123ABCD.gif");
    expect(imageFileName({ ...png, mimetype: "image/webp" })).toBe("slack-F0123ABCD.webp");
  });

  it("is null for other types (SVG can carry scripts) and for ids that are not Slack's", () => {
    for (const mimetype of ["application/pdf", "image/svg+xml", "image/heic", "text/html", undefined]) {
      expect(imageFileName({ ...png, mimetype })).toBeNull();
    }
    for (const id of ["../F1", "F1/x", "f0123", "", undefined]) expect(imageFileName({ ...png, id })).toBeNull();
  });
});

describe("imageDownloadUrl", () => {
  it("prefers the download URL", () => {
    expect(imageDownloadUrl(png)).toBe(png.url_private_download);
    expect(imageDownloadUrl({ ...png, url_private_download: undefined })).toBe(png.url_private);
  });

  it("only sends the token to https://files.slack.com", () => {
    for (const url of [
      "http://files.slack.com/files-pri/T1-F1/a.png",
      "https://files.slack.com.example.com/a.png",
      "https://example.com/files.slack.com/a.png",
      "https://user:pass@files.slack.com/a.png",
      "https://files.slack.com:8443/a.png",
      "https://drive.google.com/file/d/1",
      "not a url",
    ]) {
      expect(isSlackFileUrl(url)).toBe(false);
      expect(imageDownloadUrl({ ...png, url_private_download: url, url_private: url })).toBeNull();
    }
    expect(isSlackFileUrl(png.url_private!)).toBe(true);
  });

  it("is null for files Slack hides (free plan limit) and for images over the size limit", () => {
    expect(imageDownloadUrl({ id: "F1", mimetype: "image/png", mode: "hidden_by_limit" })).toBeNull();
    expect(imageDownloadUrl({ ...png, mode: "hidden_by_limit" })).toBeNull();
    expect(imageDownloadUrl({ ...png, size: MAX_IMAGE_BYTES + 1 })).toBeNull();
    expect(imageDownloadUrl({ ...png, mimetype: "application/pdf" })).toBeNull();
  });
});

describe("checkImageResponse", () => {
  const data = new ArrayBuffer(10);

  it("accepts an image of an allowed type", () => {
    expect(checkImageResponse({ status: 200, contentType: "image/png", data })).toEqual({ ok: true });
    expect(checkImageResponse({ status: 200, contentType: "image/jpeg; charset=binary", data })).toEqual({ ok: true });
  });

  it("tells a sign-in page (token without files:read) from other failures", () => {
    expect(checkImageResponse({ status: 200, contentType: "text/html; charset=utf-8", data })).toEqual({ ok: false, reason: "login" });
    expect(checkImageResponse({ status: 403, contentType: "text/plain", data })).toEqual({ ok: false, reason: "status" });
    expect(checkImageResponse({ status: 200, contentType: "image/svg+xml", data })).toEqual({ ok: false, reason: "not-image" });
    expect(checkImageResponse({ status: 200, contentType: "image/png", data: new ArrayBuffer(0) })).toEqual({ ok: false, reason: "not-image" });
    expect(checkImageResponse({ status: 200, contentType: "image/png", data: new ArrayBuffer(MAX_IMAGE_BYTES + 1) })).toEqual({ ok: false, reason: "too-large" });
  });
});
