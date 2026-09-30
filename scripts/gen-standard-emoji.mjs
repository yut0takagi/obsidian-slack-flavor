// Generates src/emoji/standard.json from emoji-datasource (iamcal/emoji-data),
// the data set Slack's emoji names come from.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const data = require("emoji-datasource/emoji.json");

const TONES = ["1F3FB", "1F3FC", "1F3FD", "1F3FE", "1F3FF"];
const toChar = (unified) => String.fromCodePoint(...unified.split("-").map((h) => parseInt(h, 16)));

const names = {};
const skins = {};
for (const e of [...data].sort((a, b) => a.sort_order - b.sort_order)) {
  const char = toChar(e.unified);
  for (const n of e.short_names) names[n] = char;
  if (!e.skin_variations) continue;
  // Keyed by the base character so every alias (+1 / thumbsup) finds its variants.
  // Slack's :skin-tone-N: applies one tone; two-person emoji get the same tone twice.
  const variants = TONES.map((t) => e.skin_variations[t] ?? e.skin_variations[`${t}-${t}`]);
  if (variants.some((v) => !v)) continue;
  skins[char] = variants.map((v) => toChar(v.unified));
}

const version = JSON.parse(readFileSync(require.resolve("emoji-datasource/package.json"), "utf8")).version;
writeFileSync(
  new URL("../src/emoji/standard.json", import.meta.url),
  JSON.stringify({ source: `emoji-datasource@${version}`, names, skins }),
);
console.log(`names: ${Object.keys(names).length}, skins: ${Object.keys(skins).length}`);
