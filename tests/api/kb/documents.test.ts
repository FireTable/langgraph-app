import "@/tests/helpers/session";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { attachments, kbDocument, kbFolder, user } from "@/db/schema";
import { setCurrentUser } from "@/tests/helpers/session";

import { GET } from "@/app/api/kb/documents/route";

// ponytail: GET /api/kb/documents — Settings → KB list endpoint.
// Covers auth, the folder grouping shape, the `?folderId=<id>` scope
// filter, and that mention mode ignores `folderId` (composer popover
// is always cross-folder).

const USER_A = { id: "user-a", email: "a@x" };
const USER_B = { id: "user-b", email: "b@x" };

beforeAll(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY ??= "a".repeat(64);
});

async function seedUser(u: { id: string; email: string }) {
  await db
    .insert(user)
    .values({ id: u.id, email: u.email, name: "Test User" })
    .onConflictDoNothing();
}

async function seedFolder(userId: string, id: string, name: string) {
  await db.insert(kbFolder).values({ id, userId, name });
}

async function seedDoc(userId: string, folderId: string, id: string, title: string) {
  await db.insert(kbDocument).values({
    id,
    userId,
    folderId,
    attachmentId: null,
    title,
    contentType: "application/pdf",
    contentHash: `h-${id}`,
    status: "success",
  });
}

beforeEach(async () => {
  await db.delete(kbDocument);
  await db.delete(kbFolder);
  await db.delete(attachments);
  await db.delete(user).where(eq(user.id, USER_A.id));
  await db.delete(user).where(eq(user.id, USER_B.id));
  await seedUser(USER_A);
  await seedUser(USER_B);
  setCurrentUser(USER_A);
});

afterAll(() => {
  setCurrentUser(null);
});

function newRequest(query = ""): Request {
  return new Request(`http://localhost/api/kb/documents${query}`, { method: "GET" });
}

describe("GET /api/kb/documents", () => {
  it("returns 401 when no session", async () => {
    setCurrentUser(null);
    const res = await GET(newRequest(), undefined as never);
    expect(res.status).toBe(401);
  });

  it("returns every folder with full documents when no folderId is given", async () => {
    await seedFolder(USER_A.id, "f-1", "Alpha");
    await seedFolder(USER_A.id, "f-2", "Beta");
    await seedDoc(USER_A.id, "f-1", "d-a1", "alpha-1.pdf");
    await seedDoc(USER_A.id, "f-1", "d-a2", "alpha-2.pdf");
    await seedDoc(USER_A.id, "f-2", "d-b1", "beta-1.pdf");

    const res = await GET(newRequest(), undefined as never);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      groups: Array<{ folder: { id: string; name: string }; documents: Array<{ id: string }> }>;
    };
    expect(body.groups).toHaveLength(2);
    const byFolder = Object.fromEntries(body.groups.map((g) => [g.folder.id, g.documents]));
    expect(byFolder["f-1"].map((d) => d.id).sort()).toEqual(["d-a1", "d-a2"]);
    expect(byFolder["f-2"].map((d) => d.id)).toEqual(["d-b1"]);
  });

  it("returns all folders but only populates documents for ?folderId=<id>", async () => {
    await seedFolder(USER_A.id, "f-1", "Alpha");
    await seedFolder(USER_A.id, "f-2", "Beta");
    await seedDoc(USER_A.id, "f-1", "d-a1", "alpha-1.pdf");
    await seedDoc(USER_A.id, "f-1", "d-a2", "alpha-2.pdf");
    await seedDoc(USER_A.id, "f-2", "d-b1", "beta-1.pdf");

    const res = await GET(newRequest("?folderId=f-1"), undefined as never);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      groups: Array<{ folder: { id: string }; documents: Array<{ id: string }> }>;
    };
    // ponytail: sidebar needs every folder, so the response still
    // lists both — but only the targeted folder has its `documents`
    // populated.
    expect(body.groups).toHaveLength(2);
    const byFolder = Object.fromEntries(body.groups.map((g) => [g.folder.id, g.documents]));
    expect(byFolder["f-1"].map((d) => d.id).sort()).toEqual(["d-a1", "d-a2"]);
    expect(byFolder["f-2"]).toEqual([]);
  });

  it("ignores folderId when it does not match any folder (still lists everything, all docs empty)", async () => {
    await seedFolder(USER_A.id, "f-1", "Alpha");
    await seedDoc(USER_A.id, "f-1", "d-a1", "alpha-1.pdf");

    const res = await GET(newRequest("?folderId=f-ghost"), undefined as never);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      groups: Array<{ folder: { id: string }; documents: Array<unknown> }>;
    };
    expect(body.groups).toHaveLength(1);
    // ponytail: no match → treat as "not scoped to any folder the
    // user owns", so all folders return empty documents rather than
    // 200-ing the wrong set.
    expect(body.groups[0].documents).toEqual([]);
  });

  it("isolates folders across users (USER_B's docs never leak)", async () => {
    await seedFolder(USER_A.id, "f-A", "Mine");
    await seedFolder(USER_B.id, "f-B", "Theirs");
    await seedDoc(USER_A.id, "f-A", "d-mine", "mine.pdf");
    await seedDoc(USER_B.id, "f-B", "d-theirs", "theirs.pdf");

    const res = await GET(newRequest(), undefined as never);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      groups: Array<{ folder: { id: string }; documents: Array<{ id: string }> }>;
    };
    const ids = body.groups.flatMap((g) => g.documents.map((d) => d.id));
    expect(ids).toEqual(["d-mine"]);
    expect(ids).not.toContain("d-theirs");
  });

  it("mention=1 ignores folderId — composer popover stays cross-folder", async () => {
    await seedFolder(USER_A.id, "f-1", "Alpha");
    await seedFolder(USER_A.id, "f-2", "Beta");
    await seedDoc(USER_A.id, "f-1", "d-a1", "alpha-1.pdf");
    await seedDoc(USER_A.id, "f-2", "d-b1", "beta-1.pdf");

    // even though folderId=f-1 is in the URL, mention mode returns docs
    // from every folder so the @-mention popover can search across.
    const res = await GET(newRequest("?mention=1&folderId=f-1"), undefined as never);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      folders: Array<{ id: string; docs: Array<{ id: string }> }>;
    };
    const docIds = body.folders.flatMap((f) => f.docs.map((d) => d.id)).sort();
    expect(docIds).toEqual(["d-a1", "d-b1"]);
  });
});
