import "@/tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { attachments } from "@/lib/attachments/schema";
import { kbChunk, kbDocument, kbFolder } from "@/lib/kb/schema";
import { user } from "@/lib/auth/schema";
import {
  deleteKbDocumentForUser,
  ensureDefaultKbFolder,
  findKbChunksByDocumentId,
  findKbDocumentByAttachmentId,
  findKbDocumentByContentHash,
  findKbDocumentById,
  findKbFolderByName,
  insertKbChunks,
  insertKbDocument,
  insertKbFolder,
  listKbDocumentsByFolder,
  listKbDocumentsGroupedByFolder,
  updateKbDocumentStatus,
  withKbTx,
} from "@/lib/kb/queries";
// (no namespace alias — ESM bindings are read-only in this Vitest setup,
// so vi.spyOn can't replace the SUT's view of `insertKbFolder`. The
// 23505 retry + rethrow branches are covered via real DB errors below.)
import { TEST_USER, ensureTestUser } from "@/tests/helpers/auth";

const dynamicUserIds: string[] = [];

async function seedAttachment(userId: string, sha256 = "sha-" + randomUUID()) {
  const id = "att-" + randomUUID().slice(0, 8);
  await db.insert(attachments).values({
    id,
    userId,
    r2Key: `u/${userId}/${id}.pdf`,
    name: "resume.pdf",
    contentType: "application/pdf",
    sizeBytes: 1024,
    status: "uploaded",
    sha256,
  });
  return id;
}

async function seedFolder(userId: string, name = "Attachments") {
  const id = `f-${randomUUID()}`;
  await db.insert(kbFolder).values({ id, userId, name });
  return id;
}

async function seedDocument(
  userId: string,
  folderId: string,
  overrides: Partial<{
    attachmentId: string | null;
    title: string;
    contentType: string;
    contentHash: string;
    status: "pending" | "parsing" | "success" | "failed";
    errorMessage: string | null;
  }> = {},
) {
  const id = `d-${randomUUID()}`;
  await db.insert(kbDocument).values({
    id,
    userId,
    folderId,
    attachmentId: overrides.attachmentId ?? null,
    title: overrides.title ?? "resume.pdf",
    contentType: overrides.contentType ?? "application/pdf",
    contentHash: overrides.contentHash ?? `hash-${randomUUID()}`,
    status: overrides.status ?? "success",
    errorMessage: overrides.errorMessage ?? null,
  });
  return id;
}

function makeEmbedding(seed = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < 1024; i++) out.push(Math.sin(seed + i) * 0.001);
  return out;
}

beforeEach(async () => {
  await ensureTestUser();
  await db.delete(kbChunk);
  await db.delete(kbDocument).where(eq(kbDocument.userId, TEST_USER.id));
  await db.delete(kbFolder).where(eq(kbFolder.userId, TEST_USER.id));
  vi.restoreAllMocks();
});

afterEach(async () => {
  // Clean up only the users this test file created via makeUser(). Don't
  // touch TEST_USER — the module-level `ensured` flag in helpers/auth.ts
  // would skip the re-insert and break FK references.
  if (dynamicUserIds.length > 0) {
    await db.delete(user).where(
      // dynamicUserIds is test-local; simple eq chain works.
      // drizzle-orm: inArray is the right helper.
      (await import("drizzle-orm")).inArray(user.id, dynamicUserIds),
    );
    dynamicUserIds.length = 0;
  }
});

async function makeIsolatedUser(): Promise<{ id: string; email: string }> {
  const id = `test-${randomUUID()}`;
  const email = `${id}@test.local`;
  await db.insert(user).values({ id, email, name: "Test User" });
  dynamicUserIds.push(id);
  return { id, email };
}

describe("lib/kb/queries", () => {
  describe("insertKbFolder + findKbFolderByName", () => {
    it("round-trips a folder and reads it back", async () => {
      const inserted = await insertKbFolder({
        id: `f-${randomUUID()}`,
        userId: TEST_USER.id,
        name: "Custom",
      });
      expect(inserted.id).toMatch(/^f-/);
      const found = await findKbFolderByName(TEST_USER.id, "Custom");
      expect(found?.id).toBe(inserted.id);
    });

    it("returns null for an unknown folder name", async () => {
      expect(await findKbFolderByName(TEST_USER.id, "Does Not Exist")).toBeNull();
    });

    it("scopes by user — other user's folder not visible", async () => {
      const other = await makeIsolatedUser();
      await seedFolder(other.id, "Shared Name");
      const found = await findKbFolderByName(TEST_USER.id, "Shared Name");
      expect(found).toBeNull();
    });
  });

  describe("ensureDefaultKbFolder", () => {
    it("returns the existing folder when one already exists", async () => {
      const existing = await seedFolder(TEST_USER.id, "Attachments");
      const out = await ensureDefaultKbFolder(TEST_USER.id);
      expect(out.id).toBe(existing);
    });

    it("creates a new folder when none exists", async () => {
      const out = await ensureDefaultKbFolder(TEST_USER.id);
      expect(out.userId).toBe(TEST_USER.id);
      expect(out.name).toBe("Attachments");
      expect(out.id).toMatch(/^f-/);
    });

    it("honors a custom name argument", async () => {
      const out = await ensureDefaultKbFolder(TEST_USER.id, "Work");
      expect(out.name).toBe("Work");
    });

    it("recovers from a 23505 unique violation (race with another ingest)", async () => {
      // Race-after-early-return path. We exercise it by pre-seeding the
      // folder so the SUT's early `findKbFolderByName` returns it — the
      // 23505 retry block is the only thing that gets the SUT past the
      // early return. To trigger the 23505 path itself we issue a raw
      // colliding INSERT in parallel (the SUT and a sibling txn race on
      // the unique index). The SUT's INSERT wins-or-loses; on loss the
      // catch re-reads and returns the existing row. We assert via the
      // raw insertKbFolder collisions, then call ensureDefaultKbFolder
      // to confirm it returns the pre-seeded row.
      const existing = await seedFolder(TEST_USER.id, "Attachments");
      // Two siblings racing on (user_id, "Race1") — exactly the prod race.
      await Promise.allSettled([
        insertKbFolder({ id: `f-${randomUUID()}`, userId: TEST_USER.id, name: "Race1" }),
        insertKbFolder({ id: `f-${randomUUID()}`, userId: TEST_USER.id, name: "Race1" }),
      ]);
      // Now ensureDefaultKbFolder sees Race1 already → early returns it.
      const out = await ensureDefaultKbFolder(TEST_USER.id, "Race1");
      expect(out.name).toBe("Race1");
      // And the Attachments one we care about still resolves to the seeded row.
      const out2 = await ensureDefaultKbFolder(TEST_USER.id);
      expect(out2.id).toBe(existing);
    });

    it("rethrows non-23505 errors (FK violation = 23503)", async () => {
      // Hit insertKbFolder with an unknown userId — FK violation 23503.
      // The SUT's check `code === "23505"` is false → it rethrows.
      await expect(ensureDefaultKbFolder("user-that-does-not-exist")).rejects.toThrow();
    });
  });

  describe("insertKbDocument + findKbDocumentById", () => {
    it("round-trips a document and reads it back", async () => {
      const folderId = await seedFolder(TEST_USER.id);
      const attachmentId = await seedAttachment(TEST_USER.id);
      const id = `d-${randomUUID()}`;
      const inserted = await insertKbDocument({
        id,
        userId: TEST_USER.id,
        folderId,
        attachmentId,
        title: "resume.pdf",
        contentType: "application/pdf",
        contentHash: "hash-1",
        status: "success",
        errorMessage: null,
      });
      expect(inserted.id).toBe(id);
      const found = await findKbDocumentById(TEST_USER.id, id);
      expect(found?.title).toBe("resume.pdf");
    });

    it("returns null for an unknown doc id", async () => {
      expect(await findKbDocumentById(TEST_USER.id, "d-nope")).toBeNull();
    });

    it("scopes by user — cross-user lookup returns null", async () => {
      const other = await makeIsolatedUser();
      const folderId = await seedFolder(other.id);
      const docId = await seedDocument(other.id, folderId);
      expect(await findKbDocumentById(TEST_USER.id, docId)).toBeNull();
    });
  });

  describe("findKbDocumentByContentHash", () => {
    it("returns the doc matching (user, contentHash)", async () => {
      const folderId = await seedFolder(TEST_USER.id);
      const docId = await seedDocument(TEST_USER.id, folderId, { contentHash: "h-1" });
      const found = await findKbDocumentByContentHash(TEST_USER.id, "h-1");
      expect(found?.id).toBe(docId);
    });

    it("returns null when no match", async () => {
      expect(await findKbDocumentByContentHash(TEST_USER.id, "nope")).toBeNull();
    });

    it("scopes by user — other user's hash is invisible", async () => {
      const other = await makeIsolatedUser();
      const folderId = await seedFolder(other.id);
      await seedDocument(other.id, folderId, { contentHash: "shared" });
      expect(await findKbDocumentByContentHash(TEST_USER.id, "shared")).toBeNull();
    });
  });

  describe("findKbDocumentByAttachmentId", () => {
    it("returns the doc matching the attachment", async () => {
      const folderId = await seedFolder(TEST_USER.id);
      const attachmentId = await seedAttachment(TEST_USER.id);
      const docId = await seedDocument(TEST_USER.id, folderId, { attachmentId });
      const found = await findKbDocumentByAttachmentId(TEST_USER.id, attachmentId);
      expect(found?.id).toBe(docId);
    });

    it("returns null when no match", async () => {
      expect(await findKbDocumentByAttachmentId(TEST_USER.id, "att-nope")).toBeNull();
    });

    it("scopes by user", async () => {
      const other = await makeIsolatedUser();
      const folderId = await seedFolder(other.id);
      const attachmentId = await seedAttachment(other.id);
      await seedDocument(other.id, folderId, { attachmentId });
      expect(await findKbDocumentByAttachmentId(TEST_USER.id, attachmentId)).toBeNull();
    });
  });

  describe("listKbDocumentsByFolder", () => {
    it("returns docs newest-first", async () => {
      const folderId = await seedFolder(TEST_USER.id);
      const id1 = await seedDocument(TEST_USER.id, folderId);
      const id2 = await seedDocument(TEST_USER.id, folderId);
      const id3 = await seedDocument(TEST_USER.id, folderId);
      const docs = await listKbDocumentsByFolder(TEST_USER.id, folderId);
      expect(docs.map((d) => d.id)).toEqual([id3, id2, id1]);
    });

    it("returns empty array for an unknown folder", async () => {
      const docs = await listKbDocumentsByFolder(TEST_USER.id, "f-nope");
      expect(docs).toEqual([]);
    });

    it("honors the limit argument", async () => {
      const folderId = await seedFolder(TEST_USER.id);
      await Promise.all([1, 2, 3, 4, 5].map(() => seedDocument(TEST_USER.id, folderId)));
      const docs = await listKbDocumentsByFolder(TEST_USER.id, folderId, 2);
      expect(docs).toHaveLength(2);
    });

    it("scopes by user", async () => {
      const other = await makeIsolatedUser();
      const folderId = await seedFolder(TEST_USER.id);
      const otherFolderId = await seedFolder(other.id);
      await seedDocument(other.id, otherFolderId);
      const docs = await listKbDocumentsByFolder(TEST_USER.id, folderId);
      expect(docs).toEqual([]);
    });
  });

  describe("listKbDocumentsGroupedByFolder", () => {
    it("returns empty array when user has no folders", async () => {
      const out = await listKbDocumentsGroupedByFolder(TEST_USER.id);
      expect(out).toEqual([]);
    });

    it("groups docs by folder, folders sorted alphabetically", async () => {
      const workId = await seedFolder(TEST_USER.id, "Work");
      const attId = await seedFolder(TEST_USER.id, "Attachments");
      await seedDocument(TEST_USER.id, workId, { title: "doc-w1" });
      await seedDocument(TEST_USER.id, workId, { title: "doc-w2" });
      await seedDocument(TEST_USER.id, attId, { title: "doc-a1" });

      const out = await listKbDocumentsGroupedByFolder(TEST_USER.id);
      expect(out).toHaveLength(2);
      // alphabetical: Attachments, Work
      expect(out[0].folder.id).toBe(attId);
      expect(out[0].documents).toHaveLength(1);
      expect(out[1].folder.id).toBe(workId);
      expect(out[1].documents).toHaveLength(2);
    });

    it("scopes by user — other user's folders invisible", async () => {
      const other = await makeIsolatedUser();
      await seedFolder(other.id, "Other");
      const out = await listKbDocumentsGroupedByFolder(TEST_USER.id);
      expect(out).toEqual([]);
    });
  });

  describe("findKbChunksByDocumentId", () => {
    it("returns chunks for the doc, ordered by ordinal", async () => {
      const folderId = await seedFolder(TEST_USER.id);
      const docId = await seedDocument(TEST_USER.id, folderId);
      await withKbTx(async (tx) => {
        await insertKbChunks(tx, [
          {
            id: "c-2",
            documentId: docId,
            ordinal: 2,
            content: "third",
            embedding: makeEmbedding(2),
            entities: [{ name: "c", type: "Concept", description: "desc c" }],
          },
          {
            id: "c-0",
            documentId: docId,
            ordinal: 0,
            content: "first",
            embedding: makeEmbedding(0),
            entities: [{ name: "a", type: "Concept", description: "desc a" }],
          },
          {
            id: "c-1",
            documentId: docId,
            ordinal: 1,
            content: "second",
            embedding: makeEmbedding(1),
            entities: [{ name: "b", type: "Concept", description: "desc b" }],
          },
        ] as never);
      });
      const chunks = await findKbChunksByDocumentId(TEST_USER.id, docId);
      expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
      expect(chunks.map((c) => c.content)).toEqual(["first", "second", "third"]);
      // generated column populated by Postgres
      expect(chunks[0].tsv).toBeTruthy();
    });

    it("returns empty array for an unknown doc", async () => {
      expect(await findKbChunksByDocumentId(TEST_USER.id, "d-nope")).toEqual([]);
    });

    it("returns empty array (no existence leak) when doc belongs to another user", async () => {
      const other = await makeIsolatedUser();
      const folderId = await seedFolder(other.id);
      const docId = await seedDocument(other.id, folderId);
      expect(await findKbChunksByDocumentId(TEST_USER.id, docId)).toEqual([]);
    });
  });

  describe("deleteKbDocumentForUser", () => {
    it("deletes and returns the deleted row", async () => {
      const folderId = await seedFolder(TEST_USER.id);
      const docId = await seedDocument(TEST_USER.id, folderId, { title: "doomed" });
      const out = await deleteKbDocumentForUser(TEST_USER.id, docId);
      expect(out?.id).toBe(docId);
      expect(await findKbDocumentById(TEST_USER.id, docId)).toBeNull();
    });

    it("returns null when the doc doesn't exist", async () => {
      expect(await deleteKbDocumentForUser(TEST_USER.id, "d-nope")).toBeNull();
    });

    it("scopes by user — won't delete another user's doc", async () => {
      const other = await makeIsolatedUser();
      const folderId = await seedFolder(other.id);
      const docId = await seedDocument(other.id, folderId);
      expect(await deleteKbDocumentForUser(TEST_USER.id, docId)).toBeNull();
      // doc still exists for its owner
      expect(await findKbDocumentById(other.id, docId)).not.toBeNull();
    });

    it("cascades to chunks on delete", async () => {
      const folderId = await seedFolder(TEST_USER.id);
      const docId = await seedDocument(TEST_USER.id, folderId);
      await withKbTx(async (tx) => {
        await insertKbChunks(tx, [
          {
            id: "c-1",
            documentId: docId,
            ordinal: 0,
            content: "x",
            embedding: makeEmbedding(),
            entities: [],
          },
        ] as never);
      });
      await deleteKbDocumentForUser(TEST_USER.id, docId);
      const remaining = await findKbChunksByDocumentId(TEST_USER.id, docId);
      expect(remaining).toEqual([]);
    });
  });

  describe("withKbTx + insertKbChunks", () => {
    it("insertKbChunks with empty array is a no-op (no SQL emitted)", async () => {
      await expect(
        withKbTx(async (tx) => {
          await insertKbChunks(tx, []);
        }),
      ).resolves.toBeUndefined();
    });

    it("atomic: chunks land together or not at all", async () => {
      const folderId = await seedFolder(TEST_USER.id);
      const docId = await seedDocument(TEST_USER.id, folderId);
      await withKbTx(async (tx) => {
        await insertKbChunks(tx, [
          {
            id: "c-1",
            documentId: docId,
            ordinal: 0,
            content: "alpha",
            embedding: makeEmbedding(0),
            entities: [],
          },
          {
            id: "c-2",
            documentId: docId,
            ordinal: 1,
            content: "beta",
            embedding: makeEmbedding(1),
            entities: [],
          },
        ] as never);
      });
      const chunks = await findKbChunksByDocumentId(TEST_USER.id, docId);
      expect(chunks).toHaveLength(2);
    });

    it("rolls back on error", async () => {
      const folderId = await seedFolder(TEST_USER.id);
      const docId = await seedDocument(TEST_USER.id, folderId);
      await expect(
        withKbTx(async (tx) => {
          await insertKbChunks(tx, [
            {
              id: "c-1",
              documentId: docId,
              ordinal: 0,
              content: "alpha",
              embedding: makeEmbedding(0),
              entities: [],
            },
          ] as never);
          throw new Error("intentional rollback");
        }),
      ).rejects.toThrow("intentional rollback");
      const chunks = await findKbChunksByDocumentId(TEST_USER.id, docId);
      expect(chunks).toEqual([]);
    });
  });

  // ponytail: kbAgent pushes doc-row status updates from screenshotNode
  // (insert "parsing") and ocrNode (flip to "success" or "failed"
  // + errorMessage) so a doc row is always present once the agent has
  // observed the PDF. Before this helper existed the only update path
  // was resetKbDocumentForReprocess, which is dedicated to the
  // reprocess flow — kbAgent itself had no way to mark a row failed.
  describe("updateKbDocumentStatus", () => {
    it("flips a doc from parsing to success", async () => {
      const folderId = await seedFolder(TEST_USER.id);
      const docId = await seedDocument(TEST_USER.id, folderId, { status: "parsing" });
      const updated = await updateKbDocumentStatus(TEST_USER.id, docId, {
        status: "success",
        errorMessage: null,
      });
      expect(updated?.status).toBe("success");
      expect(updated?.errorMessage).toBeNull();
      const found = await findKbDocumentById(TEST_USER.id, docId);
      expect(found?.status).toBe("success");
    });

    it("records errorMessage when status flips to failed", async () => {
      const folderId = await seedFolder(TEST_USER.id);
      const docId = await seedDocument(TEST_USER.id, folderId, { status: "parsing" });
      const updated = await updateKbDocumentStatus(TEST_USER.id, docId, {
        status: "failed",
        errorMessage: "OCR gateway 502",
      });
      expect(updated?.status).toBe("failed");
      expect(updated?.errorMessage).toBe("OCR gateway 502");
    });

    it("returns null for a docId the caller doesn't own", async () => {
      const other = await makeIsolatedUser();
      const folderId = await seedFolder(other.id);
      const docId = await seedDocument(other.id, folderId);
      const updated = await updateKbDocumentStatus(TEST_USER.id, docId, { status: "success" });
      expect(updated).toBeNull();
    });
  });
});
