import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  // Module-level cache leaks between tests; force a fresh import.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function loadTool() {
  const mod = await import("@/backend/tool/crypto/get-fx-rate");
  return mod.getFxRateTool;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getFxRateTool", () => {
  it("calls frankfurter with from/to codes and returns the rate + date", async () => {
    const getFxRateTool = await loadTool();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { amount: 1, base: "USD", date: "2026-06-25", rates: { CNY: 7.1834 } }),
    );
    const out = await getFxRateTool.invoke({ from: "USD", to: "CNY" });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(true);
    expect(parsed.from).toBe("USD");
    expect(parsed.to).toBe("CNY");
    expect(parsed.rate).toBe(7.1834);
    expect(parsed.date).toBe("2026-06-25");
  });

  it("uppercases codes in the URL so 'cny' and 'CNY' hit the same cache key", async () => {
    const getFxRateTool = await loadTool();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { amount: 1, base: "USD", date: "2026-06-25", rates: { CNY: 7.18 } }),
    );
    await getFxRateTool.invoke({ from: "usd", to: "cny" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("from=USD");
    expect(url).toContain("to=CNY");
  });

  it("returns the same payload on a cache hit without a second fetch call", async () => {
    const getFxRateTool = await loadTool();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { amount: 1, base: "USD", date: "2026-06-25", rates: { EUR: 0.92 } }),
    );
    await getFxRateTool.invoke({ from: "USD", to: "EUR" });
    await getFxRateTool.invoke({ from: "USD", to: "EUR" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates 4xx/5xx as a serialized error result", async () => {
    const getFxRateTool = await loadTool();
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: "not found" }));
    const out = await getFxRateTool.invoke({ from: "USD", to: "ZZZ" });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/404/);
  });
});
