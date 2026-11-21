// Fails when the built plugin relies on something Obsidian's mobile apps do not have. Mobile runs the
// plugin in a WebView: there is no Node.js or Electron, and Obsidian only provides these modules.
//
//   node scripts/check-bundle.mjs [path/to/main.js]
import { readFileSync } from "node:fs";

const ALLOWED_MODULE = /^(obsidian|@codemirror\/[a-z-]+|@lezer\/[a-z-]+)$/;
const FORBIDDEN = [
  [/\bBuffer\b/, "Buffer (Node.js)"],
  [/\bprocess\.[a-zA-Z]/, "process (Node.js)"],
  [/\b__dirname\b|\b__filename\b/, "__dirname / __filename (Node.js)"],
  [/\bwindow\.require\b/, "window.require (desktop only)"],
  [/\belectron\b/, "electron (desktop only)"],
];

const file = process.argv[2] ?? "main.js";
const code = readFileSync(file, "utf8");
const problems = [];

const modules = new Set([...code.matchAll(/\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]));
for (const m of modules) if (!ALLOWED_MODULE.test(m)) problems.push(`require("${m}") is not available on mobile`);
if (/\brequire\(\s*[^"'`\s)]/.test(code)) problems.push("require() with a computed module name");
for (const [re, what] of FORBIDDEN) if (re.test(code)) problems.push(`uses ${what}`);

if (problems.length) {
  console.error(`${file} would break on Obsidian mobile:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`${file}: mobile-safe (requires: ${[...modules].sort().join(", ")})`);
