import "@/tests/helpers/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentUser } from "@/tests/helpers/session";
import { TEST_USER } from "@/tests/helpers/auth";

const mockRunBenchmark = vi.fn();

vi.mock("@/lib/eval/benchmark-runner", () => ({
  runBenchmark: mockRunBenchmark,
  BenchmarkNotFoundError: class BenchmarkNotFoundError extends Error {
    constructor() {
      super("BENCHMARK_NOT_FOUND");
      this.name = "BenchmarkNotFoundError";
    }
  },
}));

const { runBenchmark } = await import("@/lib/eval/benchmark-runner");
const { POST } = await import("@/app/api/eval/benchmarks/run/route");

function request(body: unknown): Request {
  return new Request("http://localhost/api/eval/benchmarks/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setCurrentUser(TEST_USER);
});

describe("POST /api/eval/benchmarks/run", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);

    const response = await POST(request({ benchmarkId: "benchmark-1" }), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(401);
    expect(runBenchmark).not.toHaveBeenCalled();
  });

  it("returns 400 when benchmarkId is missing", async () => {
    const response = await POST(request({}), { params: Promise.resolve({}) });

    expect(response.status).toBe(400);
    expect(runBenchmark).not.toHaveBeenCalled();
  });

  it("returns 404 when the benchmark does not exist", async () => {
    const { BenchmarkNotFoundError } = await import("@/lib/eval/benchmark-runner");
    mockRunBenchmark.mockRejectedValueOnce(new BenchmarkNotFoundError());

    const response = await POST(request({ benchmarkId: "missing" }), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(404);
  });

  it("runs and judges a benchmark", async () => {
    mockRunBenchmark.mockResolvedValueOnce({
      runId: "run-1",
      threadId: "thread-1",
      judgeThreadId: "judge-thread-1",
      result: { status: "completed", errorMessage: null },
    });

    const response = await POST(request({ benchmarkId: "benchmark-1" }), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(200);
    expect(runBenchmark).toHaveBeenCalledWith({
      benchmarkId: "benchmark-1",
      userId: TEST_USER.id,
    });
    await expect(response.json()).resolves.toMatchObject({ runId: "run-1" });
  });

  it("returns 500 when execution fails", async () => {
    mockRunBenchmark.mockRejectedValueOnce(new Error("model unavailable"));

    const response = await POST(request({ benchmarkId: "benchmark-1" }), {
      params: Promise.resolve({}),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "model unavailable" });
  });
});
