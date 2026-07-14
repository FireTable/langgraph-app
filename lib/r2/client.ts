import {
  GetObjectCommand,
  S3Client,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

// ponytail: keep all four helpers in one file — the S3 client is the
// only thing that needs to change for a future Backblaze B2 / MinIO
// migration, and bundling the per-call wrappers next to the connection
// makes that single-swap point visible.

// ponytail: only sign auth-critical fields (key + length). ContentType and
// ContentDisposition ride as plain headers from the browser — R2 still stores
// them on the object, but the signature doesn't pin them. Signing them would
// require the browser to send matching values, and `fetch(file)` doesn't add
// `content-disposition`, which would surface as an opaque CORS failure.
export async function presignPut(args: {
  key: string;
  contentLength: number;
  expiresInSeconds?: number;
}): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: getR2Bucket(),
    Key: args.key,
    ContentLength: args.contentLength,
  });
  return getSignedUrl(getS3Client(), cmd, { expiresIn: args.expiresInSeconds ?? 300 });
}

export async function headObject(key: string): Promise<{
  contentType: string | undefined;
  contentLength: number | undefined;
}> {
  const res = await getS3Client().send(new HeadObjectCommand({ Bucket: getR2Bucket(), Key: key }));
  return { contentType: res.ContentType, contentLength: res.ContentLength };
}

export async function deleteObject(key: string): Promise<void> {
  await getS3Client().send(new DeleteObjectCommand({ Bucket: getR2Bucket(), Key: key }));
}

// ponytail: server-side fetch used by the KB ingest pipeline (issue #13).
// Returns the raw object bytes as a Buffer; the caller is responsible for
// any format detection / decoding. v1 callers are the attachment-kb-
// injector node that pulls a PDF from R2 and feeds mupdf.
//
// We don't return a stream — the KB pipeline ingests the full PDF in
// one pass (mupdf needs the whole document for the page tree). A
// streaming variant would matter for >10 MiB docs; today the R2 cap
// is 10 MiB so the buffer is fine.
export async function getObject(key: string): Promise<Buffer> {
  const res = await getS3Client().send(new GetObjectCommand({ Bucket: getR2Bucket(), Key: key }));
  const body = res.Body;
  if (!body) throw new Error(`getObject: empty body for key ${key}`);
  // ponytail: Body is a Node Readable in Node runtime; collect chunks
  // into a single Buffer. transformToByteArray is the typed-array
  // equivalent but Buffer is what mupdf's openDocument takes.
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function buildPublicUrl(key: string): string {
  return `${getR2PublicBaseUrl()}/${key}`;
}
