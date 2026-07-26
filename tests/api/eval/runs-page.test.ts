import "@/tests/helpers/session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentUser } from "@/tests/helpers/session";
import { TEST_USER } from "@/tests/helpers/auth";

const mockGetRunsByAgentPage = vi.fn();

vi.mock("@/lib/eval/queries", async () => {
  const actual = await vi.importActual<typeof import("@/lib/eval/queries")>("@/lib/eval/queries");
  return {
    ...actual,
    getRunsByAgentPage: mockGetRunsByAgentPage,
  };
});

const { GET } = await import("@/app/api/eval/runs/page/route");

function request(url: string): Request {
  return new Request(url, { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  setCurrentUser({ ...TEST_USER, roleId: "admin" });
});

describe("GET /api/eval/runs/page", () => {
  it("returns 401 when unauthenticated", async () => {
    setCurrentUser(null);
    const response = await GET(request("http://localhost/api/eval/runs/page?agent=chatAgent"), {
      params: Promise.resolve({}),
    });
    expect(response.status).toBe(401);
    expect(mockGetRunsByAgentPage).not.toHaveBeenCalled();
  });

  it("returns 400 when agent is missing", async () => {
    const response = await GET(request("http://localhost/api/eval/runs/page"), {
      params: Promise.resolve({}),
    });
    expect(response.status).toBe(400);
    expect(mockGetRunsByAgentPage).not.toHaveBeenCalled();
  });

  it("forwards the cursor + limit and returns the page payload", async () => {
    mockGetRunsByAgentPage.mockResolvedValueOnce({
      runs: [{ id: "run-1" }],
      hasMore: true,
      nextCursorId: "run-1",
    });

    const response = await GET(
      request("http://localhost/api/eval/runs/page?agent=chatAgent&cursor=run-0&limit=5"),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(200);
    expect(mockGetRunsByAgentPage).toHaveBeenCalledWith({
      agent: "chatAgent",
      cursorId: "run-0",
      limit: 5,
    });
    await expect(response.json()).resolves.toMatchObject({
      agent: "chatAgent",
      hasMore: true,
      nextCursor: "run-1",
    });
  });

  it("defaults the limit to 5 when not supplied", async () => {
    mockGetRunsByAgentPage.mockResolvedValueOnce({
      runs: [],
      hasMore: false,
      nextCursorId: null,
    });

    await GET(request("http://localhost/api/eval/runs/page?agent=chatAgent"), {
      params: Promise.resolve({}),
    });

    expect(mockGetRunsByAgentPage).toHaveBeenCalledWith({
      agent: "chatAgent",
      cursorId: null,
      limit: 5,
    });
  });
});
