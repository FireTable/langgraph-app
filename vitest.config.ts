import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    globalSetup: ["./tests/setup.ts"],
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Serialize all tests — they share a Postgres test database, and the
    // beforeEach truncate pattern only works correctly with no parallelism.
    fileParallelism: false,
    // server-only throws at import time outside Next.js; alias it to a no-op.
    alias: {
      "server-only": resolve(__dirname, "tests/shims/server-only.ts"),
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./"),
      // Mirror the test.alias into resolve.alias so vitest's bundler
      // (esbuild during transform) and module resolution agree.
      "server-only": resolve(__dirname, "tests/shims/server-only.ts"),
    },
  },
});
