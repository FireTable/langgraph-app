import { NextResponse } from "next/server";

import { R2NotConfiguredError, buildPublicUrl, presignPut } from "@/lib/r2/client";
import { r2Keys } from "@/lib/r2/keys";
import { generateId } from "@/lib/ids/nanoid";
import { PresignBody } from "@/lib/attachments/validators";
import { findUploadedBySha, insertAttachment } from "@/lib/attachments/queries";
import { withAuth } from "@/lib/auth/with-auth";

// ponytail: row id stays 12-char random (via lib/ids/nanoid) — it's
// the attachments table PK and the dedup-confirmation token, but it's
// NO LONGER part of the R2 key. The R2 key is content-addressed
// (sha256 of bytes) via r2Keys().upload, so a second upload of the same
// file collapses to one R2 object regardless of how many `attachments`
// rows reference it.

function parseAllowList(): Set<string> {
  const raw = process.env.R2_ALLOWED_CONTENT_TYPES ?? "";
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

  // Q2 dedup short-circuit: if the client supplied a sha256 AND we have
  // an uploaded row for this (user, sha), skip the PUT entirely and hand
  // back the existing publicUrl. Adapter detects skipUpload:true and
  // jumps straight to confirm.
  //
  // ponytail: returns `existing.r2Key` straight from the DB row. Rows
  // written before the CAS refactor (issue #76 era) store nanoid-shaped
  // keys here — these are dev-only historical artifacts (see
  // docs/ATTACHMENTS.md § Pre-CAS legacy rows). Production deploys
  // start clean, so this returns the canonical sha-keyed URL the rest
  // of the app expects.
  if (parsed.data.sha256) {
    const existing = await findUploadedBySha(user.id, parsed.data.sha256);
    if (existing) {
      return NextResponse.json(
        {
          id: existing.id,
          key: existing.r2Key,
          publicUrl: buildPublicUrl(existing.r2Key),
          contentType: existing.contentType,
          sizeBytes: Number(existing.sizeBytes),
          skipUpload: true,
        },
        { status: 201 },
      );
    }
  }

  const id = generateId();
  // ponytail: ext from contentType — same MIME → same ext → same sha-keyed URL.
  // Stored row's `name` field keeps the user's original filename; only the
  // R2 key uses sha + ext.
  const ext = contentType.split("/")[1] ?? "bin";
  const key = r2Keys().upload({ userId: user.id, sha256: parsed.data.sha256, ext });

  // ponytail: images inline so <img> renders, everything else attachment
  // so PDF/HTML/SVG never execute inline. Server-decided — clients can't
  // override via signed GET (we use public bucket, no signed GET).
  // Filename is intentionally omitted: fetch() rejects header values with
  // non-ISO-8859-1 code points (e.g. CJK characters), and RFC 6266
  // filename* encoding adds noise for no gain — the browser falls back to
  // the URL's last segment (already nanoid-prefixed + sanitized).
  const contentDisposition = contentType.startsWith("image/") ? "inline" : "attachment";

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
    r2Key: key,
    name: parsed.data.name,
    contentType,
    sizeBytes: parsed.data.sizeBytes,
    sha256: parsed.data.sha256 ?? null,
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
