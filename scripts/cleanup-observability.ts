// ponytail: cron entry — runs `pnpm exec tsx scripts/cleanup-observability.ts` and
// logs how many rows were dropped. Production deployment should hook
// this into system cron (or pg_cron if you migrate). MVP scope keeps
// the script standalone; the queries helper is the only DB touch.
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import { deleteSpansOlderThan } from "@/lib/observability/queries";
import { getRetentionDays } from "@/lib/observability/config";

async function main() {
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
