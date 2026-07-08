import { S3Client } from "@aws-sdk/client-s3";

const REQUIRED_ENV = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_PUBLIC_BASE_URL",
] as const;

export class R2NotConfiguredError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(`R2 not configured — missing env vars: ${missing.join(", ")}`);
    this.name = "R2NotConfiguredError";
    this.missing = missing;
  }
}

function assertConfigured(): void {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) throw new R2NotConfiguredError(missing);
}

let cached: S3Client | null = null;

export const getS3Client = (): S3Client => {
  assertConfigured();
  if (cached) return cached;
  cached = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
  return cached;
};

export const getR2Bucket = (): string => {
  if (!process.env.R2_BUCKET) throw new R2NotConfiguredError(["R2_BUCKET"]);
  return process.env.R2_BUCKET;
};

export const getR2PublicBaseUrl = (): string => {
  if (!process.env.R2_PUBLIC_BASE_URL) throw new R2NotConfiguredError(["R2_PUBLIC_BASE_URL"]);
  return process.env.R2_PUBLIC_BASE_URL.replace(/\/$/, "");
};
