# Chat attachments

Cloudflare R2 backs chat attachments (issue #12). The browser uploads bytes
directly to R2 via a presigned PUT — nothing traverses Next.js. This doc
explains the design: why those choices, what to watch when extending, and
how to operate the bucket.

For the HTTP surface see [`docs/APIS.md`](./APIS.md#attachments). For the
table shape and ownership rules see [`docs/DB.md`](./DB.md#attachments).

## Architecture

```
[ browser composer ]
      │ 1. POST /api/attachments/presign   (Next.js)
      ▼
[ presign route ]── inserts row (status='pending') → returns { id, uploadUrl, publicUrl }
      │ 2. PUT uploadUrl (bytes)            (direct to R2)
      ▼
[ Cloudflare R2 ]   u/<userId>/<nanoid>-<safe-name>  + Content-Disposition
      │
      │ 3. POST /api/attachments/[id]/confirm (Next.js)
      ▼
[ confirm route ]  HeadObject size check → UPDATE status='uploaded', confirmed_at=now()
      │
      │ 4. assistant-ui `send()` builds content parts (image | file) pointing at publicUrl
      ▼
[ LangGraph chat run ]
```

## Why direct upload, not a Next.js proxy

The project is self-hosted — proxying through Next.js means eating our own
VPS bandwidth on every upload, blocking event loops on large files, and
adding a CU quota on whatever happens to be sitting in front of the app.
A 5-minute presigned PUT lets R2 absorb the bytes; the Next.js server only
orchestrates (presign → confirm).

The PUT signature covers `Key` + `Content-Length`; the browser adds
`Content-Type` and `Content-Disposition` as plain headers (R2 stores both
on the object). Signing `Content-Type` would force the browser to send a
matching value — `fetch(file)` does set Content-Type, but `fetch(file)`
doesn't add `Content-Disposition`, so we keep it out of the signature
and let R2 accept it as object metadata.

## R2 key convention

```
u/<userId>/<nanoid>-<safe-filename>
```

- `userId` — bare Better Auth user id. Community standard (Vercel guide,
  AWS blog, SO answers). The "exposes user activity via bucket list"
  concern is bounded: R2 list operations require IAM regardless of the
  bucket's public-read policy.
- 12-char nanoid — URL-safe alphabet, ~71 bits of entropy. Generated from
  `crypto.randomBytes` (no nanoid dep). The id is also the row PK so the
  public URL never carries a guessable id.
- `safe-filename` — strips path separators, control chars, trailing dots;
  clamps to 200 chars (`lib/attachments/keys.ts`).

## Bucket setup

1. **Public bucket + custom domain** — `R2_PUBLIC_BASE_URL` (e.g.
   `https://file.ai.firetable.tech`). Custom domain over the r2.dev
   default because we own the DNS; future migration to signed GET only
   needs an env change, no code.
2. **CORS rule** — the browser PUT requires CORS. Verified config:

   ```json
   [
     {
       "AllowedOrigins": ["http://localhost:3000", "https://ai.firetable.tech"],
       "AllowedMethods": ["GET", "PUT", "HEAD"],
       "AllowedHeaders": ["Content-Type", "Content-Disposition"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3000
     }
   ]
   ```

   GET is permitted so the renderer can re-fetch uploaded URLs after the
   runtime serves them; `ExposeHeaders: ["ETag"]` lets the client inspect
   the upload identity. `Content-Disposition` MUST be in `AllowedHeaders`
   — the adapter sends it as a plain HTTP header on the PUT (see point 3)
   and the browser preflight asks permission. New dev origins (or a second
   production origin) need to be added; don't try to wildcard.

3. **Content-Disposition is per-object, server-decided, sent as a plain
   HTTP header (NOT in the signature).** The presign route includes
   `Content-Disposition` in the `uploadHeaders` returned to the adapter;
   the browser sends it on the PUT. R2 stores it on the object and serves
   it back unchanged on GET. The `PutObjectCommand` only signs over `Key`
   - `Content-Length` — signing `Content-Type` or `Content-Disposition`
     would require the browser to send matching values on the wire, but
     `fetch(file)` doesn't add `Content-Disposition` and a mismatch would
     surface as an opaque CORS failure ("Failed to fetch" with no detail).
   * images → `inline; filename="..."`
   * everything else → `attachment; filename="..."`

   R2 has no bucket-level "default Content-Disposition" override — the
   per-object metadata is authoritative and is served back unchanged on
   GET. This is the XSS guardrail: SVG / HTML / PDF never execute inline.

## No `messageId` column

assistant-ui has no documented mechanism to correlate an attachment with
the resulting `message_id` after `send()`. The attachment becomes content
parts inline; there's no out-of-band id exposed to the backend.

Implementing `messageId` backfill needs custom `useLangGraphRuntime`
run-metadata hooks + backend run-metadata plumbing — out of scope.

**Adopted strategy:** `attachments` has no `message_id` column. Thread-side
rendering joins `attachments` to LangGraph `messages` via `(thread_id,
created_at)` window — find attachments created within the user message's
send timestamp window. Slightly fuzzy but sufficient for the only consumer
(thread-side chip rendering on reload).

If exact `messageId` mapping ever becomes necessary (e.g. KB ingestion
correlation), add it via `runConfig.metadata` from the adapter and
backfill on the `triggerBackgroundAgent` run.

## Lazy-register on missing env (mirrors rule #10)

- **Backend**: `lib/r2/client.ts` throws `R2NotConfiguredError` when any
  of `R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET /
R2_PUBLIC_BASE_URL` is missing. Each route catches that and returns
  `503 ATTACHMENTS_NOT_CONFIGURED`. Not 404 (route exists), not 500 (not a
  bug) — same contract as the DENO and ALCHEMY lazy-register patterns.
- **Frontend**: single client-visible flag `NEXT_PUBLIC_ATTACHMENTS_ENABLED`.
  When `"false"` (default in `.env.example`), the assistant-ui `<Composer />`
  renders without an attachment button — `useLangGraphRuntime` simply isn't
  passed `adapters.attachments` and assistant-ui hides the picker
  automatically. No custom conditional render.

The two flags must be flipped together: backend needs `R2_*` populated,
frontend needs `NEXT_PUBLIC_ATTACHMENTS_ENABLED="true"`.

## `NEXT_PUBLIC_R2_ALLOWED_CONTENT_TYPES` — single env, read by both sides

The MIME allow-list is a **non-secret public config**. The
`NEXT_PUBLIC_` prefix lets both server (`lib/attachments/validators.ts` +
presign route) and client (`R2AttachmentAdapter.accept`) read the same
env var — avoids dual-env drift and avoids a `/api/attachments/config`
endpoint just to surface this to the frontend.

Do NOT add `NEXT_PUBLIC_` to `R2_ACCOUNT_ID / R2_ACCESS_KEY_ID /
R2_SECRET_ACCESS_KEY / R2_BUCKET` — those are secrets, server-only.
`R2_MAX_BYTES` stays server-only too; the cap is enforced at presign, the
client gets a fast 400 if they try to upload something larger.

## Per-route contract recap

| Route                                | Purpose                                          | Codes                       |
| ------------------------------------ | ------------------------------------------------ | --------------------------- |
| `POST /api/attachments/presign`      | Reserve row + return presigned PUT URL + headers | 201 / 400 / 401 / 503       |
| `POST /api/attachments/[id]/confirm` | HeadObject verify + flip to `uploaded`           | 200 / 401 / 404 / 409 / 503 |
| `DELETE /api/attachments/[id]`       | Remove row + R2 object (idempotent)              | 204 / 401 / 404 / 503       |

## Watch-outs when extending

- **Orphan `pending` rows.** If a user picks a file then closes the tab
  before the PUT finishes, or before sending, the row stays `pending`.
  Add a retention sweep on `created_at` if these accumulate.
- **No partial-upload resume.** The PUT is a single request — a network
  drop mid-flight means the user re-picks the file. For files >100 MiB
  this gets painful; consider multipart PUT then.
- **Bucket size / egress.** R2's free tier covers 10M Class B ops/month
  and zero egress. Each upload = 1 Class A + 1 Class B; each confirm = 1
  Class A (HeadObject); each delete = 1 Class A. Track if you scale
  beyond the free tier — see [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
- **`Content-Disposition` filename.** The presign route escapes `"` in the
  filename but doesn't transliterate non-ASCII. For full i18n support
  encode the filename as `filename*=UTF-8''...` per RFC 6266.
