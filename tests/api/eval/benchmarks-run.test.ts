import "@/tests/helpers/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentUser } from "@/tests/helpers/session";
import { TEST_USER } from "@/tests/helpers/auth";

const mocks = vi.hoisted(() => {
  return {
    runsWait: vi.fn(),
    threadsCreate: vi.fn(),
    dbSelect: vi.fn(),
    dbInsert: vi.fn(),
  };
});

vi.mock("@/lib/langgraph/client", () => ({
  langGraphClient: {
    runs: { wait: mocks.runsWait },
    threads: { create: mocks.threadsCreate },
  },
}));

vi.mock("@/db/client", () => ({
  db: {
    select: mocks.dbSelect,
    insert: mocks.dbInsert,
  },
}));

const { POST } = await import("@/app/api/eval/benchmarks/run/route");

function request(body: unknown): Request {
  return new Request("http://localhost/api/eval/benchmarks/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function chainSelect(rows: unknown[]) {
  const query: Record<string, unknown> = {};
  query.from = vi.fn().mockReturnValue(query);
  query.where = vi.fn().mockReturnValue(query);
  query.limit = vi.fn().mockResolvedValue(rows);
  return query;
}

function chainInsert() {
  const query: Record<string, unknown> = {};
  query.values = vi.fn().mockReturnValue(query);
  query.onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
  setCurrentUser(TEST_USER);
  mocks.dbInsert.mockReturnValue(chainInsert());
  mocks.threadsCreate.mockResolvedValue(undefined);
});

describe("POST /api/eval/benchmarks/run", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const response = await POST(request({ benchmarkId: "benchmark-1" }), {
      params: Promise.resolve({}),
    });
    expect(response.status).toBe(401);
    expect(mocks.runsWait).not.toHaveBeenCalled();
  });

  it("returns 400 when benchmarkId is missing", async () => {
    const response = await POST(request({}), { params: Promise.resolve({}) });
    expect(response.status).toBe(400);
    expect(mocks.runsWait).not.toHaveBeenCalled();
  });

  it("returns 404 when the benchmark does not exist", async () => {
    mocks.dbSelect.mockReturnValueOnce(chainSelect([]));
    const response = await POST(request({ benchmarkId: "missing" }), {
      params: Promise.resolve({}),
    });
    expect(response.status).toBe(404);
  });

  it("resolves benchmark row and dispatches evalAgent with mode=benchmark", async () => {
    mocks.dbSelect.mockReturnValueOnce(
      chainSelect([
        {
          id: "benchmark-1",
          agent: "chatAgent",
          title: "T",
          inputPrompt: "Hi",
          expectedOutput: "Hello",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    );
    mocks.runsWait.mockResolvedValueOnce({
      runId: "run-1",
      status: "completed",
      errorMessage: null,
    });

    const response = await POST(request({ benchmarkId: "benchmark-1" }), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(200);
    expect(mocks.runsWait).toHaveBeenCalledTimes(1);
    const call = mocks.runsWait.mock.calls[0];
    expect(call).toBeDefined();
    const [threadId, assistantId, payload] = call!;
    expect(assistantId).toBe("evalAgent");
    expect(typeof threadId).toBe("string");
    expect(payload).toMatchObject({
      input: {
        mode: "benchmark",
        targetAgent: "chatAgent",
        inputPrompt: "Hi",
        expectedOutput: "Hello",
      },
    });
    await expect(response.json()).resolves.toMatchObject({
      runId: "run-1",
      result: { status: "completed", errorMessage: null },
    });
  });

  it("returns 500 when the judge run returns no result", async () => {
    mocks.dbSelect.mockReturnValueOnce(
      chainSelect([
        {
          id: "benchmark-1",
          agent: "chatAgent",
          title: "T",
          inputPrompt: "Hi",
          expectedOutput: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    );
    mocks.runsWait.mockResolvedValueOnce(null);

    const response = await POST(request({ benchmarkId: "benchmark-1" }), {
      params: Promise.resolve({}),
    });
    expect(response.status).toBe(500);
  });
});
