import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

import { R2NotConfiguredError, buildPublicUrl, presignPut } from "@/lib/r2/client";
import { PresignBody } from "@/lib/attachments/validators";
import { insertAttachment } from "@/lib/attachments/queries";
import { buildKey } from "@/lib/attachments/keys";
import { withAuth } from "@/lib/auth/with-auth";

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LEN = 12;

// ponytail: crypto-strong URL-safe id (~71 bits). Modulo bias is
// negligible at this alphabet length — no need for rejection sampling.
function generateId(): string {
  const bytes = randomBytes(ID_LEN);
  let out = "";
  for (let i = 0; i < ID_LEN; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

function parseAllowList(): Set<string> {
  const raw = process.env.NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function maxBytes(): number {
  const raw = process.env.R2_MAX_BYTES;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 1024 * 1024;
}

function notConfiguredResponse(): NextResponse {
  return NextResponse.json(
    {
      code: "ATTACHMENTS_NOT_CONFIGURED",
      message: "Set the R2_* env vars to enable attachments (see docs/ATTACHMENTS.md).",
    },
    { status: 503 },
  );
}

export const POST = withAuth(async (req, { user }) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: "BAD_REQUEST", error: "invalid JSON" }, { status: 400 });
  }

  const parsed = PresignBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues }, { status: 400 });
  }

  const allowList = parseAllowList();
  const contentType = parsed.data.contentType.toLowerCase();
  if (!allowList.has(contentType)) {
    return NextResponse.json({ code: "CONTENT_TYPE_NOT_ALLOWED", contentType }, { status: 400 });
  }

  const cap = maxBytes();
  if (parsed.data.sizeBytes > cap) {
    return NextResponse.json(
      { code: "FILE_TOO_LARGE", maxBytes: cap, sizeBytes: parsed.data.sizeBytes },
      { status: 400 },
    );
  }

  const id = generateId();
  const key = buildKey(user.id, id, parsed.data.name);

  // ponytail: images inline so <img> renders, everything else attachment
  // so PDF/HTML/SVG never execute inline. Server-decided — clients can't
  // override via signed GET (we use public bucket, no signed GET).
  const contentDisposition = contentType.startsWith("image/")
    ? `inline; filename="${parsed.data.name.replace(/"/g, "")}"`
    : `attachment; filename="${parsed.data.name.replace(/"/g, "")}"`;

  let uploadUrl: string;
  try {
    uploadUrl = await presignPut({
      key,
      contentLength: parsed.data.sizeBytes,
    });
  } catch (e) {
    if (e instanceof R2NotConfiguredError) return notConfiguredResponse();
    throw e;
  }

  await insertAttachment({
    id,
    userId: user.id,
    threadId: parsed.data.threadId ?? null,
    r2Key: key,
    name: parsed.data.name,
    contentType,
    sizeBytes: parsed.data.sizeBytes,
    status: "pending",
  });

  return NextResponse.json(
    {
      id,
      key,
      uploadUrl,
      publicUrl: buildPublicUrl(key),
      contentType,
      sizeBytes: parsed.data.sizeBytes,
      // ponytail: Content-Type + Content-Disposition ride as PLAIN headers
      // from the browser — they're not part of the signature (signed only
      // over key + length). R2 stores both on the object; the inline/attachment
      // decision enforces XSS-safe rendering (SVG/HTML/PDF never execute inline).
      uploadHeaders: { "Content-Type": contentType, "Content-Disposition": contentDisposition },
    },
    { status: 201 },
  );
});
