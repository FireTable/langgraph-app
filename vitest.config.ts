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
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./"),
    },
  },
});
