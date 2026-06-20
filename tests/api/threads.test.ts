import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the shared LangGraph SDK Client so POST /api/threads can register
// the id it just generated with langgraphjs dev's STORE. Without this the
// runtime's subsequent client.threads.getState / client.runs.stream calls
// 404 because the STORE has never heard of our id.
//
// vi.mock factory is hoisted above this module's imports, so the mock
// function must be created inside the factory and re-exported through the
// mocked module for the rest of the file to assert on.
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
import { POST as POSTTitle } from "@/app/api/threads/[id]/title/route";
import { db } from "@/db/client";
import { threads } from "@/lib/threads/schema";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await db.delete(threads);
  mockCreate.mockClear();
});

describe("GET /api/threads", () => {
  it("returns empty list", async () => {
    const res = await GETList();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.threads).toEqual([]);
  });

  it("returns regular threads, excludes archived", async () => {
    await db.insert(threads).values([
      { id: "a", title: "active" },
      { id: "b", title: "archived", status: "archived" },
    ]);
    const res = await GETList();
    const body = await res.json();
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].id).toBe("a");
  });

  it("includes status, title, id, lastMessageAt in each entry", async () => {
    await db.insert(threads).values({ id: "x", title: "hello" });
    const res = await GETList();
    const { threads: list } = await res.json();
    expect(list[0]).toMatchObject({
      status: "regular",
      id: "x",
      title: "hello",
    });
    expect(list[0].lastMessageAt).toEqual(expect.any(String));
  });
});

describe("POST /api/threads", () => {
  it("creates thread with default title when body is empty", async () => {
    const res = await POSTList(jsonRequest({}));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(body.title).toBe("New chat");
  });

  it("creates thread with provided title", async () => {
    const res = await POSTList(jsonRequest({ title: "My chat" }));
    const body = await res.json();
    expect(body.title).toBe("My chat");
  });

  it("registers the new thread with langgraphjs dev", async () => {
    const res = await POSTList(jsonRequest({}));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // The id we generated must be the one LangGraph STORE registers — and
    // ifExists must be do_nothing so retries are safe.
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: body.id,
        ifExists: "do_nothing",
      }),
    );
  });

  it("rejects empty title", async () => {
    const res = await POSTList(jsonRequest({ title: "" }));
    expect(res.status).toBe(400);
  });

  it("rejects title > 200 chars", async () => {
    const res = await POSTList(jsonRequest({ title: "a".repeat(201) }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/threads/[id]", () => {
  it("returns thread when exists", async () => {
    await db.insert(threads).values({ id: "get-id", title: "got" });
    const res = await GETOne(new Request("http://localhost"), {
      params: Promise.resolve({ id: "get-id" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("get-id");
  });

  it("returns 404 when missing", async () => {
    const res = await GETOne(new Request("http://localhost"), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/threads/[id]", () => {
  it("renames thread", async () => {
    await db.insert(threads).values({ id: "p", title: "old" });
    const res = await PATCHOne(jsonRequest({ title: "new" }), {
      params: Promise.resolve({ id: "p" }),
    });
    expect(res.status).toBe(200);
    const row = await db.query.threads.findFirst({ where: (t, { eq }) => eq(t.id, "p") });
    expect(row?.title).toBe("new");
  });

  it("archives thread", async () => {
    await db.insert(threads).values({ id: "p" });
    const res = await PATCHOne(jsonRequest({ status: "archived" }), {
      params: Promise.resolve({ id: "p" }),
    });
    expect(res.status).toBe(200);
    const row = await db.query.threads.findFirst({ where: (t, { eq }) => eq(t.id, "p") });
    expect(row?.status).toBe("archived");
  });

  it("unarchives thread", async () => {
    await db.insert(threads).values({ id: "p", status: "archived" });
    const res = await PATCHOne(jsonRequest({ status: "regular" }), {
      params: Promise.resolve({ id: "p" }),
    });
    expect(res.status).toBe(200);
    const row = await db.query.threads.findFirst({ where: (t, { eq }) => eq(t.id, "p") });
    expect(row?.status).toBe("regular");
  });

  it("updates custom", async () => {
    await db.insert(threads).values({ id: "p" });
    const res = await PATCHOne(jsonRequest({ custom: { foo: "bar" } }), {
      params: Promise.resolve({ id: "p" }),
    });
    expect(res.status).toBe(200);
    const row = await db.query.threads.findFirst({ where: (t, { eq }) => eq(t.id, "p") });
    expect(row?.custom).toEqual({ foo: "bar" });
  });

  it("returns 404 when missing", async () => {
    const res = await PATCHOne(jsonRequest({ title: "x" }), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects empty body", async () => {
    await db.insert(threads).values({ id: "p" });
    const res = await PATCHOne(jsonRequest({}), { params: Promise.resolve({ id: "p" }) });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/threads/[id]", () => {
  it("removes thread", async () => {
    await db.insert(threads).values({ id: "d" });
    const res = await DELETEOne(new Request("http://localhost"), {
      params: Promise.resolve({ id: "d" }),
    });
    expect(res.status).toBe(204);
    const row = await db.query.threads.findFirst({ where: (t, { eq }) => eq(t.id, "d") });
    expect(row).toBeUndefined();
  });

  it("returns 404 when missing", async () => {
    const res = await DELETEOne(new Request("http://localhost"), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/threads/[id]/title", () => {
  it("returns streaming response with title", async () => {
    await db.insert(threads).values({ id: "t" });
    const res = await POSTTitle(
      jsonRequest({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
      { params: Promise.resolve({ id: "t" }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
  });

  it("rejects empty messages", async () => {
    const res = await POSTTitle(jsonRequest({ messages: [] }), {
      params: Promise.resolve({ id: "t" }),
    });
    expect(res.status).toBe(400);
  });
});
