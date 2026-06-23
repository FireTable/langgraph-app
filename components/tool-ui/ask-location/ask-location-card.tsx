"use client";

import { useState, type FC, type ReactNode } from "react";
import { AlertCircleIcon, CheckCircle2Icon, Loader2Icon, MapPinIcon, SearchIcon } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { geocodeLocation, reverseGeocode } from "@/lib/open-meteo";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";

// Result the LLM will see once the user picks a location. Three shapes:
//   { status }   — server-side placeholder, user hasn't acted yet
//   { lat, lon, label } — user picked coords
//   { error }    — user denied / geocode failed, model should ask for city name
export type AskLocationResult =
  | { status: "awaiting_user_location" }
  | { lat: number; lon: number; label: string }
  | { error: string };

type Mode =
  | { kind: "idle" }
  | { kind: "requesting_permission" }
  | { kind: "locating" }
  | { kind: "denied" }
  | { kind: "typing" }
  | { kind: "searching" }
  | { kind: "city_error"; message: string };

function requestGeolocation(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 10_000,
      maximumAge: 5 * 60 * 1000,
    });
  });
}

function parseResult(result: unknown): AskLocationResult | null {
  return unwrapToolResult<AskLocationResult>(result);
}

export const AskLocationCard: ToolCallMessagePartComponent<
  Record<string, never>,
  AskLocationResult
> = ({ result, addResult }) => {
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [cityQuery, setCityQuery] = useState("");

  const parsed = parseResult(result);

  const handleUseDeviceLocation = async () => {
    setMode({ kind: "requesting_permission" });
    try {
      const pos = await requestGeolocation();
      const label =
        (await reverseGeocode(pos.coords.latitude, pos.coords.longitude)) ?? "Current location";
      addResult?.({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        label,
      });
    } catch (err) {
      const message =
        err instanceof GeolocationPositionError && err.code === err.PERMISSION_DENIED
          ? "Location permission denied"
          : err instanceof Error
            ? err.message
            : "Geolocation failed";
      setMode({ kind: "denied" });
      addResult?.({ error: message });
    }
  };


  return (
    <div
      data-slot="ask-location-card"
      className={cn(
        "border-border/60 bg-card text-card-foreground my-2 max-w-md overflow-hidden rounded-xl border",
      )}
    >
      <div className="flex flex-col gap-3 p-4">
        <header className="flex items-center gap-3">
          <div className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full">
            <MapPinIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Share your location for weather</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {parsed && "lat" in parsed
                ? "Sent to the assistant."
                : "We need a place to look up the forecast."}
            </p>
          </div>
        </header>

        {/* Resolved: show the chosen coords as a confirmation, no more actions. */}
        {parsed && "lat" in parsed && (
          <div
            data-slot="ask-location-resolved"
            className="border-border/60 bg-muted/40 text-foreground flex items-center gap-3 rounded-lg border px-3 py-2.5"
          >
            <CheckCircle2Icon className="text-primary size-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{parsed.label}</p>
              <p className="text-muted-foreground mt-0.5 font-mono text-[11px]">
                {parsed.lat.toFixed(4)}, {parsed.lon.toFixed(4)}
              </p>
            </div>
          </div>
        )}

        {parsed && "error" in parsed && (
          <div className="text-destructive-foreground border-destructive/40 bg-destructive/10 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
            <AlertCircleIcon className="text-destructive mt-0.5 size-4 shrink-0" />
            <span className="text-destructive/90">{parsed.error}</span>
          </div>
        )}

        {/* Interactive: only when user hasn't decided yet. */}
        {(!parsed || "status" in parsed) && (
          <div className="flex flex-col gap-3">
            {mode.kind === "requesting_permission" && (
              <StatusRow icon={<Loader2Icon className="text-muted-foreground size-4 animate-spin" />}>
                Awaiting browser permission…
              </StatusRow>
            )}

            {mode.kind === "locating" && (
              <StatusRow icon={<Loader2Icon className="text-muted-foreground size-4 animate-spin" />}>
                Getting your location…
              </StatusRow>
            )}

            {(mode.kind === "idle" || mode.kind === "denied" || mode.kind === "typing") && (
              <>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  className="w-full justify-center gap-2"
                  onClick={handleUseDeviceLocation}
                >
                  <MapPinIcon className="size-4" />
                  {mode.kind === "denied" ? "Try location again" : "Use my location"}
                </Button>

                <div className="text-muted-foreground flex items-center gap-3 text-xs">
                  <div className="bg-border h-px flex-1" />
                  <span>or type a city</span>
                  <div className="bg-border h-px flex-1" />
                </div>

                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const q = cityQuery.trim();
                    if (!q) return;
                    setMode({ kind: "searching" });
                    void (async () => {
                      const geo = await geocodeLocation(q);
                      if (geo.success) {
                        addResult?.({
                          lat: geo.result.latitude,
                          lon: geo.result.longitude,
                          label: geo.result.name,
                        });
                      } else {
                        setMode({ kind: "city_error", message: geo.error });
                      }
                    })();
                  }}
                >
                  <input
                    type="text"
                    value={cityQuery}
                    onChange={(e) => {
                      setCityQuery(e.target.value);
                      if (mode.kind !== "typing") setMode({ kind: "typing" });
                    }}
                    placeholder="e.g. Beijing, 北京市, Tokyo"
                    className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-1"
                    autoFocus={mode.kind === "denied"}
                  />
                  <Button
                    type="submit"
                    variant="secondary"
                    size="icon"
                    className="size-9 shrink-0"
                    aria-label="Search city"
                    disabled={!cityQuery.trim()}
                  >
                    <SearchIcon className="size-4" />
                  </Button>
                </form>

                {mode.kind === "denied" && (
                  <p className="text-muted-foreground text-xs">
                    Location permission was blocked. Type a city above to continue.
                  </p>
                )}
              </>
            )}

            {mode.kind === "searching" && (
              <StatusRow icon={<Loader2Icon className="text-muted-foreground size-4 animate-spin" />}>
                Looking up “{cityQuery}”…
              </StatusRow>
            )}

            {mode.kind === "city_error" && (
              <div className="text-destructive/90 flex items-start gap-2 text-xs">
                <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Couldn’t find {cityQuery}: {mode.message}. Try a different spelling.
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const StatusRow: FC<{ icon: ReactNode; children: ReactNode }> = ({
  icon,
  children,
}) => (
  <div className="text-muted-foreground flex items-center gap-2 text-sm">
    {icon}
    <span>{children}</span>
  </div>
);