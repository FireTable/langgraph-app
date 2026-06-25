import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "./"),
    },
  },
  test: {
    // Serialize all tests — they share a Postgres test database, and the
    // beforeEach truncate pattern only works correctly with no parallelism.
    fileParallelism: false,
    projects: [
      {
        // Backend + library tests run on node against the test Postgres.
        extends: true,
        test: {
          name: "node",
          environment: "node",
          globalSetup: ["./tests/setup.ts"],
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/frontend/**"],
        },
      },
      {
        // Frontend component tests run under jsdom so React can render.
        extends: true,
        test: {
          name: "frontend",
          environment: "jsdom",
          setupFiles: ["./tests/frontend/setup.ts"],
          include: ["tests/frontend/**/*.test.ts", "tests/frontend/**/*.test.tsx"],
        },
      },
    ],
  },
});
