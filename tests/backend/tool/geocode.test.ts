import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { geocodeLocationTool } from "@/backend/tool/geocode";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("geocodeLocationTool", () => {
  it("serializes a successful geocode result", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        results: [{ name: "Beijing", latitude: 39.9, longitude: 116.4 }],
      }),
    );
    const out = await geocodeLocationTool.invoke({ query: "Beijing" });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(true);
    expect(parsed.result.name).toBe("Beijing");
  });

  it("serializes a failure result with the error message", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { results: [] }));
    const out = await geocodeLocationTool.invoke({ query: "Xyzabc" });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/No results/);
  });

  it("rejects empty query via schema validation", async () => {
    await expect(geocodeLocationTool.invoke({ query: "" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
