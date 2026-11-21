import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The obsidian package only ships types; tests that need it get small fakes instead.
    alias: { obsidian: fileURLToPath(new URL("./tests/fakes/obsidian.ts", import.meta.url)) },
  },
  test: {
    environment: "happy-dom",
    include: ["tests/**/*.test.ts"],
  },
});
