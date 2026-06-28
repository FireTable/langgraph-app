"use client";

import { useState, type FC, type ReactNode } from "react";
import { AlertCircleIcon, CheckIcon, Loader2Icon, MapPinIcon, SearchIcon } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";

import { Button } from "@/components/ui/button";
import { CardHeader, CardShell } from "@/components/tool-ui/primitives/card";
import { ErrorBanner, SuccessBanner } from "@/components/tool-ui/primitives/banners";
import { geocodeLocation, reverseGeocode } from "@/lib/open-meteo";
import { unwrapToolResult } from "@/components/tool-ui/tool-result";
import { useLangGraphSendCommand } from "@assistant-ui/react-langgraph";

// Tool result the user picks from the card. The backend tool pauses via
// interrupt({ ui: 'ask_location' }); this card renders in the InterruptUI
// slot and resumes through `addResult`, which LangGraph forwards as the
// ToolMessage content for the LLM's next pass.
//   { lat, lon, label } — user picked coords
//   { error }           — geolocation denied or geocode failed
export type AskLocationResult = { lat: number; lon: number; label: string } | { error: string };

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

export const AskLocationCard: ToolCallMessagePartComponent<Record<string, never>> = ({
  result,
}) => {
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [cityQuery, setCityQuery] = useState("");
  const sendCommand = useLangGraphSendCommand();

  const parsed = parseResult(result);

  const addResult = async (payload: AskLocationResult) => {
    sendCommand({ resume: JSON.stringify(payload) });
  };
  const handleUseDeviceLocation = async () => {
    setMode({ kind: "requesting_permission" });
    try {
      const pos = await requestGeolocation();
      const label =
        (await reverseGeocode(pos.coords.latitude, pos.coords.longitude)) ?? "Current location";
      addResult({ lat: pos.coords.latitude, lon: pos.coords.longitude, label });
    } catch (err) {
      const message =
        err instanceof GeolocationPositionError && err.code === err.PERMISSION_DENIED
          ? "Location permission denied"
          : err instanceof Error
            ? err.message
            : "Geolocation failed";
      setMode({ kind: "denied" });
      addResult({ error: message });
    }
  };

  return (
    <CardShell data-slot="ask-location-card" maxWidthClass="max-w-md">
      <CardHeader
        icon={<MapPinIcon className="size-4" />}
        title="Share your location to me"
        subtitle={
          parsed && "lat" in parsed
            ? "Sent to the assistant."
            : "We need a place to look up the forecast."
        }
      />

      {/* Resolved: show the chosen coords as a confirmation, no more actions. */}
      {parsed && "lat" in parsed && (
        <SuccessBanner
          title={parsed.label}
          subtitle={`${parsed.lat.toFixed(4)}, ${parsed.lon.toFixed(4)}`}
          icon={<CheckIcon className="text-primary size-5 shrink-0" />}
        />
      )}

      {parsed && "error" in parsed && <ErrorBanner message={parsed.error} />}

      {/* Interactive: only when user hasn't decided yet. */}
      {!parsed && (
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
                className="w-full justify-center"
                onClick={handleUseDeviceLocation}
              >
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
                      addResult({
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
    </CardShell>
  );
};

const StatusRow: FC<{ icon: ReactNode; children: ReactNode }> = ({ icon, children }) => (
  <div className="text-muted-foreground flex items-center gap-2 text-sm">
    {icon}
    <span>{children}</span>
  </div>
);
