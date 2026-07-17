import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// ponytail: cache the extension check at module load. The check is a
// single SQL round-trip against pg_extension; once known, every tool
// import uses the cached value. The test suite can stub the cache via
// `_resetPgVectorCache()`.

let cachedExtensionAvailable: boolean | null = null;

export async function isPgVectorAvailable(): Promise<boolean> {
  if (cachedExtensionAvailable !== null) return cachedExtensionAvailable;
  const rows = await db.execute<{ ok: number }>(sql`
    SELECT 1 AS ok FROM pg_extension WHERE extname = 'vector'
  `);
  const result = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<{ ok: number }> }).rows ?? []);
  cachedExtensionAvailable = result.length > 0;
  return cachedExtensionAvailable;
}

export function _resetPgVectorCache(value: boolean | null = null): void {
  cachedExtensionAvailable = value;
}
