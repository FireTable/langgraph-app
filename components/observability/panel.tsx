"use client";

// ponytail: pure renderer. The button.tsx controller owns fetch + the
// Sheet chrome; the panel just needs data and renders the waterfall
// + details. No Sheet / Dialog imports in this file.
//
// ponytail: data shape — server-side only. panel receives SpanData[] +
// pre-computed aggregate from /api/threads/[id]/observability/[...]; raw
// CapturedSpan is fetched lazily via the /spans/[spanId] detail endpoint
// when the user clicks a row.
import { AuiIf, AuiProvider, useAui, useAuiState } from "@assistant-ui/react";
import { cn } from "@/lib/utils";
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
import {
  Activity,
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BoxIcon,
  BrainIcon,
  ClockIcon,
  DatabaseIcon,
  LinkIcon,
  Loader2Icon,
  UserIcon,
  WrenchIcon,
} from "lucide-react";

import type { CapturedSpan } from "@/lib/observability/callback";
import { CopyButton } from "@/components/ui/copy-button";
import type { AggregateDTO } from "@/lib/observability/validators";
import { buildLlmMessages, type MessageEntry } from "@/components/observability/llm-messages";
import type { WireSpanData } from "@/lib/observability/transform";

export type ObservabilityPanelProps = {
  spans: WireSpanData[];
  // ponytail: pre-computed stat-card aggregate. Server pre-computes from
  // the raw spans (see lib/observability/aggregate.ts) so the panel
  // doesn't need raw data on hand. Null when the thread has no spans.
  aggregate: AggregateDTO | null;
  // ponytail: synthetic step-wrapper id → raw span_id. Used to translate
  // a clicked wrapper row into the raw span id the detail endpoint expects.
  stepIdToRawSpanId: Record<string, string>;
  // ponytail: retention policy reported by /api/threads/<id>/observability.
  // Rendered as a small footer under the legend so the sheet header
  // stays compact. Null = unknown (don't render).
  retentionDays?: number | null;
  // ponytail: true when the API reports one or more in-flight LangGraph
  // runs for this turn. The panel renders a synthetic "still running"
  // row at the bottom of the waterfall from this flag alone.
  stillRunning?: boolean;
  threadId: string;
};

const LABEL_WIDTH = 240;
const BAR_HEIGHT = 32;
const RIGHT_PADDING_RATIO = 0.08;

const TYPE_COLORS: Record<string, string> = {
  llm: "hsl(262 83% 58%)",
  tool: "hsl(142 71% 45%)",
  node: "hsl(25 95% 53%)",
  chain: "hsl(220 9% 46%)",
  human: "hsl(217 91% 60%)",
  action: "hsl(221 83% 53%)",
  api: "hsl(262 83% 58%)",
  flow: "hsl(25 95% 53%)",
  pipeline: "hsl(340 75% 55%)",
};
const FALLBACK_COLOR = "hsl(220 9% 46%)";

const LEGEND_TYPE_ORDER = ["chain", "node", "llm", "tool", "human"] as const;

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

// ponytail: hover tooltip state, scoped to WaterfallTimeline. The popup
// reads a SpanData subset per-row (no raw CapturedSpan fetch — too
// heavy for hover). Walk fields in the same order as the detail panel
// schema and filter via `tooltip: true` so the schema stays the single
// source of truth.
type TooltipState = { x: number; y: number; data: SpanData } | null;
type TooltipContextValue = {
  tooltip: TooltipState;
  setTooltip: (
    updater: TooltipState | ((prev: TooltipState | null) => TooltipState | null),
  ) => void;
};

const TooltipContext = createContext<TooltipContextValue | null>(null);

function useTooltip(): TooltipContextValue {
  const ctx = useContext(TooltipContext);
  if (!ctx) throw new Error("useTooltip must be used inside TooltipContext");
  return ctx;
}

function formatTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

// ponytail: same shape as the waterfall's axis ticks — always seconds.
function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
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
    <svg
      aria-hidden
      width={barWidth}
      height={28}
      className="overflow-visible shrink-0  py-1.5 text-xs items-center flex"
    >
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
  const id = useAuiState((s) => (s as unknown as { span: SpanItemState }).span.id);
  const startedAt = useAuiState((s) => (s as unknown as { span: SpanItemState }).span.startedAt);
  const endedAt = useAuiState((s) => (s as unknown as { span: SpanItemState }).span.endedAt) as
    | number
    | null;
  const status = useAuiState(
    (s) => (s as unknown as { span: SpanItemState }).span.status,
  ) as SpanItemState["status"];
  const type = useAuiState((s) => (s as unknown as { span: SpanItemState }).span.type);
  const { selectedId } = useSelection();
  const isSelected = selectedId === id;

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
        stroke={isSelected ? "hsl(220 9% 25%)" : undefined}
        strokeWidth={isSelected ? 2 : 0}
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

type SelectionContextValue = {
  selectedId: string | null;
  select: (id: string | null) => void;
};

const SelectionContext = createContext<SelectionContextValue | null>(null);

function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("useSelection must be used inside SelectionContext");
  return ctx;
}

const TYPE_ICONS: Record<string, FC<{ className?: string }>> = {
  llm: BrainIcon,
  tool: WrenchIcon,
  node: BoxIcon,
  chain: LinkIcon,
  human: UserIcon,
};

const StatCard: FC<{ icon: React.ReactNode; label: string; value: string }> = ({
  icon,
  label,
  value,
}) => (
  <div className="border-border bg-muted/30 flex min-w-[5.5rem] flex-col gap-0.5 rounded-md border px-2.5 py-1.5">
    <div className="text-muted-foreground flex items-center gap-1 text-[10px] tracking-wide uppercase s line-clamp-1">
      {icon}
      <span className="overflow-hidden whitespace-nowrap text-ellipsis">{label}</span>
    </div>
    <div className="text-foreground tabular-nums text-sm leading-tight font-semibold">{value}</div>
  </div>
);

const TypeChip: FC<{ type: string; className?: string }> = ({ type, className = "" }) => {
  const color = TYPE_COLORS[type] ?? FALLBACK_COLOR;
  const Icon = TYPE_ICONS[type];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 rounded border px-1 text-[10px] leading-none font-medium ${className}`}
      style={{ color, borderColor: color, paddingTop: 2, paddingBottom: 2 }}
    >
      {Icon && <Icon className="size-2.5" />}
      {type}
    </span>
  );
};

const TypedBadge: FC = () => {
  const type = useAuiState((s) => (s as unknown as { span: SpanItemState }).span.type) as string;
  return <TypeChip type={type} />;
};

const STATUS_STYLE: Record<string, { color: string; bg: string; border: string }> = {
  completed: {
    color: "hsl(142 71% 45%)",
    bg: "hsl(142 71% 45% / 0.1)",
    border: "hsl(142 71% 45% / 0.3)",
  },
  running: {
    color: "hsl(217 91% 60%)",
    bg: "hsl(217 91% 60% / 0.1)",
    border: "hsl(217 91% 60% / 0.3)",
  },
  failed: { color: "hsl(0 84% 60%)", bg: "hsl(0 84% 60% / 0.1)", border: "hsl(0 84% 60% / 0.3)" },
  waiting: {
    color: "hsl(262 83% 58%)",
    bg: "hsl(262 83% 58% / 0.1)",
    border: "hsl(262 83% 58% / 0.3)",
  },
};

const StatusBadge: FC<{ status: string }> = ({ status }) => {
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.completed;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0 text-[9px] leading-[1.4] font-medium tracking-wide uppercase"
      style={{ color: style.color, backgroundColor: style.bg, border: `1px solid ${style.border}` }}
    >
      <span
        className="inline-block size-1.5 rounded-full"
        style={{ backgroundColor: style.color }}
      />
      {status}
    </span>
  );
};

const WaterfallRow: FC = () => {
  const { barWidth, contentWidth } = useWaterfallLayout();
  const id = useAuiState((s) => (s as unknown as { span: SpanItemState }).span.id);
  const { selectedId, select } = useSelection();
  const { setTooltip } = useTooltip();
  // ponytail: SpanItemState matches SpanData shape — read it once so
  // the hover/leave handlers have every field the popup needs without
  // re-running 7 useAuiState subscriptions per row.
  const spanData = useAuiState((s) => s.span as unknown as SpanItemState);
  const isSelected = selectedId === id;
  return (
    <SpanPrimitive.Root
      onClick={() => select(selectedId === id ? null : id)}
      onMouseEnter={(e) =>
        setTooltip({ x: e.clientX, y: e.clientY, data: spanData as unknown as SpanData })
      }
      onMouseMove={(e) =>
        setTooltip((prev) => (prev ? { ...prev, x: e.clientX, y: e.clientY } : prev))
      }
      onMouseLeave={() => setTooltip(null)}
      className={`group flex cursor-pointer items-center ${isSelected ? "bg-accent/60" : ""}`}
      style={{ width: contentWidth, height: BAR_HEIGHT }}
    >
      <SpanPrimitive.Indent
        baseIndent={8}
        indentPerLevel={12}
        className="border-border group-hover:bg-accent/50 sticky left-0 bg-background z-10 flex shrink-0 items-center gap-1 overflow-hidden border-r px-2 max-w-[50%] md:max-w-none"
        style={{ width: LABEL_WIDTH, height: BAR_HEIGHT }}
      >
        <AuiIf
          condition={(s) => (s as unknown as { span: { hasChildren: boolean } }).span.hasChildren}
        >
          <SpanPrimitive.CollapseToggle className="text-muted-foreground hover:text-foreground data-[collapsed=true]:-rotate-90 flex shrink-0 items-center justify-center rounded p-0.5 transition-transform">
            <svg aria-hidden className="size-3.5" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 6l4 4 4-4H4z" />
            </svg>
          </SpanPrimitive.CollapseToggle>
        </AuiIf>
        <AuiIf
          condition={(s) => !(s as unknown as { span: { hasChildren: boolean } }).span.hasChildren}
        >
          <span className="w-4.5 shrink-0" />
        </AuiIf>
        <TypedBadge />
        <SpanPrimitive.Name className="truncate text-sm" />
      </SpanPrimitive.Indent>

      <div
        className="group-hover:bg-accent/30 overflow-hidden md:overflow-visible max-w-[50%] md:max-w-none"
        style={{ width: barWidth, height: BAR_HEIGHT }}
      >
        <svg aria-hidden width={barWidth} height={BAR_HEIGHT}>
          <WaterfallBar />
        </svg>
      </div>
    </SpanPrimitive.Root>
  );
};

const RunningSkeletonRow: FC = () => {
  const { contentWidth } = useWaterfallLayout();
  return (
    <div
      className="flex animate-pulse items-center"
      style={{ width: contentWidth, height: BAR_HEIGHT }}
      aria-label="Background agent still running"
    >
      <div
        className="border-border flex shrink-0 items-center gap-1.5 overflow-hidden border-r px-2 max-w-[50%] md:max-w-none"
        style={{ width: LABEL_WIDTH, height: BAR_HEIGHT }}
      >
        <div className="bg-muted/60 size-6 shrink-0 rounded-sm" />
        <div className="bg-muted/70 h-6 w-14 shrink-0 rounded-sm" />
        <div className="bg-muted/70 h-6 w-full rounded-sm" />
      </div>
      <div className="flex flex-1 items-center px-2" style={{ height: BAR_HEIGHT }}>
        <div className="bg-muted/70 h-6 w-full rounded-sm" />
      </div>
    </div>
  );
};

const WaterfallTimeline: FC<{ retentionDays: number | null; stillRunning: boolean }> = ({
  retentionDays,
  stillRunning,
}) => {
  const outerRef = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(400);
  // ponytail: hover tooltip state, scoped per timeline. Each row's
  // onMouseEnter writes its (x, y, data) here; onMouseMove just
  // updates x/y; onMouseLeave clears. Popup reads only SpanData — no
  // raw CapturedSpan fetch (hover is too cheap to deserve that).
  const [tooltip, setTooltip] = useState<TooltipState>(null);

  const hasSpans = useAuiState(
    (s) => (s as unknown as { span: { hasChildren: boolean } }).span.hasChildren,
  );
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
      <div className="border-border bg-muted/10 flex flex-col items-center justify-center rounded-lg border py-16 px-4 text-center">
        <div className="bg-muted/30 border-border mb-4 flex size-12 items-center justify-center rounded-full border shadow-sm">
          <Activity className="text-muted-foreground/60 size-5 animate-pulse" />
        </div>
        <h3 className="text-foreground text-sm font-semibold">No traces captured</h3>
        <p className="text-muted-foreground mt-1.5 max-w-[300px] text-xs leading-relaxed">
          Spans will appear here once the agent starts running model or tool invocations in this
          thread.
        </p>
      </div>
    );
  }

  return (
    <TooltipContext.Provider value={{ tooltip, setTooltip }}>
      <div
        ref={outerRef}
        className="border-border relative overflow-x-auto overflow-y-hidden rounded-lg border"
      >
        <div
          className="border-border bg-background md:sticky md:top-0 md:z-20 flex border-b"
          style={{ width: contentWidth }}
        >
          <div
            className="border-border bg-background text-muted-foreground sticky left-0 z-30 shrink-0 overflow-hidden border-r px-2 py-1.5 text-xs max-w-[50%] md:max-w-none"
            style={{ width: LABEL_WIDTH }}
          >
            Span
          </div>
          <div
            className="overflow-hidden md:overflow-visible max-w-[50%] md:max-w-none"
            style={{ width: barWidth, height: 28 }}
          >
            <TimeAxisTicks timeRange={renderTimeRange} barWidth={barWidth} />
          </div>
        </div>

        <WaterfallLayoutContext.Provider value={layout}>
          <div className="py-1.5" style={{ width: contentWidth }}>
            <SpanPrimitive.Children>{() => <WaterfallRow />}</SpanPrimitive.Children>
            {stillRunning ? <RunningSkeletonRow /> : null}
          </div>
        </WaterfallLayoutContext.Provider>

        <div className="border-border text-muted-foreground border-t text-xs sticky left-0 ">
          <div className="flex items-center gap-2 px-2 py-2">
            {LEGEND_TYPE_ORDER.map((t) => (
              <TypeChip key={t} type={t} />
            ))}
          </div>
          {retentionDays != null && (
            <div className="border-border border-t px-2 py-1.5">
              Spans are retained for {retentionDays} day{retentionDays === 1 ? "" : "s"}; data older
              than that is removed on the next retention cleanup.
            </div>
          )}
        </div>
      </div>
      <TooltipPopup />
    </TooltipContext.Provider>
  );
};

// ---------------------------------------------------------------------------
// ponytail: details panel — render only the fields each kind of span has.
// LLM → time + token breakdown (LangSmith-shaped).
// Tool → time + input args + output.
// Node  → time + children summary.
// Chain → time.
// ---------------------------------------------------------------------------

// ponytail: hover popup. Pulls a SpanData subset (chip + name +
// time + duration + status) and positions itself at the cursor. Walks
// the field-declaration schema's `tooltip: true` rows for parity with
// the detail panel — without `usage` / `meta` on the wire, only the
// time/status rows surface here; ttft / tokens / model still live in
// the click-detail card.
//
// ponytail: naive `left: x + EDGE` overflows the right edge when the
// row sits near the viewport's right gutter. Measure rendered width
// after layout and flip to cursor-left when it doesn't fit.
const TooltipPopup: FC = () => {
  const { tooltip } = useTooltip();
  const ref = useRef<HTMLDivElement | null>(null);
  const [flip, setFlip] = useState(false);
  useEffect(() => {
    if (!tooltip || !ref.current) return;
    const w = ref.current.offsetWidth;
    const EDGE = 12;
    setFlip(w > 0 && tooltip.x + EDGE + w > window.innerWidth - 4);
  }, [tooltip]);
  if (!tooltip) return null;
  const { data, x, y } = tooltip;
  const EDGE = 12;
  const style = flip
    ? {
        left: Math.max(4, x - EDGE - (ref.current?.offsetWidth ?? 0)),
        top: y + EDGE,
      }
    : { left: x + EDGE, top: y + EDGE };

  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: "Start", value: compactTime(data.startedAt), mono: true },
  ];
  if (data.endedAt != null) {
    rows.push({ label: "End", value: compactTime(data.endedAt), mono: true });
  }
  if (data.latencyMs != null) {
    rows.push({ label: "Duration", value: formatDuration(data.latencyMs), mono: true });
  }

  return (
    <div
      ref={ref}
      role="tooltip"
      className="border-border bg-popover text-popover-foreground pointer-events-none fixed z-50 hidden max-w-xs rounded-md border px-3 py-2.5 text-xs shadow-md md:block"
      style={style}
    >
      <div className="flex items-center gap-1.5 pb-1.5">
        <TypeChip type={data.type} />
        <span className="truncate font-medium">{data.name}</span>
      </div>
      <div className="border-border grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 border-t pt-1.5 font-mono text-[10px]">
        {rows.map((r) => (
          <TooltipRow key={r.label} row={r} />
        ))}
      </div>
    </div>
  );
};

const TooltipRow: FC<{ row: { label: string; value: string; mono?: boolean } }> = ({ row }) => (
  <>
    <span className="text-muted-foreground">{row.label}</span>
    <span className="truncate text-right">{row.value}</span>
  </>
);

type TokenBreakdown = {
  input: number;
  output: number;
  total: number;
  cache_read: number;
  reasoning: number;
};

function readTokens(usage: Record<string, unknown> | null | undefined): TokenBreakdown | null {
  if (!usage) return null;
  const u = usage as Record<string, unknown>;
  const input = (u.input_tokens as number | undefined) ?? 0;
  const output = (u.output_tokens as number | undefined) ?? 0;
  const total = (u.total_tokens as number | undefined) ?? input + output;
  const inputDetails = (u.input_token_details as Record<string, unknown> | undefined) ?? {};
  const outputDetails = (u.output_token_details as Record<string, unknown> | undefined) ?? {};
  return {
    input,
    output,
    total,
    cache_read: (inputDetails.cache_read as number | undefined) ?? 0,
    reasoning: (outputDetails.reasoning as number | undefined) ?? 0,
  };
}

function readStructuredOutput(span: CapturedSpan): { path: string; value: unknown }[] | null {
  if (span.kind !== "llm") return null;
  const out = span.output as unknown;
  if (!out || typeof out !== "object") return null;
  const generations = (out as Record<string, unknown>).generations;
  if (!Array.isArray(generations) || !generations[0]?.[0]) return null;
  const gen = generations[0][0] as Record<string, unknown>;
  const msg = gen.message as Record<string, unknown> | undefined;
  if (!msg) return null;

  const content = msg.content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return flattenFields(content);
  }

  const ak = msg.additional_kwargs as Record<string, unknown> | undefined;
  if (ak) {
    for (const key of ["structured_response", "structured_output", "parsed"] as const) {
      if (ak[key] && typeof ak[key] === "object") return flattenFields(ak[key]);
    }
  }

  const tcs = msg.tool_calls;
  if (Array.isArray(tcs) && tcs[0]) {
    const args = (tcs[0] as Record<string, unknown>).args;
    if (args && typeof args === "object") return flattenFields(args);
  }
  return null;
}

function flattenFields(v: unknown, prefix = ""): { path: string; value: unknown }[] {
  if (v === null || v === undefined) return [{ path: prefix || "(value)", value: v }];
  if (typeof v !== "object") return [{ path: prefix || "(value)", value: v }];
  if (Array.isArray(v)) {
    if (v.length === 0) return [{ path: prefix || "(array)", value: [] }];
    return [{ path: prefix || "(array)", value: `[${v.length} items]` }];
  }
  const out: { path: string; value: unknown }[] = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (val === null || val === undefined || typeof val !== "object") {
      out.push({ path: p, value: val });
    } else if (Array.isArray(val)) {
      out.push({ path: p, value: `[${val.length} items]` });
    } else {
      out.push({ path: p, value: "{...}" });
    }
  }
  return out;
}

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

type FieldValue =
  | { kind: "text"; text: string; mono?: boolean }
  | { kind: "code"; data: unknown; maxHeight?: number }
  | { kind: "tokens"; tokens: TokenBreakdown }
  | { kind: "messages"; entries: MessageEntry[] }
  | { kind: "structured"; fields: { path: string; value: unknown }[] }
  | { kind: "badge"; text: string; color?: string }
  | { kind: "raw"; node: React.ReactNode };

type ResolvedRow = {
  id: string;
  label: string;
  value: FieldValue;
  details: boolean;
  bare: boolean;
};

type ResolvedSection = {
  id: string;
  title: string;
  rows: ResolvedRow[];
};

type FieldDef = {
  id: string;
  label: string;
  show?: (span: CapturedSpan) => boolean;
  value: (span: CapturedSpan) => FieldValue | null;
  details?: boolean;
  bare?: boolean;
};

type SectionDef = {
  id: string;
  title: string;
  fields: FieldDef[];
};

function resolveSections(span: CapturedSpan, sections: SectionDef[]): ResolvedSection[] {
  const out: ResolvedSection[] = [];
  for (const s of sections) {
    const rows: ResolvedRow[] = [];
    for (const f of s.fields) {
      if (f.show && !f.show(span)) continue;
      const v = f.value(span);
      if (v === null) continue;
      rows.push({
        id: `${s.id}.${f.id}`,
        label: f.label,
        value: v,
        details: f.details !== false,
        bare: !!f.bare,
      });
    }
    if (rows.length > 0) out.push({ id: s.id, title: s.title, rows });
  }
  return out;
}

function compactTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const DetailRow: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="text-sm">
    <div className="text-muted-foreground text-xs">{label}</div>
    <div className="mt-0.5 min-w-0">{children}</div>
  </div>
);

const DetailSection: FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="border-border space-y-3 border-t pt-3 first:border-t-0 first:pt-0">
    <div className="text-muted-foreground text-[10px] tracking-wider uppercase">{title}</div>
    {children}
  </div>
);

const TokenBreakdownView: FC<{ tokens: TokenBreakdown }> = ({ tokens }) => {
  const total = tokens.total || tokens.input + tokens.output;
  const inputPct = Math.round((tokens.input / Math.max(total, 1)) * 100);
  const outputPct = 100 - inputPct;
  return (
    <div className="text-xs">
      <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 py-1">
        <div className="text-muted-foreground">Input</div>
        <div className="text-right tabular-nums">
          <span>{inputPct}%</span>
          <span className="text-muted-foreground"> · </span>
          <span className="font-medium">{fmt(tokens.input)}</span>
          {tokens.cache_read > 0 && (
            <>
              <span className="text-muted-foreground"> · </span>
              <span className="text-muted-foreground">cache {fmt(tokens.cache_read)}</span>
            </>
          )}
        </div>
      </div>
      <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 py-1">
        <div className="text-muted-foreground">Output</div>
        <div className="text-right tabular-nums">
          <span>{outputPct}%</span>
          <span className="text-muted-foreground"> · </span>
          <span className="font-medium">{fmt(tokens.output)}</span>
          {tokens.reasoning > 0 && (
            <>
              <span className="text-muted-foreground"> · </span>
              <span className="text-muted-foreground">reasoning {fmt(tokens.reasoning)}</span>
            </>
          )}
        </div>
      </div>
      <div className="text-muted-foreground grid grid-cols-[auto_1fr] items-baseline gap-x-3 py-1">
        <span>Total</span>
        <span className="text-right font-medium tabular-nums">{fmt(total)}</span>
      </div>
    </div>
  );
};

const JsonBlock: FC<{ data: unknown; maxHeight?: number }> = ({ data, maxHeight = 240 }) => (
  <pre
    className="bg-muted/50 text-foreground overflow-auto rounded-md p-2.5 text-xs whitespace-pre-wrap"
    style={{ maxHeight }}
  >
    {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
  </pre>
);

const CopyJsonButton = CopyButton;

// ponytail: per-entry open state lives in this component so the click
// handler drives both the chevron rotation and the grid-rows body
// animation off one source. <details open={...}> stays controlled —
// Tailwind v4's `group-open:` variant + arbitrary
// `transition-[grid-template-rows]` didn't animate reliably in this
// build, so the JS state path is the simpler, working one.
const MessageList: FC<{ entries: MessageEntry[] }> = ({ entries }) => {
  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set());
  const toggle = (i: number, next: boolean) =>
    setOpenIds((prev) => {
      const out = new Set(prev);
      if (next) out.add(i);
      else out.delete(i);
      return out;
    });
  return (
    <div className="space-y-2">
      {entries.map((entry, i) => {
        const isOpen = openIds.has(i);
        return (
          <details
            key={i}
            open={isOpen}
            onToggle={(e) => toggle(i, e.currentTarget.open)}
            className="text-xs"
          >
            <summary className="bg-muted/40 relative flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 pr-20 font-medium capitalize [&::-webkit-details-marker]:hidden [&::marker]:hidden">
              <svg
                aria-hidden
                viewBox="0 0 12 12"
                className={cn(
                  "text-muted-foreground size-3 shrink-0 transition-transform duration-200 ease-out",
                  isOpen && "rotate-90",
                )}
                fill="currentColor"
              >
                <path d="M3 2l7 4-7 4z" />
              </svg>
              <span>{entry.role}</span>
              {entry.isNew && (
                <span className="bg-primary text-primary-foreground absolute top-1/2 right-1.5 inline-flex -translate-y-1/2 items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider uppercase">
                  New
                </span>
              )}
            </summary>
            <div
              className={cn(
                "grid transition-[grid-template-rows] duration-200 ease-out",
                isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
              )}
            >
              <div className="overflow-hidden">
                <pre className="text-foreground mt-1 overflow-auto px-1.5 py-1 text-xs whitespace-pre-wrap">
                  {entry.body}
                </pre>
              </div>
            </div>
          </details>
        );
      })}
    </div>
  );
};

const FieldRenderer: FC<{ value: FieldValue }> = ({ value }) => {
  switch (value.kind) {
    case "text": {
      const cls = value.mono ? "font-mono text-xs" : "text-muted-foreground text-xs";
      return <span className={cls}>{value.text}</span>;
    }
    case "badge": {
      const c = value.color ?? FALLBACK_COLOR;
      return (
        <span
          className="inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[11px] font-medium"
          style={{ color: c, borderColor: c }}
        >
          {value.text}
        </span>
      );
    }
    case "code": {
      const text =
        typeof value.data === "string" ? value.data : JSON.stringify(value.data, null, 2);
      return (
        <div className="relative">
          <CopyJsonButton
            getTextAction={() => text}
            label="Copy JSON"
            className="absolute top-1.5 right-1.5 z-10"
          />
          <JsonBlock data={value.data} maxHeight={value.maxHeight ?? 240} />
        </div>
      );
    }
    case "tokens":
      return <TokenBreakdownView tokens={value.tokens} />;
    case "messages":
      return <MessageList entries={value.entries} />;
    case "structured": {
      const json = value.fields.reduce<Record<string, unknown>>((acc, f) => {
        acc[f.path] = f.value;
        return acc;
      }, {});
      return (
        <div className="flex items-start gap-1.5">
          <div
            className="border-border flex-1 overflow-auto rounded-md border"
            style={{ maxHeight: 240 }}
          >
            {value.fields.map((f, i) => (
              <div
                key={i}
                className="border-border flex items-baseline gap-3 border-b px-3 py-2 text-xs last:border-b-0"
              >
                <span className="text-muted-foreground shrink-0 font-mono">{f.path}</span>
                <span
                  className="text-foreground ml-auto min-w-0 text-right font-mono break-words"
                  title={String(f.value)}
                >
                  {typeof f.value === "string" ? f.value : JSON.stringify(f.value)}
                </span>
              </div>
            ))}
          </div>
          <CopyJsonButton
            getTextAction={() => JSON.stringify(json, null, 2)}
            label="Copy fields"
            className="mt-1.5"
          />
        </div>
      );
    }
    case "raw":
      return <>{value.node}</>;
  }
};

function readTtftMs(span: CapturedSpan): number | null {
  const v = (span.meta as Record<string, unknown> | null | undefined)?.time_to_first_token_ms;
  return typeof v === "number" && v > 0 ? v : null;
}

const DETAIL_SECTIONS_BY_KIND: Record<CapturedSpan["kind"], SectionDef[]> = {
  llm: [
    {
      id: "time",
      title: "Time",
      fields: [
        {
          id: "start",
          label: "Start",
          value: (s) => ({ kind: "text", text: compactTime(s.started_at) }),
        },
        {
          id: "end",
          label: "End",
          show: (s) => s.ended_at != null,
          value: (s) => ({ kind: "text", text: compactTime(s.ended_at as number) }),
        },
        {
          id: "duration",
          label: "Duration",
          show: (s) => s.ended_at != null,
          value: (s) => ({
            kind: "text",
            text: formatDuration((s.ended_at as number) - s.started_at),
          }),
        },
        {
          id: "ttft",
          label: "Time to first token",
          show: (s) => readTtftMs(s) != null,
          value: (s) => ({ kind: "text", text: formatDuration(readTtftMs(s) as number) }),
        },
      ],
    },
    {
      id: "context",
      title: "Context",
      fields: [
        {
          id: "step",
          label: "Step",
          show: (s) => typeof s.meta?.langgraph_step === "number",
          value: (s) => ({
            kind: "raw",
            node: (
              <>
                <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                  {`graph:step:${String(s.meta?.langgraph_step)}`}
                </span>
                {typeof s.meta?.aggregated_children === "number" &&
                  (s.meta.aggregated_children as number) > 1 && (
                    <span className="text-muted-foreground ml-2 text-xs">
                      (× {String(s.meta.aggregated_children)})
                    </span>
                  )}
              </>
            ),
          }),
        },
        {
          id: "model",
          label: "Model",
          show: (s) => typeof s.meta?.ls_model_name === "string",
          value: (s) => ({
            kind: "badge",
            text: s.meta?.ls_model_name as string,
            color: TYPE_COLORS.llm,
          }),
        },
      ],
    },
    {
      id: "tokens",
      title: "Total cost breakdown",
      fields: [
        {
          id: "tokens",
          label: "",
          bare: true,
          show: (s) => readTokens(s.usage) != null,
          value: (s) => ({ kind: "tokens", tokens: readTokens(s.usage) as TokenBreakdown }),
        },
      ],
    },
    {
      id: "messages",
      title: "Messages",
      fields: [
        {
          id: "messages",
          label: "",
          bare: true,
          show: (s) => buildLlmMessages(s).length > 0,
          value: (s) => ({
            kind: "messages",
            entries: buildLlmMessages(s),
          }),
        },
      ],
    },
    {
      id: "structured",
      title: "Fields",
      fields: [
        {
          id: "fields",
          label: "Fields",
          show: (s) => {
            const f = readStructuredOutput(s);
            return f != null && f.length > 0;
          },
          value: (s) => ({
            kind: "structured",
            fields: readStructuredOutput(s) as { path: string; value: unknown }[],
          }),
        },
      ],
    },
  ],
  tool: [
    {
      id: "time",
      title: "Time",
      fields: [
        {
          id: "start",
          label: "Start",
          value: (s) => ({ kind: "text", text: compactTime(s.started_at) }),
        },
        {
          id: "end",
          label: "End",
          show: (s) => s.ended_at != null,
          value: (s) => ({ kind: "text", text: compactTime(s.ended_at as number) }),
        },
        {
          id: "duration",
          label: "Duration",
          show: (s) => s.ended_at != null,
          value: (s) => ({
            kind: "text",
            text: formatDuration((s.ended_at as number) - s.started_at),
          }),
        },
      ],
    },
    {
      id: "context",
      title: "Context",
      fields: [
        {
          id: "step",
          label: "Step",
          show: (s) => typeof s.meta?.langgraph_step === "number",
          value: (s) => ({
            kind: "raw",
            node: (
              <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                {`graph:step:${String(s.meta?.langgraph_step)}`}
              </span>
            ),
          }),
        },
        {
          id: "tags",
          label: "Tags",
          show: (s) => {
            const tags = s.meta?.tags;
            return Array.isArray(tags) && tags.length > 0;
          },
          value: (s) => {
            const tags = s.meta?.tags as string[] | undefined;
            return { kind: "text", text: (tags ?? []).join(", "), mono: true };
          },
        },
      ],
    },
    {
      id: "payload",
      title: "Payload",
      fields: [
        {
          id: "input",
          label: "Input",
          show: (s) => s.input != null,
          value: (s) => ({ kind: "code", data: s.input, maxHeight: 240 }),
        },
        {
          id: "output",
          label: "Output",
          show: (s) => s.output != null,
          value: (s) => ({ kind: "code", data: s.output, maxHeight: 240 }),
        },
      ],
    },
  ],
  node: [
    {
      id: "time",
      title: "Time",
      fields: [
        {
          id: "start",
          label: "Start",
          value: (s) => ({ kind: "text", text: compactTime(s.started_at) }),
        },
        {
          id: "end",
          label: "End",
          show: (s) => s.ended_at != null,
          value: (s) => ({ kind: "text", text: compactTime(s.ended_at as number) }),
        },
        {
          id: "duration",
          label: "Duration",
          show: (s) => s.ended_at != null,
          value: (s) => ({
            kind: "text",
            text: formatDuration((s.ended_at as number) - s.started_at),
          }),
        },
      ],
    },
    {
      id: "context",
      title: "Context",
      fields: [
        {
          id: "step",
          label: "Step",
          show: (s) => typeof s.meta?.langgraph_step === "number",
          value: (s) => ({
            kind: "raw",
            node: (
              <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                {`graph:step:${String(s.meta?.langgraph_step)}`}
              </span>
            ),
          }),
        },
        {
          id: "name",
          label: "Name",
          show: (s) =>
            typeof s.meta?.langgraph_node === "string" && s.name !== s.meta.langgraph_node,
          value: (s) => ({ kind: "text", text: s.name, mono: true }),
        },
        {
          id: "node",
          label: "Node",
          show: (s) =>
            typeof s.meta?.langgraph_node === "string" && s.meta.langgraph_node !== s.name,
          value: (s) => ({ kind: "text", text: s.meta?.langgraph_node as string, mono: true }),
        },
        {
          id: "ns",
          label: "NS",
          show: (s) =>
            typeof s.meta?.langgraph_checkpoint_ns === "string" && !!s.meta.langgraph_checkpoint_ns,
          value: (s) => ({
            kind: "text",
            text: s.meta?.langgraph_checkpoint_ns as string,
            mono: true,
          }),
        },
      ],
    },
    {
      id: "payload",
      title: "Payload",
      fields: [
        {
          id: "input",
          label: "Input",
          show: (s) => s.input != null,
          value: (s) => ({ kind: "code", data: s.input, maxHeight: 240 }),
        },
        {
          id: "output",
          label: "Output",
          show: (s) => s.output != null,
          value: (s) => ({ kind: "code", data: s.output, maxHeight: 240 }),
        },
      ],
    },
  ],
  chain: [
    {
      id: "time",
      title: "Time",
      fields: [
        {
          id: "start",
          label: "Start",
          value: (s) => ({ kind: "text", text: compactTime(s.started_at) }),
        },
        {
          id: "end",
          label: "End",
          show: (s) => s.ended_at != null,
          value: (s) => ({ kind: "text", text: compactTime(s.ended_at as number) }),
        },
        {
          id: "duration",
          label: "Duration",
          show: (s) => s.ended_at != null,
          value: (s) => ({
            kind: "text",
            text: formatDuration((s.ended_at as number) - s.started_at),
          }),
        },
      ],
    },
    {
      id: "context",
      title: "Context",
      fields: [
        {
          id: "step",
          label: "Step",
          show: (s) => typeof s.meta?.langgraph_step === "number",
          value: (s) => ({
            kind: "raw",
            node: (
              <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                {`graph:step:${String(s.meta?.langgraph_step)}`}
              </span>
            ),
          }),
        },
        {
          id: "name",
          label: "Name",
          show: (s) =>
            typeof s.meta?.langgraph_node === "string" && s.name !== s.meta.langgraph_node,
          value: (s) => ({ kind: "text", text: s.name, mono: true }),
        },
        {
          id: "ns",
          label: "NS",
          show: (s) =>
            typeof s.meta?.langgraph_checkpoint_ns === "string" && !!s.meta.langgraph_checkpoint_ns,
          value: (s) => ({
            kind: "text",
            text: s.meta?.langgraph_checkpoint_ns as string,
            mono: true,
          }),
        },
      ],
    },
    {
      id: "payload",
      title: "Payload",
      fields: [
        {
          id: "input",
          label: "Input",
          show: (s) => s.input != null,
          value: (s) => ({ kind: "code", data: s.input, maxHeight: 240 }),
        },
        {
          id: "output",
          label: "Output",
          show: (s) => s.output != null,
          value: (s) => ({ kind: "code", data: s.output, maxHeight: 240 }),
        },
      ],
    },
  ],
  human: [
    {
      id: "time",
      title: "Time",
      fields: [
        {
          id: "start",
          label: "Start",
          value: (s) => ({ kind: "text", text: compactTime(s.started_at) }),
        },
        {
          id: "end",
          label: "End",
          show: (s) => s.ended_at != null,
          value: (s) => ({ kind: "text", text: compactTime(s.ended_at as number) }),
        },
        {
          id: "duration",
          label: "Duration",
          show: (s) => s.ended_at != null,
          value: (s) => ({
            kind: "text",
            text: formatDuration((s.ended_at as number) - s.started_at),
          }),
        },
      ],
    },
    {
      id: "context",
      title: "Context",
      fields: [
        {
          id: "step",
          label: "Step",
          show: (s) => typeof s.meta?.langgraph_step === "number",
          value: (s) => ({
            kind: "raw",
            node: (
              <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                {`graph:step:${String(s.meta?.langgraph_step)}`}
              </span>
            ),
          }),
        },
        {
          id: "name",
          label: "Name",
          show: (s) =>
            typeof s.meta?.langgraph_node === "string" && s.name !== s.meta.langgraph_node,
          value: (s) => ({ kind: "text", text: s.name, mono: true }),
        },
        {
          id: "tool",
          label: "Awaited tool",
          show: (s) => typeof s.meta?.interrupt_tool === "string",
          value: (s) => ({ kind: "text", text: s.meta?.interrupt_tool as string, mono: true }),
        },
      ],
    },
  ],
  retriever: [
    {
      id: "time",
      title: "Time",
      fields: [
        {
          id: "start",
          label: "Start",
          value: (s) => ({ kind: "text", text: compactTime(s.started_at) }),
        },
        {
          id: "end",
          label: "End",
          show: (s) => s.ended_at != null,
          value: (s) => ({ kind: "text", text: compactTime(s.ended_at as number) }),
        },
        {
          id: "duration",
          label: "Duration",
          show: (s) => s.ended_at != null,
          value: (s) => ({
            kind: "text",
            text: formatDuration((s.ended_at as number) - s.started_at),
          }),
        },
      ],
    },
  ],
  unknown: [
    {
      id: "time",
      title: "Time",
      fields: [
        {
          id: "start",
          label: "Start",
          value: (s) => ({ kind: "text", text: compactTime(s.started_at) }),
        },
        {
          id: "end",
          label: "End",
          show: (s) => s.ended_at != null,
          value: (s) => ({ kind: "text", text: compactTime(s.ended_at as number) }),
        },
        {
          id: "duration",
          label: "Duration",
          show: (s) => s.ended_at != null,
          value: (s) => ({
            kind: "text",
            text: formatDuration((s.ended_at as number) - s.started_at),
          }),
        },
      ],
    },
  ],
};

const ResolvedSections: FC<{ sections: ResolvedSection[] }> = ({ sections }) => {
  const visibleSections = sections
    .map((s) => ({ ...s, rows: s.rows.filter((r) => r.details) }))
    .filter((s) => s.rows.length > 0);
  return (
    <>
      {visibleSections.map((s) => (
        <DetailSection key={s.id} title={s.title}>
          {s.rows.map((r) =>
            r.bare ? (
              <FieldRenderer key={r.id} value={r.value} />
            ) : (
              <DetailRow key={r.id} label={r.label}>
                <FieldRenderer value={r.value} />
              </DetailRow>
            ),
          )}
        </DetailSection>
      ))}
    </>
  );
};

const SpanDetails: FC<{ span: CapturedSpan }> = ({ span }) => {
  const meta = span.meta ?? {};
  const node = (meta.langgraph_node as string | undefined) ?? null;
  const sections = resolveSections(span, DETAIL_SECTIONS_BY_KIND[span.kind]);
  return (
    <div className="border-border bg-card space-y-3 rounded-lg border p-4 text-sm">
      <div className="space-y-1.5">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-semibold">
            {span.kind === "llm" ||
            span.kind === "tool" ||
            span.kind === "human" ||
            span.kind === "retriever"
              ? span.name
              : (node ?? span.name)}
          </span>
          {node &&
            span.name !== node &&
            (span.kind === "llm" ||
              span.kind === "tool" ||
              span.kind === "human" ||
              span.kind === "retriever") && (
              <span className="text-muted-foreground shrink-0 text-xs">@{node}</span>
            )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <TypeChip type={span.kind} />
            <span className="font-mono text-[10px]">id={span.span_id.slice(0, 8)}</span>
          </div>
          <StatusBadge status={span.status} />
        </div>
      </div>

      <ResolvedSections sections={sections} />

      {span.error && (
        <DetailSection title="Error">
          <pre className="text-destructive overflow-auto rounded-md bg-destructive/10 p-2 text-xs whitespace-pre-wrap">
            {span.error}
          </pre>
        </DetailSection>
      )}
    </div>
  );
};

const DetailLoadingSkeleton: FC = () => (
  <div className="border-border bg-card animate-pulse space-y-4 rounded-lg border p-4">
    {/* header — name + chip + id + status badge */}
    <div className="space-y-2">
      <div className="bg-muted/50 h-5 w-48 rounded-sm" />
      <div className="flex items-center gap-2">
        <div className="bg-muted/50 h-4 w-12 rounded-sm" />
        <div className="bg-muted/50 h-3 w-24 rounded-sm" />
      </div>
    </div>

    {/* TIME section */}
    <div className="space-y-2 border-t pt-3">
      <div className="bg-muted/40 h-2.5 w-12 rounded-sm" />
      <div className="space-y-1.5">
        <div className="bg-muted/50 h-3 w-44 rounded-sm" />
        <div className="bg-muted/50 h-3 w-44 rounded-sm" />
        <div className="bg-muted/50 h-3 w-20 rounded-sm" />
      </div>
    </div>

    {/* CONTEXT section */}
    <div className="space-y-2 border-t pt-3">
      <div className="bg-muted/40 h-2.5 w-16 rounded-sm" />
      <div className="space-y-1.5">
        <div className="bg-muted/50 h-3 w-32 rounded-sm" />
        <div className="bg-muted/50 h-3 w-40 rounded-sm" />
      </div>
    </div>

    {/* TOTAL COST BREAKDOWN */}
    <div className="space-y-2 border-t pt-3">
      <div className="bg-muted/40 h-2.5 w-36 rounded-sm" />
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="bg-muted/50 h-3 w-10 rounded-sm" />
          <div className="bg-muted/50 h-3 w-24 rounded-sm" />
        </div>
        <div className="flex items-center justify-between">
          <div className="bg-muted/50 h-3 w-12 rounded-sm" />
          <div className="bg-muted/50 h-3 w-28 rounded-sm" />
        </div>
        <div className="flex items-center justify-between">
          <div className="bg-muted/50 h-3 w-10 rounded-sm" />
          <div className="bg-muted/50 h-3 w-16 rounded-sm" />
        </div>
      </div>
    </div>

    {/* MESSAGES section */}
    <div className="space-y-2 border-t pt-3">
      <div className="bg-muted/40 h-2.5 w-16 rounded-sm" />
      <div className="space-y-1.5">
        <div className="bg-muted/50 h-6 w-full rounded-sm" />
        <div className="bg-muted/50 h-6 w-3/4 rounded-sm" />
        <div className="bg-muted/50 h-6 w-5/6 rounded-sm" />
      </div>
    </div>

    {/* FIELDS section */}
    <div className="space-y-2 border-t pt-3">
      <div className="bg-muted/40 h-2.5 w-12 rounded-sm" />
      <div className="bg-muted/50 h-3 w-full rounded-sm" />
    </div>
  </div>
);

const DetailError: FC<{ message: string }> = ({ message }) => (
  <div className="border-border bg-card space-y-2 rounded-lg border p-4 text-sm">
    <div className="text-destructive text-xs">Failed to load span detail</div>
    <div className="text-muted-foreground text-xs">{message}</div>
  </div>
);

// ponytail: glassy refresh veil painted over the existing details card
// while a refetch is in flight. Avoids the unmount→skeleton→remount
// flicker the user reported when re-clicking a row. Border-radius
// matches the card chrome so the corners align under the overlay.
const DetailRefreshOverlay: FC = () => (
  <div
    aria-live="polite"
    className="border-border bg-background/60 absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-lg backdrop-blur-[2px] animate-pulse"
  >
    <Loader2Icon className="text-muted-foreground size-8 shrink-0 animate-spin" />
    <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
      Refreshing
    </span>
  </div>
);

export const ObservabilityPanel: FC<ObservabilityPanelProps> = ({
  spans,
  aggregate,
  stepIdToRawSpanId,
  retentionDays,
  stillRunning,
  threadId,
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSpan, setSelectedSpan] = useState<CapturedSpan | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [selectedError, setSelectedError] = useState<string | null>(null);

  const aui = useAui({ span: SpanResource({ spans }) } as unknown as Parameters<typeof useAui>[0]);

  // ponytail: reset selection + cached detail on a new span set (e.g. when
  // sheet context switches to a different thread).
  useEffect(() => {
    setSelectedId(null);
    setSelectedSpan(null);
    setSelectedLoading(false);
    setSelectedError(null);
  }, [spans]);

  // ponytail: second-click on a selected row toggles selectedId back
  // to null (see WaterfallRow's onClick). Clear the cached detail +
  // loading flag in lockstep — otherwise the panel keeps showing the
  // previously-fetched span after the user deselected.
  useEffect(() => {
    if (selectedId !== null) return;
    setSelectedSpan(null);
    setSelectedLoading(false);
    setSelectedError(null);
  }, [selectedId]);

  // ponytail: build a synthetic-id → parent_message_id map from the
  // spans we already have. The transform layer stamps parentMessageId
  // on every SpanData (root + step wrapper + leaf), so a single
  // reduce is enough — no extra prop / sidecar. Used to build the
  // per-turn detail URL.
  const stepIdToParentMessageId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of spans) {
      if (s.parentMessageId) map[s.id] = s.parentMessageId;
    }
    return map;
  }, [spans]);

  // ponytail: lazy-fetch the clicked span's full payload. The waterfall
  // shows SpanData[] (server-transformed), but SpanDetails needs the raw
  // CapturedSpan to render input / output / usage / meta. Translate the
  // synthetic step-wrapper id → raw span_id via the prop map.
  useEffect(() => {
    if (!selectedId || !threadId) return;
    const rawSpanId = stepIdToRawSpanId[selectedId] ?? selectedId;
    // ponytail: every row carries parentMessageId on the wire. Step
    // wrappers (synthetic ids) and leaves both have it — the
    // transform layer reads it from meta on each push. If the row is
    // legacy / partial-capture and lacks the field, the detail URL
    // would 404 — a clean signal to the user.
    const parentMessageId = stepIdToParentMessageId[selectedId];
    if (!parentMessageId) {
      setSelectedError("Span is missing a parent_message_id; cannot resolve detail");
      setSelectedLoading(false);
      return;
    }
    const ac = new AbortController();
    // ponytail: leave the previous SpanDetails in place while the new
    // fetch resolves — the render branch paints a glassy overlay on
    // top, so the user sees a shimmer over the old card instead of a
    // skeleton→empty→new card flicker. (First-load, when there's no
    // prior span, falls through to the DetailLoadingSkeleton.)
    setSelectedLoading(true);
    setSelectedError(null);
    fetch(
      `/api/threads/${threadId}/observability/${encodeURIComponent(parentMessageId)}/spans/${encodeURIComponent(rawSpanId)}`,
      {
        credentials: "include",
        signal: ac.signal,
      },
    )
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load (${res.status})`);
        return res.json() as Promise<{ span: CapturedSpan }>;
      })
      .then((body) => {
        if (ac.signal.aborted) return;
        setSelectedSpan(body.span);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setSelectedError(e instanceof Error ? e.message : "Unknown error");
      })
      .finally(() => {
        if (!ac.signal.aborted) setSelectedLoading(false);
      });
    return () => ac.abort();
  }, [selectedId, threadId, stepIdToRawSpanId]);

  return (
    <SelectionContext.Provider value={{ selectedId, select: setSelectedId }}>
      {aggregate ? (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-4 md:grid-cols-4">
          <StatCard
            icon={<BrainIcon className="size-3.5" style={{ color: TYPE_COLORS.llm }} />}
            label="LLM calls"
            value={String(aggregate.llmSpanCount)}
          />
          <StatCard
            icon={<WrenchIcon className="size-3.5" style={{ color: TYPE_COLORS.tool }} />}
            label="Tool calls"
            value={String(aggregate.toolSpanCount)}
          />
          <StatCard
            icon={<UserIcon className="size-3.5" style={{ color: TYPE_COLORS.human }} />}
            label="HITL"
            value={String(aggregate.humanCount)}
          />
          <StatCard
            icon={<AlertCircleIcon className="text-destructive size-3.5" />}
            label="Failed"
            value={String(aggregate.failedCount)}
          />
          <StatCard
            icon={<ArrowDownIcon className="text-muted-foreground size-3.5" />}
            label="Input"
            value={`${fmt(aggregate.totalInput)} tok`}
          />
          <StatCard
            icon={<ArrowUpIcon className="text-muted-foreground size-3.5" />}
            label="Output"
            value={`${fmt(aggregate.totalOutput)} tok`}
          />
          <StatCard
            icon={<DatabaseIcon className="text-muted-foreground size-3.5" />}
            label="Total"
            value={`${fmt(aggregate.totalTokens)} tok`}
          />
          <StatCard
            icon={<ClockIcon className="text-muted-foreground size-3.5" />}
            label="Duration"
            value={formatDuration(aggregate.totalDurationMs)}
          />
        </div>
      ) : null}

      <div className="-mx-6 min-h-0 flex-1 overflow-auto px-6 lg:overflow-hidden">
        {spans.length === 0 ? (
          <div className="border-border bg-muted/10 flex flex-col items-center justify-center rounded-lg border py-16 px-4 text-center">
            <div className="bg-muted/30 border-border mb-4 flex size-12 items-center justify-center rounded-full border shadow-sm">
              <Activity className="text-muted-foreground/60 size-5 animate-pulse" />
            </div>
            <h3 className="text-foreground text-sm font-semibold">No traces captured</h3>
            <p className="text-muted-foreground mt-1.5 max-w-[300px] text-xs leading-relaxed">
              Spans will appear here once the agent starts running model or tool invocations in this
              thread.
            </p>
          </div>
        ) : (
          <AuiProvider value={aui}>
            <div className="flex min-h-0 flex-col lg:h-full lg:flex-row">
              <div className="min-h-0 flex-1 lg:overflow-auto">
                <WaterfallTimeline
                  retentionDays={retentionDays ?? null}
                  stillRunning={stillRunning ?? false}
                />
              </div>
              <div
                className={cn(
                  "min-h-0 lg:max-w-none overflow-y-auto overflow-x-hidden transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
                  selectedSpan || selectedLoading || selectedError
                    ? "w-full lg:w-[min(40%,28rem)] opacity-100 translate-x-0 mt-2 lg:mt-0 lg:ml-2"
                    : "w-0 h-0 lg:h-auto opacity-0 translate-x-4 pointer-events-none mt-0 lg:ml-0",
                )}
              >
                <div className="relative">
                  {selectedError ? (
                    <DetailError message={selectedError} />
                  ) : selectedSpan ? (
                    <>
                      <SpanDetails span={selectedSpan} />
                      {selectedLoading ? <DetailRefreshOverlay /> : null}
                    </>
                  ) : selectedLoading ? (
                    <DetailLoadingSkeleton />
                  ) : null}
                </div>
              </div>
            </div>
          </AuiProvider>
        )}
      </div>
    </SelectionContext.Provider>
  );
};

const SKEL_ROWS = [
  { label: "75%", bar: "60%" },
  { label: "55%", bar: "45%" },
  { label: "80%", bar: "70%" },
  { label: "50%", bar: "55%" },
  { label: "70%", bar: "80%" },
  { label: "60%", bar: "35%" },
] as const;

export const ObservabilityPanelSkeleton: FC = () => (
  <div className="flex min-h-0 flex-1 flex-col gap-4 animate-pulse">
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="border-border bg-muted/30 flex min-w-[5.5rem] flex-col gap-1.5 rounded-md border px-2.5 py-1.5"
        >
          <div className="flex items-center gap-1">
            <div className="bg-muted/50 size-3.5 rounded-sm" />
            <div className="bg-muted/50 h-2.5 w-16 rounded-sm" />
          </div>
          <div className="bg-muted/50 h-4 w-10 rounded-sm" />
        </div>
      ))}
    </div>

    <div className="-mx-6 flex min-h-0 flex-1 flex-col overflow-hidden px-6">
      <div className="border-border mb-0.5 flex items-center gap-2 border-b pb-1.5">
        <div className="bg-muted/50 h-2 shrink-0 rounded-sm" style={{ width: LABEL_WIDTH }} />
        <div className="bg-muted/50 h-2 flex-1 rounded-sm" />
      </div>

      <div className="flex flex-col">
        {SKEL_ROWS.map(({ label, bar }, i) => (
          <div key={i} className="flex items-center" style={{ height: BAR_HEIGHT }}>
            <div
              className="border-border flex shrink-0 items-center gap-1.5 border-r px-2"
              style={{ width: LABEL_WIDTH, height: BAR_HEIGHT }}
            >
              <div className="bg-muted/40 size-3.5 shrink-0 rounded-sm" />
              <div className="bg-muted/50 h-4 w-10 rounded-sm" />
              <div className="bg-muted/50 h-3 rounded-sm" style={{ width: label }} />
            </div>
            <div className="flex flex-1 items-center px-2">
              <div className="bg-muted/50 h-5 rounded-sm" style={{ width: bar }} />
            </div>
          </div>
        ))}
      </div>

      <div className="border-border mt-3 flex items-center gap-3 border-t pt-2">
        {LEGEND_TYPE_ORDER.map((t) => (
          <div key={t} className="flex items-center gap-1">
            <div
              className="size-2.5 rounded-sm opacity-40"
              style={{ backgroundColor: TYPE_COLORS[t] }}
            />
            <div className="bg-muted/50 h-2 w-8 rounded-sm" />
          </div>
        ))}
      </div>
    </div>
  </div>
);
