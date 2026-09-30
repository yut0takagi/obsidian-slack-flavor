import { describe, expect, it } from "vitest";
import { parseSlackBlock } from "../src/block/parse";

describe("parseSlackBlock", () => {
  it("reads meta lines, messages, reactions and thread replies", () => {
    const src = [
      "workspace: acme",
      "Channel: #general",
      "",
      "@田中 10:30",
      "おはようございます",
      "*定例* は14時から",
      "+:tada: 3 :eyes:",
      "",
      "↳ @山田 太郎 10:32",
      "了解です",
      "",
      ">> @佐藤",
      "👍",
      "",
      "@鈴木 2026-09-30 11:00",
      "別件です",
    ].join("\n");

    expect(parseSlackBlock(src)).toEqual({
      meta: { workspace: "acme", channel: "#general" },
      text: "",
      messages: [
        {
          author: "田中",
          time: "10:30",
          body: "おはようございます\n*定例* は14時から",
          reactions: [
            { emoji: ":tada:", count: 3 },
            { emoji: ":eyes:", count: 1 },
          ],
          replies: [
            { author: "山田 太郎", time: "10:32", body: "了解です", reactions: [], replies: [] },
            { author: "佐藤", body: "👍", reactions: [], replies: [] },
          ],
        },
        { author: "鈴木", time: "2026-09-30 11:00", body: "別件です", reactions: [], replies: [] },
      ],
    });
  });

  it("treats a block without message headers as plain mrkdwn", () => {
    expect(parseSlackBlock("*太字* と :tada:\n> 引用")).toEqual({
      meta: {},
      text: "*太字* と :tada:\n> 引用",
      messages: [],
    });
  });

  it("keeps text written before the first message", () => {
    const parsed = parseSlackBlock("channel: #dev\nここから\n\n@a 9:00\nhi");
    expect(parsed.text).toBe("ここから");
    expect(parsed.messages.map((m) => m.author)).toEqual(["a"]);
  });

  it("only recognizes headers at the start or after a blank line", () => {
    const parsed = parseSlackBlock("@a 9:00\nline\n@b 9:01\nstill a");
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].body).toBe("line\n@b 9:01\nstill a");
  });

  it("does not mistake '@name words' for a header when there is no time", () => {
    const parsed = parseSlackBlock("@a\n\n@山田 了解です");
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].body).toBe("@山田 了解です");
  });

  it("keeps reaction-looking lines that are not at the end of the body", () => {
    const parsed = parseSlackBlock("@a\n+:x: 1\ntext");
    expect(parsed.messages[0]).toMatchObject({ body: "+:x: 1\ntext", reactions: [] });
  });

  it("parses skin-toned reactions", () => {
    expect(parseSlackBlock("@a\nhi\n+:+1::skin-tone-2: 2").messages[0].reactions).toEqual([
      { emoji: ":+1::skin-tone-2:", count: 2 },
    ]);
  });

  it("treats a reply with no parent as a top-level message", () => {
    expect(parseSlackBlock("↳ @a\nhi").messages).toEqual([{ author: "a", body: "hi", reactions: [], replies: [] }]);
  });

  it("handles CRLF", () => {
    expect(parseSlackBlock("@a 1:00\r\nhi\r\n").messages[0]).toMatchObject({ author: "a", body: "hi" });
  });
});
