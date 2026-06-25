import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { getWeatherTool } from "@/backend/tool/fetch-weather";

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

const forecastResponse = {
  current: {
    time: "2025-06-23T14:30",
    temperature_2m: 70,
    weather_code: 0,
    wind_speed_10m: 5,
    precipitation: 0,
  },
  daily: {
    time: ["2025-06-23", "2025-06-24"],
    weather_code: [0, 1],
    temperature_2m_max: [80, 81],
    temperature_2m_min: [60, 61],
  },
};

describe("getWeatherTool", () => {
  it("calls the forecast endpoint and returns the widget payload", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, forecastResponse));
    const out = await getWeatherTool.invoke({
      location: "Beijing",
      latitude: 39.9,
      longitude: 116.4,
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(true);
    expect(parsed.widget.current.temperature).toBe(70);
    expect(parsed.widget.location.name).toBe("Beijing");
  });

  it("propagates API failures as a serialized error result", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    const out = await getWeatherTool.invoke({
      location: "X",
      latitude: 0,
      longitude: 0,
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/500/);
  });
});
