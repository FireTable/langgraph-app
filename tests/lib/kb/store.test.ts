import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteKbDoc,
  listKbDocs,
  readKbDoc,
  setKbStoreRoot,
  writeKbDoc,
  type KbDocRecord,
} from "@/lib/kb/store";

// ponytail: every test gets its own root so concurrent runs (CI
// parallelism, --no-file-parallelism off) don't trip on shared state.
// mkdtempSync guarantees a fresh, empty directory per test.
let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kb-store-test-"));
  setKbStoreRoot(root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixture(over: Partial<KbDocRecord> = {}): KbDocRecord {
  return {
    id: "doc-1",
    userId: "user-a",
    attachmentId: "att-1",
    sourceUrl: null,
    title: "test.pdf",
    contentType: "application/pdf",
    status: "ready",
    contentHash: "abc123",
    errorMessage: null,
    pages: [{ pageIndex: 0, markdown: "hello", imagePath: "/tmp/page-0.png" }],
    chunks: [{ id: "c-0", ordinal: 0, content: "hello", embedding: [0.1, 0.2], entities: [] }],
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...over,
  };
}

describe("writeKbDoc / readKbDoc", () => {
  it("round-trips a record under per-user path", async () => {
    const rec = fixture();
    await writeKbDoc(rec);
    const back = await readKbDoc({ userId: "user-a", docId: "doc-1" });
    expect(back).toEqual(rec);
  });

  it("returns null when the doc doesn't exist", async () => {
    const back = await readKbDoc({ userId: "user-a", docId: "missing" });
    expect(back).toBeNull();
  });

  it("returns null when caller is a different user (per-user isolation)", async () => {
    await writeKbDoc(fixture({ userId: "user-a", id: "doc-1" }));
    const back = await readKbDoc({ userId: "user-b", docId: "doc-1" });
    expect(back).toBeNull();
  });

  it("atomic write: no .tmp left behind on success", async () => {
    await writeKbDoc(fixture());
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(join(root, "user-a"));
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(files).toContain("doc-1.json");
  });
});

describe("listKbDocs", () => {
  it("lists all docs for a user, sorted by createdAt desc", async () => {
    await writeKbDoc(
      fixture({
        id: "doc-1",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
      }),
    );
    await writeKbDoc(
      fixture({
        id: "doc-2",
        createdAt: "2026-07-14T00:01:00.000Z",
        updatedAt: "2026-07-14T00:01:00.000Z",
      }),
    );
    await writeKbDoc(
      fixture({
        id: "doc-3",
        createdAt: "2026-07-14T00:02:00.000Z",
        updatedAt: "2026-07-14T00:02:00.000Z",
      }),
    );

    const list = await listKbDocs({ userId: "user-a" });
    expect(list.map((d) => d.id)).toEqual(["doc-3", "doc-2", "doc-1"]);
  });

  it("does not include another user's docs", async () => {
    await writeKbDoc(fixture({ userId: "user-a", id: "doc-a" }));
    await writeKbDoc(fixture({ userId: "user-b", id: "doc-b" }));

    const aList = await listKbDocs({ userId: "user-a" });
    const bList = await listKbDocs({ userId: "user-b" });
    expect(aList.map((d) => d.id)).toEqual(["doc-a"]);
    expect(bList.map((d) => d.id)).toEqual(["doc-b"]);
  });

  it("returns [] for a user with no docs", async () => {
    const list = await listKbDocs({ userId: "ghost" });
    expect(list).toEqual([]);
  });
});

describe("deleteKbDoc", () => {
  it("removes the file", async () => {
    await writeKbDoc(fixture());
    await deleteKbDoc({ userId: "user-a", docId: "doc-1" });
    const back = await readKbDoc({ userId: "user-a", docId: "doc-1" });
    expect(back).toBeNull();
  });

  it("is a no-op for a missing doc", async () => {
    await expect(deleteKbDoc({ userId: "user-a", docId: "missing" })).resolves.toBeUndefined();
  });

  it("refuses to delete another user's doc (idempotent no-op)", async () => {
    await writeKbDoc(fixture({ userId: "user-a", id: "doc-1" }));
    await deleteKbDoc({ userId: "user-b", docId: "doc-1" });
    const back = await readKbDoc({ userId: "user-a", docId: "doc-1" });
    expect(back).not.toBeNull();
  });
});
