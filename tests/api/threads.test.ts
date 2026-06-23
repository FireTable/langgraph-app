import "@/tests/helpers/session";
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";

// Mock the shared LangGraph SDK Client so POST /api/threads can register
// the new id with langgraphjs dev's STORE. Without this the runtime's
// subsequent client.threads.getState / client.runs.stream calls 404.
vi.mock("@/lib/langgraph/client", () => ({
  langGraphClient: { threads: { create: vi.fn(async () => ({ thread_id: "ignored" })) } },
}));
import { langGraphClient } from "@/lib/langgraph/client";
const mockCreate = vi.mocked(langGraphClient.threads.create);

import { POST as POSTList, GET as GETList } from "@/app/api/threads/route";
import {
  GET as GETOne,
  PATCH as PATCHOne,
  DELETE as DELETEOne,
} from "@/app/api/threads/[id]/route";
import { db } from "@/db/client";
import { threads } from "@/lib/threads/schema";
import { user } from "@/lib/auth/schema";
import { setCurrentUser } from "@/tests/helpers/session";
import { makeUser, cleanupUsers, ensureTestUser, TEST_USER } from "@/tests/helpers/auth";

const owner = TEST_USER.id;

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await ensureTestUser();
});

beforeEach(async () => {
  await db.delete(threads);
  mockCreate.mockClear();
  setCurrentUser({ id: owner, email: TEST_USER.email });
});

afterAll(async () => {
  await cleanupUsers();
  setCurrentUser(null);
});

describe("GET /api/threads — auth + isolation", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await GETList(new Request("http://localhost"), {
      params: Promise.resolve(undefined as never),
    });
    expect(res.status).toBe(401);
  });

  it("returns only the current user's threads (FR-018)", async () => {
    const other = await makeUser();
    await db.insert(threads).values([
      { id: "mine", userId: owner, title: "mine" },
      { id: "theirs", userId: other.id, title: "theirs" },
    ]);
    const res = await GETList(new Request("http://localhost"), {
      params: Promise.resolve(undefined as never),
    });
    const body = await res.json();
    expect(body.threads.map((t: { id: string }) => t.id)).toEqual(["mine"]);
  });

  it("excludes archived rows", async () => {
    await db.insert(threads).values([
      { id: "a", userId: owner, title: "active" },
      { id: "b", userId: owner, title: "archived", status: "archived" },
    ]);
    const res = await GETList(new Request("http://localhost"), {
      params: Promise.resolve(undefined as never),
    });
    const body = await res.json();
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].id).toBe("a");
  });
});

describe("POST /api/threads", () => {
  const routeCtx = { params: Promise.resolve(undefined as never) };

  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await POSTList(jsonRequest({}), routeCtx);
    expect(res.status).toBe(401);
  });

  it("creates thread with default title and binds userId", async () => {
    const res = await POSTList(jsonRequest({}), routeCtx);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(body.title).toBe("New Chat");
    const row = await db.query.threads.findFirst({ where: (t, { eq }) => eq(t.id, body.id) });
    expect(row?.userId).toBe(owner);
  });

  it("creates thread with provided title", async () => {
    const res = await POSTList(jsonRequest({ title: "My chat" }), routeCtx);
    const body = await res.json();
    expect(body.title).toBe("My chat");
  });

  it("registers the new thread with langgraphjs dev", async () => {
    const res = await POSTList(jsonRequest({}), routeCtx);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: body.id, ifExists: "do_nothing" }),
    );
  });

  it("rejects empty title", async () => {
    const res = await POSTList(jsonRequest({ title: "" }), routeCtx);
    expect(res.status).toBe(400);
  });

  it("rejects title > 200 chars", async () => {
    const res = await POSTList(jsonRequest({ title: "a".repeat(201) }), routeCtx);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/threads/[id] — ownership (FR-019)", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const res = await GETOne(new Request("http://localhost"), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns thread when owned", async () => {
    await db.insert(threads).values({ id: "get-id", userId: owner, title: "got" });
    const res = await GETOne(new Request("http://localhost"), {
      params: Promise.resolve({ id: "get-id" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 404 for another user's thread (no existence leak)", async () => {
    const other = await makeUser();
    await db.insert(threads).values({ id: "theirs", userId: other.id, title: "x" });
    const res = await GETOne(new Request("http://localhost"), {
      params: Promise.resolve({ id: "theirs" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when missing", async () => {
    const res = await GETOne(new Request("http://localhost"), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/threads/[id]", () => {
  it("renames owned thread", async () => {
    await db.insert(threads).values({ id: "p", userId: owner, title: "old" });
    const res = await PATCHOne(jsonRequest({ title: "new" }), {
      params: Promise.resolve({ id: "p" }),
    });
    expect(res.status).toBe(200);
    const row = await db.query.threads.findFirst({ where: (t, { eq }) => eq(t.id, "p") });
    expect(row?.title).toBe("new");
  });

  it("archives owned thread", async () => {
    await db.insert(threads).values({ id: "p", userId: owner });
    const res = await PATCHOne(jsonRequest({ status: "archived" }), {
      params: Promise.resolve({ id: "p" }),
    });
    expect(res.status).toBe(200);
    const row = await db.query.threads.findFirst({ where: (t, { eq }) => eq(t.id, "p") });
    expect(row?.status).toBe("archived");
  });

  it("returns 404 for another user's thread", async () => {
    const other = await makeUser();
    await db.insert(threads).values({ id: "theirs", userId: other.id });
    const res = await PATCHOne(jsonRequest({ title: "x" }), {
      params: Promise.resolve({ id: "theirs" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects empty body", async () => {
    await db.insert(threads).values({ id: "p", userId: owner });
    const res = await PATCHOne(jsonRequest({}), { params: Promise.resolve({ id: "p" }) });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/threads/[id]", () => {
  it("removes owned thread", async () => {
    await db.insert(threads).values({ id: "d", userId: owner });
    const res = await DELETEOne(new Request("http://localhost"), {
      params: Promise.resolve({ id: "d" }),
    });
    expect(res.status).toBe(204);
  });

  it("returns 404 for another user's thread", async () => {
    const other = await makeUser();
    await db.insert(threads).values({ id: "theirs", userId: other.id });
    const res = await DELETEOne(new Request("http://localhost"), {
      params: Promise.resolve({ id: "theirs" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("user deletion cascade (FR-021)", () => {
  it("removes the user's threads when the user is deleted", async () => {
    const u = await makeUser();
    await db.insert(threads).values({ id: "owned", userId: u.id, title: "gone" });
    await db.delete(user).where(eq(user.id, u.id));
    const row = await db.query.threads.findFirst({ where: (t, { eq }) => eq(t.id, "owned") });
    expect(row).toBeUndefined();
  });
});
