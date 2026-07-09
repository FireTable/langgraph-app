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
      │ 1. user picks a file → adapter.add() (zero network, no DB row)
      │
      │ 2. user clicks Send → adapter.send()
      │      a. POST /api/attachments/presign   (Next.js → row status='pending')
      │      b. PUT uploadUrl                   (browser → R2)
      │      c. POST /api/attachments/[id]/confirm  (Next.js → row status='uploaded')
      ▼
[ Cloudflare R2 ]   u/<userId>/<nanoid>-<safe-name>  + Content-Disposition
      │
      │ 3. assistant-ui embed the publicUrl into the message content part
      │    (`{ type: "image", image: publicUrl }`)
      ▼
[ LangGraph chat run ]   renderer reads content parts directly off the message
```

The `add()` step is intentionally a no-op on the network. The full pipeline
runs in `send()` the moment the user hits Send. See
[Deferred upload](#deferred-upload) below for why.

## Deferred upload

`add()` does **not** call `presign` or `PUT`. It just returns a
`PendingAttachment` with status `requires-action` and stashes the original
`File` on the chip. `send()` then runs the full
`presign → PUT → confirm` chain and returns a `CompleteAttachment` whose
content parts embed the `publicUrl` for the renderer to display.

Side effects this avoids:

- **No orphan `pending` rows.** Closing the tab before sending leaves
  nothing on the server side — `add()` never created a row.
- **No "uploading" state to design.** The chip is stable from the moment
  the file is picked; bytes only fly at Send time.
- **Adapter is thread-agnostic.** The presign body no longer carries
  `threadId` at all (Q3 — see [No thread binding](#no-thread-binding)).
  The composer dispatches the message AFTER `send()` returns, so the
  thread is a `__LOCALID_*` placeholder at presign time. We sidestep
  the issue by not reading the thread at all.

The R2 `PUT` is a single round trip; `fetch(file)` carries the bytes
straight to the bucket. Network drops mid-flight mean the user re-picks
the file. For files >100 MiB, swap to multipart PUT.

## SHA-256 dedup (Q2)

`send()` hashes the file bytes with `crypto.subtle.digest("SHA-256", ...)`
and sends the 64-char hex in the presign body. The route checks for an
existing uploaded row with the same `(user_id, sha256)` and short-circuits
when one exists — response carries `skipUpload: true` and the existing
row's `publicUrl`. The adapter jumps straight to confirm; the PUT to R2
never happens.

What this saves:

- **No second upload** of the same bytes — same image re-attached in a
  different thread (or the same) hits dedup, R2 sees one PUT.
- **No duplicate storage** — R2 only holds one copy of the bytes per
  (user, sha).

Scope is per-user by design. User A and user B uploading the same file
get separate rows in R2 with separate publicUrls — storage quotas and
deletion rights are user-scoped, so cross-user dedup would create a
shared object that the other user could read but not delete.

The partial unique index `attachments_user_sha_uploaded_idx` enforces
"at most one uploaded row per (user, sha)" at the DB level. `pending`
rows are excluded from the index so two parallel uploads of the same
file from different tabs don't race the constraint.

Clients without `crypto.subtle` (very old browsers, server-side flows)
just omit `sha256` from the presign body — the validator accepts it as
optional, dedup simply doesn't run for them.

## No thread binding

`attachments` has **no** `thread_id` or `message_id` column. Three reasons:

1. **The composer dispatches the message after `send()` returns**, so the
   thread is still a `__LOCALID_*` placeholder at presign time. Storing it
   would require a time-window backfill that misbehaves on slow networks.
2. **The renderer reads content parts directly off the message**
   (`{ type: "image", image: publicUrl }` is embedded by `send()`), so it
   never needs to query the `attachments` table to find what belongs to a
   message.
3. **Cross-thread sharing falls out for free.** The same upload referenced
   from N messages just embeds the same `publicUrl` N times — no FK
   gymnastics.

Lifecycle:

- **Create:** `add()` does nothing on the network. `send()` writes a
  `pending` row at presign, then `uploaded` at confirm.
- **Confirm:** `HeadObject` verifies the R2 size matches `sizeBytes`; on
  mismatch the row is left in `pending` and the adapter surfaces
  `409 SIZE_MISMATCH` so the user knows to retry.
- **Cleanup:** no FK cascade to `threads` anymore. Orphan `pending` rows
  (created mid-confirm when the user closes the tab) are swept by a
  retention job — see [Watch-outs](#watch-outs).

## R2 key convention

```
u/<userId>/<nanoid>-<safe-filename>
```

- `userId` — bare Better Auth user id. The "exposes user activity via
  bucket list" concern is bounded: R2 list operations require IAM
  regardless of the bucket's public-read policy.
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
   — the adapter sends it as a plain HTTP header on the PUT and the
   browser preflight asks permission. New dev origins (or a second
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
   * images → `inline`
   * everything else → `attachment`

   The filename is intentionally omitted from the header value:
   `fetch()` rejects header values with non-ISO-8859-1 code points (e.g.
   CJK characters), and RFC 6266 `filename*` encoding adds noise for no
   gain — the browser falls back to the URL's last segment (already
   nanoid-prefixed + sanitized).

   R2 has no bucket-level "default Content-Disposition" override — the
   per-object metadata is authoritative and is served back unchanged on
   GET. This is the XSS guardrail: SVG / HTML / PDF never execute inline.

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

## Watch-outs

- **Orphan `pending` rows.** The `add()` step makes no network calls
  anymore, so a user who picks a file and closes the tab before
  clicking Send leaves nothing on the server. The remaining source of
  orphans is: confirm fails (network drops between PUT and confirm).
  Add a retention sweep on `created_at < now() - 24h AND status='pending'`
  if these accumulate.
- **No partial-upload resume.** The PUT is a single request — a network
  drop mid-flight means the user re-picks the file. For files >100 MiB
  this gets painful; consider multipart PUT then.
- **Bucket size / egress.** R2's free tier covers 10M Class B ops/month
  and zero egress. Each upload = 1 Class A + 1 Class B; each confirm = 1
  Class A (HeadObject); each delete = 1 Class A. Track if you scale
  beyond the free tier — see [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
- **No thread-side attachment queries.** Because the row has no
  `thread_id`, "show me all attachments in this thread" isn't a query
  you can do directly. The renderer reads content parts off the
  message; for an admin view, filter on the
  `(message.content[*].type === 'image' | 'file')` JSONB. If a true
  thread-side index becomes necessary, add a join table
  `message_attachments(message_id, attachment_id)` — the existing
  schema leaves room for it (PK is the row id, no FK to threads).
- **CORS preflight caching.** When iterating on the CORS rule, remember
  browsers cache failed preflights for `MaxAgeSeconds` (we set 3000s =
  50min). A hard reload (Cmd+Shift+R) bypasses the cache; otherwise
  expect a long wait after changing the rule.
