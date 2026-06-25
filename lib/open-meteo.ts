// Shared Open-Meteo client. Used by both the backend weather tools
// (geocode_location, get_weather) and the frontend ask-location card
// (when the user types a city instead of granting geolocation).

import type {
  ForecastDay,
  PrecipitationLevel,
  TemperatureUnit,
  WeatherConditionCode,
  WeatherWidgetPayload,
} from "@/components/tool-ui/weather-widget/runtime";

export interface WeatherSearchArgs {
  query: string;
  longitude: number;
  latitude: number;
  unit?: TemperatureUnit;
}

export type GeocodeResult =
  | {
      success: true;
      result: { name: string; latitude: number; longitude: number };
    }
  | { success: false; error: string };

export type WeatherResult =
  | { success: true; widget: WeatherWidgetPayload }
  | { success: false; error: string };

// WMO weather codes → our enum. See https://open-meteo.com/en/docs
const mapOpenMeteoCodeToCondition = (code: number, windSpeed?: number): WeatherConditionCode => {
  if (windSpeed !== undefined && windSpeed >= 45 && code <= 3) return "windy";
  switch (code) {
    case 0:
      return "clear";
    case 1:
    case 2:
      return "partly-cloudy";
    case 3:
      return "overcast";
    case 45:
    case 48:
      return "fog";
    case 51:
    case 53:
    case 55:
      return "drizzle";
    case 56:
    case 57:
    case 66:
    case 67:
      return "sleet";
    case 61:
    case 63:
    case 80:
    case 81:
      return "rain";
    case 65:
    case 82:
      return "heavy-rain";
    case 71:
    case 73:
    case 75:
    case 77:
    case 85:
    case 86:
      return "snow";
    case 95:
      return "thunderstorm";
    case 96:
    case 99:
      return "hail";
    default:
      return "cloudy";
  }
};

const mapPrecipitationLevel = (precipitation?: number): PrecipitationLevel | undefined => {
  if (precipitation === undefined) return undefined;
  if (precipitation <= 0) return "none";
  if (precipitation < 1) return "light";
  if (precipitation < 4) return "moderate";
  return "heavy";
};

// Open-Meteo's `current.time` is local ISO like "2025-06-23T14:30".
// Convert to a 0-1 fraction of the day so the widget can theme by time.
const getLocalTimeOfDay = (time?: string): number => {
  if (!time) return new Date().getHours() / 24;
  const [, rawClock = "12:00"] = time.split("T");
  const [hours = "12", minutes = "0"] = rawClock.split(":");
  const h = Number.parseInt(hours, 10);
  const m = Number.parseInt(minutes, 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return new Date().getHours() / 24;
  return (h + m / 60) / 24;
};

const formatForecastLabel = (date: string, index: number): string => {
  if (index === 0) return "Today";
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return `Day ${index + 1}`;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: "UTC",
  }).format(parsed);
};

// Geocode with a 3-step fallback chain:
//   1. Open-Meteo (English-ish place names, fast)
//   2. Nominatim (broad coverage incl. Chinese, 1 req/s rate limit)
//   3. Original query stripped of generic suffixes, tried on Nominatim again
// Each step returns the first hit. Failure bubbles the last error verbatim
// so the UI can show "Couldn't find …" with the underlying reason.
export async function geocodeLocation(query: string): Promise<GeocodeResult> {
  const providers: Array<() => Promise<GeocodeResult>> = [
    () => geocodeOpenMeteo(query),
    () => geocodeNominatim(query),
    () => geocodeNominatim(stripGenericSuffix(query)),
  ];
  let lastError = "";
  for (const provider of providers) {
    try {
      const result = await provider();
      if (result.success) return result;
      lastError = result.error;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown geocoding error";
    }
  }
  return { success: false, error: lastError || "No results found" };
}

async function geocodeOpenMeteo(query: string): Promise<GeocodeResult> {
  const response = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1`,
  );
  if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
  const data = (await response.json()) as {
    results?: Array<{ name: string; latitude: number; longitude: number }>;
  };
  if (!data.results || data.results.length === 0) throw new Error("No results found");
  return { success: true, result: data.results[0] };
}

async function geocodeNominatim(query: string): Promise<GeocodeResult> {
  const lang = typeof navigator !== "undefined" ? navigator.language : "en";
  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=1&accept-language=${encodeURIComponent(lang)}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
  const data = (await response.json()) as Array<{
    name?: string;
    lat: string;
    lon: string;
    display_name?: string;
  }>;
  if (!Array.isArray(data) || data.length === 0) throw new Error("No results found");
  const hit = data[0];
  const name = hit.name ?? hit.display_name?.split(",")[0]?.trim() ?? query;
  return {
    success: true,
    result: {
      name,
      latitude: Number.parseFloat(hit.lat),
      longitude: Number.parseFloat(hit.lon),
    },
  };
}

// Drop common admin suffixes so "勒流市" / "Foshan City" falls back to "勒流" / "Foshan".
const GENERIC_SUFFIXES =
  /[\s,]+(市|city|prefecture|province|省|district|区|县|county|state|地区|region|country|国)$/i;

function stripGenericSuffix(query: string): string {
  const stripped = query.replace(GENERIC_SUFFIXES, "").trim();
  return stripped.length >= 2 ? stripped : query;
}

export async function fetchWeatherWidget({
  query,
  longitude,
  latitude,
  unit = "fahrenheit",
}: WeatherSearchArgs): Promise<WeatherResult> {
  try {
    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&timezone=auto&temperature_unit=${unit}&current=temperature_2m,weather_code,wind_speed_10m,precipitation&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=5`,
    );
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = (await response.json()) as {
      current?: {
        time?: string;
        temperature_2m: number;
        weather_code: number;
        wind_speed_10m?: number;
        precipitation?: number;
      };
      daily?: {
        time: string[];
        weather_code: number[];
        temperature_2m_max: number[];
        temperature_2m_min: number[];
      };
    };
    const current = data.current;
    const daily = data.daily;
    if (
      !current ||
      !daily?.time ||
      !daily.weather_code ||
      !daily.temperature_2m_max ||
      !daily.temperature_2m_min
    ) {
      throw new Error("Invalid API response format");
    }

    const forecast: ForecastDay[] = daily.time.slice(0, 5).map((date, index) => ({
      label: formatForecastLabel(date, index),
      conditionCode: mapOpenMeteoCodeToCondition(daily.weather_code[index]),
      tempMin: daily.temperature_2m_min[index],
      tempMax: daily.temperature_2m_max[index],
    }));
    if (forecast.length === 0) {
      throw new Error("No forecast data available");
    }

    const precipitationLevel = mapPrecipitationLevel(current.precipitation);

    return {
      success: true,
      widget: {
        version: "3.1",
        id: `weather-${query.toLowerCase().replaceAll(/\W+/g, "-")}-${Date.now().toString(36)}`,
        location: { name: query },
        units: { temperature: unit },
        current: {
          conditionCode: mapOpenMeteoCodeToCondition(current.weather_code, current.wind_speed_10m),
          temperature: current.temperature_2m,
          tempMin: daily.temperature_2m_min[0],
          tempMax: daily.temperature_2m_max[0],
          windSpeed: current.wind_speed_10m,
          ...(precipitationLevel !== undefined ? { precipitationLevel } : {}),
        },
        forecast,
        time: { localTimeOfDay: getLocalTimeOfDay(current.time) },
        updatedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to fetch weather",
    };
  }
}

// Reverse-geocode coords to a place name via Nominatim. Free, no API key,
// but rate-limited (1 req/sec) and requires a User-Agent header on the
// browser side. We only call this once per "Use my location" click, so the
// rate limit doesn't bite.
export async function reverseGeocode(latitude: number, longitude: number): Promise<string | null> {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=jsonv2&accept-language=en&zoom=10`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      name?: string;
      address?: {
        city?: string;
        town?: string;
        village?: string;
        county?: string;
        state?: string;
        country?: string;
      };
      display_name?: string;
    };
    const a = data.address;
    return (
      data.name ??
      a?.city ??
      a?.town ??
      a?.village ??
      a?.county ??
      a?.state ??
      data.display_name?.split(",")[0]?.trim() ??
      null
    );
  } catch {
    return null;
  }
}
