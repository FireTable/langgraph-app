import { defineConfig, devices } from "@playwright/test";

// Component-level e2e: each spec mounts a single card into a real
// Chromium browser (jsdom misses CSS layout, while real Chrome catches
// that the place-crypto-order preview actually fits inside the tool
// call's `ps-6 pt-1 pb-2` chrome, that the simulated-receipt emerald
// circle doesn't overflow, etc.). No dev server required — the
// fixtures serve the compiled JSX inline via a custom HTML harness.

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3100",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Static harness server — serves a one-line HTML page that imports
  // the compiled JSX from a Vite dev server spawned in `webServer`.
  webServer: {
    command: "pnpm exec vite --port 3100 --config tests/e2e/vite.config.ts",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
