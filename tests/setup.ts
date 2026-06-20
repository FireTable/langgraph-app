import { config } from "dotenv";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Load .env.local so DATABASE_URL_TEST is available to globalSetup.
config({ path: ".env.local" });

// Vitest globalSetup: runs once before all tests in a fresh process.
// Apply migrations directly to the test database using psql, bypassing
// drizzle-kit (which would re-load .env.local and override our URL).
export default async function setup() {
  const testUrl = process.env.DATABASE_URL_TEST;
  if (!testUrl) throw new Error("DATABASE_URL_TEST is required for vitest");

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
