"use client";

// ponytail: singleton <Sheet/> mounted at ThreadRoot. Subscribes to the
// sheet-context to know which thread to load; holds the fetch lifecycle
// (was previously inlined in button.tsx → per-message N-fold duplication).
import { useCallback, useEffect, useRef, useState } from "react";
import type { FC } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAuiState } from "@assistant-ui/react";
import type { SpanData } from "@assistant-ui/react-o11y";
import { Activity } from "lucide-react";
import { ObservabilityPanel, ObservabilityPanelSkeleton } from "@/components/observability/panel";
import { useObservabilitySheetState } from "@/components/observability/sheet-context";
import type { AggregateDTO, InFlightRun, SpanDataDTO } from "@/lib/observability/validators";

const LOCAL_THREAD_PREFIX = "__LOCAL_";

// ponytail: 10s poll while a bg agent is in flight. Once the API reports
// in_flight_runs is empty, onRefresh resolves false and the polling +
// countdown both tear down together.
const REFRESH_INTERVAL_MS = 10 * 1000;

// ponytail: owns the polling + countdown lifecycle in one place. The
// 1s tick that drives the countdown label, and the 10s tick that
// re-fetches spans, both live here — so the parent sheet's render tree
// is untouched while time passes. Activity icon rides with the
// countdown so they appear/disappear as a unit.
type RefreshCountdownProps = {
  enabled: boolean;
  refreshIntervalMs: number;
  onRefresh: () => Promise<boolean>;
};

const RefreshCountdown: FC<RefreshCountdownProps> = ({ enabled, refreshIntervalMs, onRefresh }) => {
  // ponytail: epoch-ms timestamp of the next scheduled poll, or null
  // when polling is inactive. Drives the "still running, tracing Xs" countdown.
  const [targetEpochMs, setTargetEpochMs] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) {
      setTargetEpochMs(null);
      return;
    }
    // ponytail: paint the countdown immediately on enable, otherwise
    // the first tick lands 10s later and the user sees the indicator
    // pop in a full cycle late. Reset `now` to the same Date.now() so
    // the initial (targetEpochMs - now) is exactly refreshIntervalMs —
    // Math.ceil would otherwise read a few ms past the boundary as the
    // next integer (e.g. 10005ms → "11s" instead of "10s").
    const t = Date.now();
    setTargetEpochMs(t + refreshIntervalMs);
    setNow(t);
    let cancelled = false;
    const id = window.setInterval(async () => {
      if (cancelled) return;
      const keepPolling = await onRefresh();
      if (cancelled) return;
      if (keepPolling) {
        const t2 = Date.now();
        setTargetEpochMs(t2 + refreshIntervalMs);
        setNow(t2);
      } else {
        setTargetEpochMs(null);
      }
    }, refreshIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled, refreshIntervalMs, onRefresh]);

  // ponytail: 1s tick for the countdown label. Idle when targetEpochMs
  // is null, so the page sits still when no polling is scheduled.
  useEffect(() => {
    if (targetEpochMs === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [targetEpochMs]);

  if (targetEpochMs === null) return null;
  const secondsLeft = Math.max(0, Math.ceil((targetEpochMs - now) / 1000));
  return (
    <>
      <Activity className="size-3 animate-pulse" />
      <span className="text-muted-foreground text-xs font-normal">
        Still running, will trace after {secondsLeft}s
      </span>
    </>
  );
};

export const ObservabilitySheet: FC = () => {
  const { open, threadId, parentMessageId, setOpen } = useObservabilitySheetState();
  const [spans, setSpans] = useState<SpanDataDTO[]>([]);
  const [aggregate, setAggregate] = useState<AggregateDTO | null>(null);
  const [stepIdToRawSpanId, setStepIdToRawSpanId] = useState<Record<string, string>>({});
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [stillRunning, setStillRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ponytail: when the sheet is closed we still track the latest threadId
  // the user clicked on (saved in sheet-context state) so a re-open on the
  // same thread shows cached data without a round trip. Reset load flags
  // when the active threadId changes.
  const auiThreadId = useAuiState((s) => {
    const item = s.threads.threadItems.find((t) => t.id === s.threads.mainThreadId);
    const candidate = item?.externalId ?? s.threads.mainThreadId;
    return candidate && !candidate.startsWith(LOCAL_THREAD_PREFIX) ? candidate : null;
  });

  // ponytail: monotonic fetch id — every loadSpans() bumps it, and
  // older in-flight responses early-return when they no longer own
  // the latest id. Without this, the 10s poll racing with the initial
  // load (or two consecutive polls) would clobber state with stale
  // spans when the slower response lands second.
  const fetchIdRef = useRef(0);
  // ponytail: track whether the first response has landed. Until then,
  // show the skeleton; after that, polls patch the new spans in place
  // without flipping loading=true (which would re-mount the panel and
  // flicker through <ObservabilityPanelSkeleton /> on every tick).
  const hasLoadedOnceRef = useRef(false);

  // ponytail: returns true when the response reports at least one
  // in-flight bg run, so RefreshCountdown keeps polling. False stops it.
  const loadSpans = useCallback(async (): Promise<boolean> => {
    if (!open || !threadId) return false;
    const myId = ++fetchIdRef.current;
    // ponytail: only flash the skeleton on the first load — subsequent
    // 10s polls keep the existing data on screen and patch the new spans
    // in place.
    setLoading(!hasLoadedOnceRef.current);
    setError(null);
    const path = parentMessageId
      ? `/api/threads/${threadId}/observability/${encodeURIComponent(parentMessageId)}`
      : `/api/threads/${threadId}/observability`;
    try {
      const res = await fetch(path, { credentials: "include" });
      if (fetchIdRef.current !== myId) return false;
      if (!res.ok) {
        setError(`Failed to load (${res.status})`);
        return false;
      }
      const body = (await res.json()) as {
        thread_id: string;
        retention_days: number;
        parent_message_id?: string;
        spans: SpanData[];
        aggregate: AggregateDTO | null;
        in_flight_runs?: InFlightRun[];
        step_id_to_raw_span_id?: Record<string, string>;
      };
      setSpans(body.spans);
      setAggregate(body.aggregate ?? null);
      setStepIdToRawSpanId(body.step_id_to_raw_span_id ?? {});
      setRetentionDays(body.retention_days);
      hasLoadedOnceRef.current = true;
      const inFlight = (body.in_flight_runs ?? []).length > 0;
      setStillRunning(inFlight);
      return inFlight;
    } catch (e) {
      if (fetchIdRef.current !== myId) return false;
      setError(e instanceof Error ? e.message : "Unknown error");
      return false;
    } finally {
      if (fetchIdRef.current === myId) setLoading(false);
    }
  }, [open, threadId, parentMessageId]);

  // ponytail: initial / context-switch load. Re-runs whenever the
  // sheet opens or the active thread / parent message changes.
  useEffect(() => {
    void loadSpans();
  }, [loadSpans]);

  // ponytail: switching to a different thread / parent message resets
  // the "has loaded" flag so the new target's first fetch flashes the
  // skeleton again.
  useEffect(() => {
    hasLoadedOnceRef.current = false;
  }, [open, threadId, parentMessageId]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        className="!max-w-none flex w-full flex-col gap-4 overflow-hidden p-6 md:w-3/4"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            Observability
            <RefreshCountdown
              enabled={stillRunning}
              refreshIntervalMs={REFRESH_INTERVAL_MS}
              onRefresh={loadSpans}
            />
          </SheetTitle>
        </SheetHeader>

        {auiThreadId && threadId && auiThreadId !== threadId ? (
          <div className="text-muted-foreground text-xs">
            Thread has changed — close and reopen to see the latest data.
          </div>
        ) : null}
        {error ? (
          <div className="text-destructive text-sm" role="alert">
            {error}
          </div>
        ) : loading && !error ? (
          <ObservabilityPanelSkeleton />
        ) : !threadId ? (
          <div className="text-muted-foreground text-sm">No thread selected.</div>
        ) : (
          <ObservabilityPanel
            spans={spans}
            aggregate={aggregate}
            stepIdToRawSpanId={stepIdToRawSpanId}
            retentionDays={retentionDays}
            stillRunning={stillRunning}
            threadId={threadId}
          />
        )}
      </SheetContent>
    </Sheet>
  );
};
