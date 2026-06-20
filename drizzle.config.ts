import { defineConfig } from "drizzle-kit";
import { loadEnvConfig } from "@next/env";

// Use Next.js's own env loader so `pnpm db:migrate` and `pnpm dev`
// see the same variables with the same precedence (.env.local overrides .env).
loadEnvConfig(process.cwd());

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required (check .env.local)");

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  verbose: true,
  strict: true,
});
