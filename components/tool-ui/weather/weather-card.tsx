"use client";

import { useEffect, useRef, useState } from "react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";

import { ToolCardSkeleton } from "@/components/tool-ui/tool-card-skeleton";
import { WeatherWidget } from "@/components/tool-ui/weather/runtime";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";

type Args = {
  location: string;
  latitude: number;
  longitude: number;
};

type WeatherToolSuccess = {
  success: true;
  widget: import("@/components/tool-ui/weather/runtime").WeatherWidgetPayload;
};

type WeatherToolFailure = {
  success: false;
  error: string;
};

type Result = WeatherToolSuccess | WeatherToolFailure;

type ParsedResult =
  | { kind: "loading" }
  | {
    kind: "ok";
    widget: import("@/components/tool-ui/weather/runtime").WeatherWidgetPayload;
  }
  | { kind: "error"; message: string };

function parseWeatherResult(raw: unknown): ParsedResult {
  const obj = unwrapToolResult<Record<string, unknown>>(raw);
  if (!obj) return { kind: "loading" };
  if (obj.success === true && obj.widget && typeof obj.widget === "object") {
    return {
      kind: "ok",
      widget: obj.widget as ParsedResult extends { kind: "ok"; widget: infer W } ? W : never,
    };
  }
  if (obj.success === false && typeof obj.error === "string") {
    return { kind: "error", message: obj.error };
  }
  if ("widget" in obj && obj.widget && typeof obj.widget === "object") {
    return { kind: "ok", widget: obj.widget as never };
  }
  if (typeof obj.error === "string") {
    return { kind: "error", message: obj.error };
  }
  return { kind: "loading" };
}

export const WeatherCard: ToolCallMessagePartComponent<Args, Result> = ({ result }) => {
  const parsed = parseWeatherResult(result);

  if (parsed.kind === "loading") {
    return <ToolCardSkeleton label="Looking up weather…" />;
  }
  if (parsed.kind === "error") {
    return (
      <div className="text-destructive mx-2 text-xs">
        Couldn’t fetch weather: {parsed.message}
      </div>
    );
  }
  return <WeatherCardWithRevivedEffects widget={parsed.widget} />;
};

// The vendored widget's WebGL canvas is dropped when the ToolGroup is
// collapsed — browsers throttle/destroy hidden canvases. Re-mounting the
// widget when the container becomes visible again reinitializes the
// canvas so the effects come back.
function WeatherCardWithRevivedEffects({
  widget,
}: {
  widget: import("@/components/tool-ui/weather/runtime").WeatherWidgetPayload;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [key, setKey] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let lastVisible = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = entry.isIntersecting;
        if (visible && !lastVisible) setKey((k) => k + 1);
        lastVisible = visible;
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="max-w-md">
      <WeatherWidget key={key} {...widget} />
    </div>
  );
}
