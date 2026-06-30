"use client";

import { AuiIf, AuiProvider, useAui, useAuiState } from "@assistant-ui/react";
import {
  SpanPrimitive,
  SpanResource,
  type SpanData,
  type SpanItemState,
} from "@assistant-ui/react-o11y";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from "react";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export type ObservabilityPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spans: SpanData[];
};

const LABEL_WIDTH = 240;
const BAR_HEIGHT = 32;
const RIGHT_PADDING_RATIO = 0.08;

const TYPE_COLORS: Record<string, string> = {
  action: "hsl(221 83% 53%)",
  api: "hsl(262 83% 58%)",
  tool: "hsl(142 71% 45%)",
  flow: "hsl(25 95% 53%)",
  pipeline: "hsl(340 75% 55%)",
};
const FALLBACK_COLOR = "hsl(220 9% 46%)";

const STATUS_OPACITY: Record<SpanItemState["status"], number> = {
  running: 0.7,
  completed: 1,
  failed: 1,
  skipped: 0.5,
};

type WaterfallLayout = {
  barWidth: number;
  timeRange: { min: number; max: number };
  contentWidth: number;
};

const WaterfallLayoutContext = createContext<WaterfallLayout | null>(null);

function useWaterfallLayout(): WaterfallLayout {
  const ctx = useContext(WaterfallLayoutContext);
  if (!ctx) throw new Error("useWaterfallLayout must be used inside WaterfallLayoutContext");
  return ctx;
}

function formatTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

const TimeAxisTicks: FC<{ timeRange: { min: number; max: number }; barWidth: number }> = ({
  timeRange,
  barWidth,
}) => {
  const duration = timeRange.max - timeRange.min;
  const tickCount = Math.min(5, Math.max(2, Math.floor(barWidth / 100)));
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => ({
    t: (i / tickCount) * duration,
    x: (i / tickCount) * barWidth,
  }));
  return (
    <svg aria-hidden width={barWidth} height={28} className="overflow-visible">
      {ticks.map(({ t, x }, i) => (
        <g key={x}>
          <line x1={x} y1={20} x2={x} y2={28} stroke="currentColor" className="text-border" />
          <text
            x={i === 0 ? x + 2 : i === ticks.length - 1 ? x - 2 : x}
            y={14}
            textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}
            className="fill-muted-foreground text-[10px]"
          >
            {formatTime(t)}
          </text>
        </g>
      ))}
    </svg>
  );
};

const WaterfallBar: FC = () => {
  const { barWidth, timeRange } = useWaterfallLayout();
  // react-o11y augments @assistant-ui/store's ScopeRegistry with `span`, but
  // `@assistant-ui/react` re-exports the same hooks without the augmented
  // overloads — cast the state to the augmented shape.
  const startedAt = useAuiState((s) => (s as unknown as { span: SpanItemState }).span.startedAt);
  const endedAt = useAuiState((s) => (s as unknown as { span: SpanItemState }).span.endedAt) as
    | number
    | null;
  const status = useAuiState(
    (s) => (s as unknown as { span: SpanItemState }).span.status,
  ) as SpanItemState["status"];
  const type = useAuiState((s) => (s as unknown as { span: SpanItemState }).span.type);

  const barRef = useRef<SVGRectElement>(null);

  const scale = useCallback(
    (t: number) => {
      const range = timeRange.max - timeRange.min || 1;
      return ((t - timeRange.min) / range) * barWidth;
    },
    [timeRange, barWidth],
  );

  const x = scale(startedAt);

  useEffect(() => {
    if (status !== "running") return;
    let frameId: number;
    const tick = () => {
      const width = scale(Date.now()) - x;
      barRef.current?.setAttribute("width", String(Math.max(0, width)));
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [status, x, scale]);

  const rawWidth = endedAt ? scale(endedAt) - x : 0;
  const width = Math.max(rawWidth, 4);
  const fill = TYPE_COLORS[type] ?? FALLBACK_COLOR;
  const opacity = STATUS_OPACITY[status];

  return (
    <g>
      <rect
        ref={barRef}
        x={x}
        y={4}
        width={width}
        height={BAR_HEIGHT - 8}
        rx={3}
        fill={fill}
        opacity={opacity}
        className={status === "running" ? "animate-pulse" : ""}
      />
      {status === "failed" && (
        <rect
          x={x}
          y={4}
          width={width}
          height={BAR_HEIGHT - 8}
          rx={3}
          fill="none"
          stroke="hsl(0 84% 60%)"
          strokeWidth={2}
        />
      )}
    </g>
  );
};

const WaterfallRow: FC = () => {
  const { barWidth, contentWidth } = useWaterfallLayout();
  return (
    <SpanPrimitive.Root
      className="group flex cursor-pointer items-center"
      style={{ width: contentWidth, height: BAR_HEIGHT }}
    >
      <SpanPrimitive.Indent
        baseIndent={8}
        indentPerLevel={12}
        className="border-border bg-background group-hover:bg-accent/50 sticky left-0 z-10 flex shrink-0 items-center gap-1 overflow-hidden border-r px-2"
        style={{ width: LABEL_WIDTH, height: BAR_HEIGHT }}
      >
        <AuiIf
          condition={(s) => (s as unknown as { span: { hasChildren: boolean } }).span.hasChildren}
        >
          <SpanPrimitive.CollapseToggle className="text-muted-foreground hover:text-foreground flex shrink-0 items-center justify-center rounded p-0.5">
            <svg
              aria-hidden
              className="data-[collapsed=true]:-rotate-90 size-3.5 transition-transform"
              viewBox="0 0 16 16"
              fill="currentColor"
            >
              <path d="M4 6l4 4 4-4H4z" />
            </svg>
          </SpanPrimitive.CollapseToggle>
        </AuiIf>
        <AuiIf
          condition={(s) => !(s as unknown as { span: { hasChildren: boolean } }).span.hasChildren}
        >
          <span className="w-4.5 shrink-0" />
        </AuiIf>
        <SpanPrimitive.StatusIndicator className="size-1.5 shrink-0 rounded-full bg-current" />
        <SpanPrimitive.TypeBadge className="border-border text-muted-foreground shrink-0 rounded border px-1 text-[10px]" />
        <SpanPrimitive.Name className="truncate text-sm" />
      </SpanPrimitive.Indent>

      <div className="group-hover:bg-accent/30" style={{ width: barWidth, height: BAR_HEIGHT }}>
        <svg aria-hidden width={barWidth} height={BAR_HEIGHT}>
          <WaterfallBar />
        </svg>
      </div>
    </SpanPrimitive.Root>
  );
};

const WaterfallTimeline: FC = () => {
  const outerRef = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(400);

  const hasSpans = useAuiState(
    (s) => (s as unknown as { span: { hasChildren: boolean } }).span.hasChildren,
  );
  // timeRange lives on the root SpanState, not per-span.
  const timeRange = useAuiState(
    (s) => (s as unknown as { span: { timeRange: { min: number; max: number } } }).span.timeRange,
  );

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setBarWidth(Math.max(200, entry.contentRect.width - LABEL_WIDTH));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasSpans]);

  const contentWidth = LABEL_WIDTH + barWidth;

  const renderTimeRange = useMemo(() => {
    const duration = timeRange.max - timeRange.min;
    return { min: timeRange.min, max: timeRange.max + duration * RIGHT_PADDING_RATIO };
  }, [timeRange]);

  const layout = useMemo<WaterfallLayout>(
    () => ({ barWidth, timeRange: renderTimeRange, contentWidth }),
    [barWidth, renderTimeRange, contentWidth],
  );

  if (!hasSpans) {
    return (
      <div className="border-border text-muted-foreground rounded-lg border py-12 text-center text-sm">
        No spans recorded.
      </div>
    );
  }

  return (
    <div ref={outerRef} className="border-border overflow-hidden rounded-lg border">
      <div
        className="border-border bg-background sticky top-0 z-20 flex border-b"
        style={{ width: contentWidth }}
      >
        <div
          className="border-border bg-background text-muted-foreground sticky left-0 z-30 shrink-0 border-r px-2 py-1.5 text-xs"
          style={{ width: LABEL_WIDTH }}
        >
          Span
        </div>
        <div style={{ width: barWidth, height: 28 }}>
          <TimeAxisTicks timeRange={renderTimeRange} barWidth={barWidth} />
        </div>
      </div>

      <WaterfallLayoutContext.Provider value={layout}>
        <div style={{ width: contentWidth }}>
          <SpanPrimitive.Children>{() => <WaterfallRow />}</SpanPrimitive.Children>
        </div>
      </WaterfallLayoutContext.Provider>

      <div className="border-border text-muted-foreground flex items-center gap-4 border-t px-3 py-2 text-xs">
        {(["action", "api", "tool", "flow", "pipeline"] as const).map((t) => (
          <div key={t} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: TYPE_COLORS[t] }} />
            <span>{t}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export const ObservabilityPanel: FC<ObservabilityPanelProps> = ({ open, onOpenChange, spans }) => {
  // react-o11y's o11y-scope.d.ts augments ScopeRegistry with `span`, but the
  // `useAui` consumer-side overload isn't typed for our installed TS — cast.
  const aui = useAui({ span: SpanResource({ spans }) } as unknown as Parameters<typeof useAui>[0]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-[50vw] min-w-[40rem] max-w-[1200px] flex-col gap-4 overflow-hidden p-6"
      >
        <SheetHeader>
          <SheetTitle>Observability</SheetTitle>
        </SheetHeader>
        <div className="-mx-6 min-h-0 flex-1 overflow-auto px-6">
          <AuiProvider value={aui}>
            <WaterfallTimeline />
          </AuiProvider>
        </div>
      </SheetContent>
    </Sheet>
  );
};
