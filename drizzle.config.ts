import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";

// drizzle-kit doesn't auto-load .env.local. We load it ourselves so
// `pnpm db:migrate` works the same way `pnpm dev` does.
config({ path: ".env.local" });

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
