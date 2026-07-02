// ponytail: cron entry — runs `pnpm exec tsx scripts/cleanup-observability.ts` and
// logs how many rows were dropped. Production deployment should hook
// this into system cron (or pg_cron if you migrate). MVP scope keeps
// the script standalone; the queries helper is the only DB touch.
//
// `loadEnvConfig` must run BEFORE `@/lib/observability/queries` is
// imported (the query chain reaches `db/client`, which throws at module
// load if DATABASE_URL is unset), so we dynamic-import inside `main`.
import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

async function main() {
  const { deleteSpansOlderThan } = await import("@/lib/observability/queries");
  const { getRetentionDays } = await import("@/lib/observability/config");
  const days = getRetentionDays();
  const removed = await deleteSpansOlderThan(days);
  console.log(`[retention] cutoff=${days}d removed=${removed}`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error("[retention] failed:", err);
    process.exit(1);
  },
);
