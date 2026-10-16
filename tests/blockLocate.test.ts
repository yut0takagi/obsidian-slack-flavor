import { describe, expect, it } from "vitest";
import { findSlackBlocks, pickBlock } from "../src/block/locate";

const SRC = "source: https://acme.slack.com/archives/C1/p1790731800000100";
const note = [
  "# Note", // 0
  "```slack", // 1
  SRC,
  "",
  "@a",
  "hi",
  "```", // 6
  "text",
  "````slack", // 8
  "```inner```",
  "````", // 10
  "~~~Slack ", // 11
  "x",
  "~~~", // 13
  "```js",
  "@a",
  "```",
  "```slack", // 17: never closed
  "y",
];

describe("findSlackBlocks", () => {
  it("finds fenced slack blocks with their line range and content", () => {
    expect(findSlackBlocks(note)).toEqual([
      { start: 1, end: 6, content: `${SRC}\n\n@a\nhi` },
      { start: 8, end: 10, content: "```inner```" },
      { start: 11, end: 13, content: "x" },
    ]);
  });

  it("needs a closing fence at least as long as the opening one", () => {
    expect(findSlackBlocks(["````slack", "```", "a", "````"])).toEqual([{ start: 0, end: 3, content: "```\na" }]);
  });

  it("skips slack fences inside other code blocks", () => {
    expect(findSlackBlocks(["````md", "```slack", "a", "```", "````"])).toEqual([]);
  });
});

describe("pickBlock", () => {
  const blocks = findSlackBlocks(note);
  const refreshable = (b: { content: string }) => b.content.startsWith("source:");

  it("picks the block under the cursor, fences included", () => {
    expect(pickBlock(blocks, 4, refreshable)?.start).toBe(1);
    expect(pickBlock(blocks, 6, refreshable)?.start).toBe(1);
    expect(pickBlock(blocks, 12, refreshable)?.start).toBe(11);
  });

  it("falls back to the only refreshable block in the note", () => {
    expect(pickBlock(blocks, 0, refreshable)?.start).toBe(1);
    expect(pickBlock([...blocks, { start: 20, end: 22, content: SRC }], 0, refreshable)).toBeUndefined();
  });
});
