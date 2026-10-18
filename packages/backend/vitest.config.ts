import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    // Each file loads every Convex module once; on a busy machine that first load can pass 5 s.
    testTimeout: 30_000,
    server: { deps: { inline: ["convex-test"] } },
  },
});
