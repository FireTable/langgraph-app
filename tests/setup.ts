import { loadEnvConfig } from "@next/env";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Use Next.js's own env loader. With NODE_ENV=test, .env.test / .env.test.local
// are read (and .env.local is intentionally skipped).
loadEnvConfig(process.cwd());

// Vitest globalSetup: runs once before all tests in a fresh process.
// Apply migrations directly to the test database using psql.
export default async function setup() {
  const testUrl = process.env.DATABASE_URL_TEST;
  if (!testUrl) throw new Error("DATABASE_URL_TEST is required for vitest");

  // db/client.ts reads DATABASE_URL. Alias the test URL so application code
  // under test stays unchanged.
  process.env.DATABASE_URL = testUrl;

  const dir = join(process.cwd(), "db", "migrations");
  const sqlFiles = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const f of sqlFiles) {
    console.log(`  → ${f}`);
    execFileSync("psql", [testUrl, "-v", "ON_ERROR_STOP=0", "-f", join(dir, f)], {
      stdio: "inherit",
    });
  }
}
