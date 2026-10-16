import { describe, expect, it } from "vitest";
import { blockAt, findSlackBlocks } from "../src/block/locate";

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

describe("blockAt", () => {
  const blocks = findSlackBlocks(note);

  it("picks the block under the cursor, fences included", () => {
    expect(blockAt(blocks, 4)?.start).toBe(1);
    expect(blockAt(blocks, 6)?.start).toBe(1);
    expect(blockAt(blocks, 12)?.start).toBe(11);
  });

  it("never picks a block the cursor is not in, even when it is the only one", () => {
    expect(blockAt(blocks, 0)).toBeUndefined();
    expect(blockAt(blocks, 7)).toBeUndefined();
    expect(blockAt([blocks[0]], 0)).toBeUndefined();
  });
});
