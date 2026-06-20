import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    globalSetup: ["./tests/setup.ts"],
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // server-only throws at import time outside Next.js; alias it to a no-op.
    alias: {
      "server-only": resolve(__dirname, "tests/shims/server-only.ts"),
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./"),
    },
  },
});
