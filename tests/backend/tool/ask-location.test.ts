import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { askLocationTool } from "@/backend/tool/ask-location";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("askLocationTool", () => {
  it("returns an awaiting marker without making any HTTP calls", async () => {
    const result = await askLocationTool.invoke({});
    expect(result).toEqual({ status: "awaiting_user_location" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
