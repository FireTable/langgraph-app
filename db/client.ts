import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

declare global {
  var __pg: ReturnType<typeof postgres> | undefined;
}

// Singleton across HMR reloads in dev. In production each Node process
// has exactly one pool.
const sql = globalThis.__pg ?? postgres(url, { max: 10 });
if (process.env.NODE_ENV !== "production") globalThis.__pg = sql;

export const db = drizzle(sql, { schema });
export type DB = typeof db;
