// ponytail: env var → typed config. Same shape used by GET response and
// retention cron. Recomputed on every call so a process restart picks
// up the latest value (rule: only restart, never runtime mutation).
const DEFAULT_RETENTION_DAYS = 30;

export function getRetentionDays(): number {
  const raw = process.env.OBSERVABILITY_RETENTION_DAYS;
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_RETENTION_DAYS;
  return n;
}
