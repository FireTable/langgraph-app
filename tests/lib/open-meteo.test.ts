import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { fetchWeatherWidget, geocodeLocation } from "@/lib/open-meteo";

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

describe("geocodeLocation", () => {
  it("returns the first hit from Open-Meteo geocoding", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        results: [{ name: "Beijing", latitude: 39.9042, longitude: 116.4074 }],
      }),
    );
    const result = await geocodeLocation("Beijing");
    expect(result).toEqual({
      success: true,
      result: { name: "Beijing", latitude: 39.9042, longitude: 116.4074 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://geocoding-api.open-meteo.com/v1/search?name=Beijing&count=1",
    );
  });

  it("encodes spaces and special chars in the query", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { results: [] }));
    await geocodeLocation("São Paulo");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("S%C3%A3o%20Paulo"));
  });

  it("returns failure when results array is empty", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { results: [] }));
    const result = await geocodeLocation("Xyzabc");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/No results/);
  });

  it("returns failure when the API returns non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    const result = await geocodeLocation("Anything");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/500/);
  });

  it("returns failure when the fetch itself throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const result = await geocodeLocation("Anything");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe("network down");
  });
});

describe("fetchWeatherWidget", () => {
  const fullForecast = {
    current: {
      time: "2025-06-23T14:30",
      temperature_2m: 75,
      weather_code: 0,
      wind_speed_10m: 5,
      precipitation: 0,
    },
    daily: {
      time: ["2025-06-23", "2025-06-24", "2025-06-25", "2025-06-26", "2025-06-27"],
      weather_code: [0, 1, 2, 3, 61],
      temperature_2m_max: [80, 81, 82, 78, 70],
      temperature_2m_min: [60, 61, 62, 58, 55],
    },
  };

  it("returns a widget payload matching the schema", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, fullForecast));
    const result = await fetchWeatherWidget({
      query: "Beijing",
      latitude: 39.9042,
      longitude: 116.4074,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.widget.version).toBe("3.1");
    expect(result.widget.location).toEqual({ name: "Beijing" });
    expect(result.widget.units.temperature).toBe("fahrenheit");
    expect(result.widget.current.temperature).toBe(75);
    expect(result.widget.current.conditionCode).toBe("clear");
    expect(result.widget.forecast).toHaveLength(5);
    expect(result.widget.forecast[0].label).toBe("Today");
  });

  it("maps heavy rain (code 65) to heavy-rain", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ...fullForecast,
        current: { ...fullForecast.current, weather_code: 65 },
      }),
    );
    const result = await fetchWeatherWidget({
      query: "Seattle",
      latitude: 47.6,
      longitude: -122.3,
    });
    if (!result.success) throw new Error("expected success");
    expect(result.widget.current.conditionCode).toBe("heavy-rain");
  });

  it("maps windy weather (code <=3 with wind >=45) to windy", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ...fullForecast,
        current: { ...fullForecast.current, weather_code: 1, wind_speed_10m: 50 },
      }),
    );
    const result = await fetchWeatherWidget({
      query: "Chicago",
      latitude: 41.8,
      longitude: -87.6,
    });
    if (!result.success) throw new Error("expected success");
    expect(result.widget.current.conditionCode).toBe("windy");
  });

  it("returns failure when daily fields are missing", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { current: fullForecast.current, daily: { time: [] } }),
    );
    const result = await fetchWeatherWidget({
      query: "Beijing",
      latitude: 39.9,
      longitude: 116.4,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Invalid/);
  });

  it("returns failure when the upstream returns non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, {}));
    const result = await fetchWeatherWidget({
      query: "Beijing",
      latitude: 39.9,
      longitude: 116.4,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/503/);
  });
});