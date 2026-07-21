// ponytail: short URL-safe id (~62 bits of entropy at ID_LEN=12 with
// the 36-char alphabet). Used as the PK for the `attachments` table
// and (historically) any other place where a DB-row token needs to be
// unguessable but short enough to embed in URLs.
//
// History: originally inlined into each route that needed it
// (chat-attachment presign, KB URL upload, avatar presign). Avatar
// stopped needing it once its R2 key became a fixed slot — that copy
// is gone. The chat-attachment + KB upload copies survived because
// they both still write `attachments` rows whose PK is this id. After
// the R2 CAS refactor this id is the row token, NOT part of the R2
// key (which is content-addressed via sha256 in `lib/r2/keys.ts`).
//
// Why not the actual `nanoid` package: project preference. Threads
// use UUID instead (lib/threads/queries.ts — the LangGraph HTTP API
// requires UUIDs in its zod schemas). Short id here is local to
// `attachments` and stays in-house.

import { randomBytes } from "node:crypto";

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LEN = 12;

// ponytail: modulo bias is negligible at this alphabet length (62
// bits of entropy / 6 bits per byte = ~10x oversampling). Rejection
// sampling would slow this down for no perceptible gain — the
// nanoid package does it because it picks longer ids where bias
// compounds.
export function generateId(): string {
  const bytes = randomBytes(ID_LEN);
  let out = "";
  for (let i = 0; i < ID_LEN; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}
