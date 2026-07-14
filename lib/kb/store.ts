import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Ponytail: v1 KB storage — JSON files under .kb-store/. We ship DB tables
 * in v2 once the schema stabilizes; for now we want a zero-infra path to
 * validate the pipeline end-to-end. The store shape is intentionally
 * narrow (one record = one document) so the v2 migration is a 1:1 row
 * dump from .kb-store/<userId>/<docId>.json into kb_document + kb_chunk.
 */

export type KbChunkRecord = {
  id: string;
  ordinal: number;
  content: string;
  embedding: number[];
  entities: string[];
};

export type KbPageRecord = {
  pageIndex: number;
  markdown: string;
  // ponytail: local path to the rendered PNG on disk. V1 keeps the image
  // alongside the JSON so a future "view the page" affordance is free.
  imagePath: string;
};

export type KbDocStatus = "pending" | "parsing" | "ready" | "failed";

export type KbDocRecord = {
  id: string;
  userId: string;
  attachmentId: string | null;
  sourceUrl: string | null;
  title: string;
  contentType: string;
  status: KbDocStatus;
  contentHash: string;
  errorMessage: string | null;
  pages: KbPageRecord[];
  chunks: KbChunkRecord[];
  createdAt: string;
  updatedAt: string;
};

// ponytail: root is settable so tests can mkdtemp their own scratch dir
// without monkey-patching process.cwd. Default to <cwd>/.kb-store/ so dev
// data persists across server restarts. KB_STORE_ROOT env override for
// containerized deploys.
let storeRoot = process.env.KB_STORE_ROOT ?? join(process.cwd(), ".kb-store");
export function setKbStoreRoot(p: string): void {
  storeRoot = p;
}
export function getKbStoreRoot(): string {
  return storeRoot;
}

function docPath(userId: string, docId: string): string {
  // ponytail: per-user subdir is the only isolation boundary. Cross-user
  // read attempts reach a different path → ENOENT → null. Cheap, no auth
  // lookup needed; the userId itself is the auth check (caller already
  // authenticated).
  return join(storeRoot, userId, `${docId}.json`);
}

function userDir(userId: string): string {
  return join(storeRoot, userId);
}

export async function writeKbDoc(rec: KbDocRecord): Promise<void> {
  if (!rec.id || !rec.userId) {
    throw new Error("KbDocRecord requires id and userId");
  }
  const finalPath = docPath(rec.userId, rec.id);
  const tmpPath = `${finalPath}.tmp`;
  await mkdir(userDir(rec.userId), { recursive: true });
  // ponytail: writeFile+rename is atomic on POSIX. A crash between the
  // two leaves a .tmp behind; the next successful write overwrites the
  // tmp atomically so we never observe a half-written JSON.
  await writeFile(tmpPath, JSON.stringify(rec, null, 2), "utf8");
  await rename(tmpPath, finalPath);
}

export async function readKbDoc(args: {
  userId: string;
  docId: string;
}): Promise<KbDocRecord | null> {
  const path = docPath(args.userId, args.docId);
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as KbDocRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function listKbDocs(args: { userId: string }): Promise<KbDocRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(userDir(args.userId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const docs = await Promise.all(
    entries
      .filter((e) => e.endsWith(".json") && !e.endsWith(".tmp"))
      .map(async (e) => {
        const raw = await readFile(join(userDir(args.userId), e), "utf8");
        return JSON.parse(raw) as KbDocRecord;
      }),
  );
  // ponytail: sort by createdAt desc so the UI gets stable recency
  // ordering without a second pass. ISO strings sort lex-correctly.
  docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return docs;
}

export async function deleteKbDoc(args: { userId: string; docId: string }): Promise<void> {
  // ponytail: missing file is a no-op (matches the user-facing "delete"
  // affordance — already gone is fine). Cross-user delete: the path is
  // namespaced by userId, so passing the wrong userId never reaches the
  // victim's file. Caller can't fake userId (it's the session value).
  try {
    await rm(docPath(args.userId, args.docId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
