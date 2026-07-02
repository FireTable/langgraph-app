"use client";

// ponytail: pure renderer. The button.tsx controller owns fetch + the
// Sheet chrome; the panel just needs data and renders the search box
// + waterfall + details. Hosting its own <Sheet> here would wrap the
// panel in a second dialog — exactly what we don't want. No Sheet /
// Dialog imports in this file.
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from "react";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BoxIcon,
  BrainIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  DatabaseIcon,
  LinkIcon,
  UserIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";

import type { CapturedSpan } from "@/backend/observability/callback-collector";

export type ObservabilityPanelProps = {
  spans: SpanData[];
  // ponytail: raw captured payload indexed by span_id, so clicking a row
  // can show input / output / usage / meta. SpanData only
  // carries the renderer fields — details need the original handler payload.
  rawSpans?: CapturedSpan[];
  // ponytail: retention policy reported by /api/threads/<id>/observability.
  // Rendered as a small footer under the legend so the sheet header
  // stays compact. Null = unknown (don't render).
  retentionDays?: number | null;
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

// ponytail: legend display order. chain (wrapper) first, then the
// sub-flow nodes, then leaf types, with human last because it only
// appears in interrupt flows.
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

function formatTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

// ponytail: same shape as the waterfall's axis ticks — always seconds.
// Consistent readout across the panel; sub-second values use 2 decimals
// (e.g. 49.7s, 1.17s, 0.05s).
function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

// ponytail: tool output was unwrapped from {lc:1, type:"constructor", ...} envelope
// at the backend (callback-collector.ts → deepUnwrapLC). Frontend reads the
// already-structured {role:"tool", content:<parsed>} shape directly.

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
  select: (id: string) => void;
  rawById: Map<string, CapturedSpan>;
};

type TooltipState = { x: number; y: number; raw: CapturedSpan } | null;
type TooltipContextValue = {
  tooltip: TooltipState;
  setTooltip: (updater: TooltipState | ((prev: TooltipState) => TooltipState)) => void;
};

const TooltipContext = createContext<TooltipContextValue | null>(null);

function useTooltip(): TooltipContextValue {
  const ctx = useContext(TooltipContext);
  if (!ctx) throw new Error("useTooltip must be used inside TooltipContext");
  return ctx;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("useSelection must be used inside SelectionContext");
  return ctx;
}

// ponytail: per-type icon. lucide-react picks — keep it to one icon
// per kind so the row stays scannable.
const TYPE_ICONS: Record<string, FC<{ className?: string }>> = {
  llm: BrainIcon,
  tool: WrenchIcon,
  node: BoxIcon,
  chain: LinkIcon,
  human: UserIcon,
};

// ponytail: compact stat card — used in the panel header to surface
// aggregate numbers (duration, token counts, LLM call count) with a
// consistent visual rhythm. Icon over label over big number.
const StatCard: FC<{ icon: React.ReactNode; label: string; value: string }> = ({
  icon,
  label,
  value,
}) => (
  <div className="border-border bg-muted/30 flex min-w-[5.5rem] flex-col gap-0.5 rounded-md border px-2.5 py-1.5">
    <div className="text-muted-foreground flex items-center gap-1 text-[10px] tracking-wide uppercase">
      {icon}
      <span>{label}</span>
    </div>
    <div className="text-foreground tabular-nums text-sm leading-tight font-semibold">{value}</div>
  </div>
);

// ponytail: shared chip — used in both the row (TypeBadge slot) and
// the legend. Pure presentational: caller passes the type string and
// the chip paints icon + text + border in the per-type color.
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

// ponytail: status badge — pill with a dot + uppercase label. The
// header's right-hand status indicator used to be plain text
// ("COMPLETED"), which read as faded metadata; the badge makes the
// success / failure state land first. Colors mirror the legend's
// per-status intent: green for completed, blue for running, red for
// failed, purple for waiting (interrupt gap).
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
  const name = useAuiState((s) => (s as unknown as { span: SpanItemState }).span.name);
  const type = useAuiState((s) => (s as unknown as { span: SpanItemState }).span.type);
  const status = useAuiState((s) => (s as unknown as { span: SpanItemState }).span.status) as
    | SpanItemState["status"]
    | undefined;
  const { selectedId, select, rawById } = useSelection();
  const { setTooltip } = useTooltip();
  const isSelected = selectedId === id;
  // ponytail: surface the LLM model name ahead of the LangChain class
  // name (e.g. "ChatOpenAI") so the row reads model-first — useful
  // when a thread hops between providers. meta.ls_model_name is the
  // LangSmith-shaped key, set by ChatOpenAI / Anthropic / etc. on
  // every LLM callback. Falls back silently for tool / node / human.
  const raw = rawById.get(id);
  const meta = (raw?.meta ?? null) as Record<string, unknown> | null;
  const modelName = typeof meta?.ls_model_name === "string" ? meta.ls_model_name : null;
  // ponytail: hover is row-level (label + bar both trigger). The bar
  // is short on inner steps so row-level hover makes the tooltip
  // actually reachable on every kind.
  const buildTooltip = (e: React.MouseEvent<HTMLElement>) => {
    const r = rawById.get(id);
    if (!r || !status) return;
    const safeStatus: CapturedSpan["status"] =
      status === "skipped" ? "completed" : (status as CapturedSpan["status"]);
    const kindMap: Record<string, CapturedSpan["kind"]> = {
      llm: "llm",
      tool: "tool",
      node: "node",
      chain: "chain",
      human: "human",
    };
    const kind = kindMap[type] ?? "unknown";
    setTooltip({ x: e.clientX, y: e.clientY, raw: { ...r, name, kind, status: safeStatus } });
  };
  const onEnter = (e: React.MouseEvent<HTMLElement>) => buildTooltip(e);
  const onMove = (e: React.MouseEvent<HTMLElement>) =>
    setTooltip((prev) => (prev ? { ...prev, x: e.clientX, y: e.clientY } : prev));
  const onLeave = () => setTooltip(null);
  return (
    <SpanPrimitive.Root
      onClick={() => select(id)}
      onMouseEnter={onEnter}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={`group flex cursor-pointer items-center ${isSelected ? "bg-accent/60" : ""}`}
      style={{ width: contentWidth, height: BAR_HEIGHT }}
    >
      <SpanPrimitive.Indent
        baseIndent={8}
        indentPerLevel={12}
        className="border-border group-hover:bg-accent/50 sticky left-0 z-10 flex shrink-0 items-center gap-1 overflow-hidden border-r px-2"
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
        <TypedBadge />
        {modelName ? (
          <span className="text-foreground shrink truncate text-sm ">{modelName}</span>
        ) : (
          <SpanPrimitive.Name className="truncate text-sm" />
        )}
      </SpanPrimitive.Indent>

      <div className="group-hover:bg-accent/30" style={{ width: barWidth, height: BAR_HEIGHT }}>
        <svg aria-hidden width={barWidth} height={BAR_HEIGHT}>
          <WaterfallBar />
        </svg>
      </div>
    </SpanPrimitive.Root>
  );
};

// ponytail: lightweight hover popup. Anchored to mouse coords on
// clientX/Y. Renders a compact card with name, kind, time range, and
// duration — the same fields the details panel shows, minus the
// payload. Kept off the bar's own positioning so the popup never
// gets clipped by overflow:hidden on the timeline container. Reads
// the same schema as SpanDetails and filters rows with `tooltip:true`.
// ponytail: hover popup. Walks the kind's section list, keeps only
// rows where the field opted in via `tooltip:true` (start / end /
// duration / ttft / model / step / name / tokens). The header keeps
// the chip + name — both come from the span itself, not the schema.
// ponytail: more breathing room than the previous px-2.5 py-1.5 +
// gap-x-1.5. Added a thin separator under the chip+name row so the
// metadata rows read as a distinct group, and gap-y-1 keeps the
// label/value pairs from crowding into each other at 10px font.
const TooltipPopup: FC = () => {
  const { tooltip } = useTooltip();
  const ref = useRef<HTMLDivElement | null>(null);
  // ponytail: tooltip is fixed-positioned at the cursor. The naive
  // `left: x + 12` overflows the right edge when the user hovers
  // rows near the browser's right gutter (e.g. an LLM row at the
  // tail of a long waterfall). Measure the actual rendered width
  // after layout and flip to the cursor's left when it doesn't fit.
  const [flip, setFlip] = useState(false);
  useLayoutEffect(() => {
    if (!tooltip || !ref.current) return;
    const w = ref.current.offsetWidth;
    const EDGE = 12;
    setFlip(w > 0 && x + EDGE + w > window.innerWidth - 4);
    // x is a primitive — including it in deps would re-measure every
    // mousemove, which we want (cursor can leave the row but the
    // tooltip stays; the next hover sets a new x and re-flip).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tooltip]);
  if (!tooltip) return null;
  const { raw, x, y } = tooltip;
  const sections = resolveSections(raw, DETAIL_SECTIONS_BY_KIND[raw.kind]);
  const tooltipRows = sections.flatMap((s) => s.rows).filter((r) => r.tooltip);
  const EDGE = 12;
  const style = flip
    ? { left: Math.max(4, x - EDGE - (ref.current?.offsetWidth ?? 0)), top: y + EDGE }
    : { left: x + EDGE, top: y + EDGE };
  return (
    <div
      ref={ref}
      role="tooltip"
      className="border-border bg-popover text-popover-foreground pointer-events-none fixed z-50 max-w-xs rounded-md border px-3 py-2.5 text-xs shadow-md"
      style={style}
    >
      <div className="flex items-center gap-1.5 pb-1.5">
        <TypeChip type={raw.kind} />
        <span className="truncate font-medium">{raw.name}</span>
      </div>
      {tooltipRows.length > 0 && (
        <div className="border-border grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 border-t pt-1.5 font-mono text-[10px]">
          {tooltipRows.map((r) => (
            <RowPreview key={r.id} row={r} />
          ))}
        </div>
      )}
    </div>
  );
};

// ponytail: tooltip row preview — for a `text` or `badge` value,
// render the label: value pair. Anything else (json / tokens /
// structured) is ignored in the tooltip because it doesn't fit on
// one line. Badge re-uses the same field renderer with `compact`
// mode (smaller font, no border) so the tooltip chip stays light.
// Values right-align so the column reads as a clean 2-column KV —
// `auto | 1fr` puts labels flush-left, values flush-right.
const RowPreview: FC<{ row: ResolvedRow }> = ({ row }) => {
  if (row.value.kind === "text") {
    return (
      <>
        <span className="text-muted-foreground">{row.label}</span>
        <span className="truncate text-right">{row.value.text}</span>
      </>
    );
  }
  if (row.value.kind === "badge") {
    return (
      <>
        <span className="text-muted-foreground">{row.label}</span>
        <span className="flex justify-end">
          <FieldRenderer value={row.value} compact />
        </span>
      </>
    );
  }
  return null;
};

const WaterfallTimeline: FC<{ retentionDays: number | null }> = ({ retentionDays }) => {
  const outerRef = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(400);
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
      <div className="border-border text-muted-foreground rounded-lg border py-12 text-center text-sm">
        No spans recorded.
      </div>
    );
  }

  return (
    <TooltipContext.Provider value={{ tooltip, setTooltip }}>
      <div ref={outerRef} className="border-border relative overflow-hidden rounded-lg border">
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
          <div className="py-1.5" style={{ width: contentWidth }}>
            <SpanPrimitive.Children>{() => <WaterfallRow />}</SpanPrimitive.Children>
          </div>
        </WaterfallLayoutContext.Provider>

        <div className="border-border text-muted-foreground border-t text-xs">
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

// ponytail: aggregate every LLM span's tokens in a thread for the root card.
// LangSmith shows "13.77s · 4.9K" — we mirror that shape.
type RootAggregate = {
  totalDurationMs: number;
  totalInput: number;
  totalOutput: number;
  // ponytail: input + output billed tokens, excluding cache_read (which
  // the provider already credits; counting it again inflates the total).
  totalTokens: number;
  totalCacheRead: number;
  totalReasoning: number;
  // ponytail: TTFT (time-to-first-token) is stamped on LLM spans by
  // CapturingHandler.handleLLMNewToken as meta.time_to_first_token_ms
  // (ms from span start). Mean / max surface streaming latency — a slow
  // TTFT with a fast total usually means the provider is the bottleneck,
  // not the model.
  ttftAvgMs: number | null;
  ttftMaxMs: number | null;
  llmSpanCount: number;
  toolSpanCount: number;
  failedCount: number;
  waitingCount: number;
};

function aggregateRoot(spans: CapturedSpan[]): RootAggregate | null {
  if (spans.length === 0) return null;
  const llms = spans.filter((s) => s.kind === "llm" && s.usage);
  let input = 0,
    output = 0,
    cache_read = 0,
    reasoning = 0;
  for (const s of llms) {
    const t = readTokens(s.usage);
    if (!t) continue;
    input += t.input;
    output += t.output;
    cache_read += t.cache_read;
    reasoning += t.reasoning;
  }
  let minStart = Infinity,
    maxEnd = 0;
  for (const s of spans) {
    if (s.started_at < minStart) minStart = s.started_at;
    if (s.ended_at && s.ended_at > maxEnd) maxEnd = s.ended_at;
  }
  // ponytail: aggregate TTFT — read meta.time_to_first_token_ms which
  // the callback stamps on the first handleLLMNewToken. Spans without
  // streaming (non-LLM / non-streaming LLM) are skipped.
  const ttftValues: number[] = [];
  for (const s of llms) {
    const v = (s.meta as Record<string, unknown> | null | undefined)?.time_to_first_token_ms;
    if (typeof v === "number" && v > 0) ttftValues.push(v);
  }
  const ttftAvgMs =
    ttftValues.length > 0 ? ttftValues.reduce((a, b) => a + b, 0) / ttftValues.length : null;
  const ttftMaxMs = ttftValues.length > 0 ? ttftValues.reduce((a, b) => Math.max(a, b), 0) : null;

  return {
    totalDurationMs: maxEnd > minStart ? maxEnd - minStart : 0,
    totalInput: input,
    totalOutput: output,
    totalTokens: input + output,
    totalCacheRead: cache_read,
    totalReasoning: reasoning,
    ttftAvgMs,
    ttftMaxMs,
    llmSpanCount: llms.length,
    toolSpanCount: spans.filter((s) => s.kind === "tool").length,
    failedCount: spans.filter((s) => s.status === "failed" && s.kind !== "chain").length,
    waitingCount: spans.filter((s) => s.status === "waiting" && s.kind !== "tool").length,
  };
}

// ponytail: extract structured output from routerAgent / withStructuredOutput
// LLM spans. LangChain stores the parsed object on the AIMessage's
// additional_kwargs.structured_response or returns it via tool_calls[].args.
// Detect either and surface as a field tree rather than a JSON blob.
type StructuredOutput = { path: string; value: unknown }[];

function readStructuredOutput(span: CapturedSpan): StructuredOutput | null {
  if (span.kind !== "llm") return null;
  const out = span.output as unknown;
  if (!out || typeof out !== "object") return null;
  const generations = (out as Record<string, unknown>).generations;
  if (!Array.isArray(generations) || !generations[0]?.[0]) return null;
  const gen = generations[0][0] as Record<string, unknown>;
  const msg = gen.message as Record<string, unknown> | undefined;
  if (!msg) return null;

  // 1. AIMessage.content as an object (our minimax provider parses
  //    withStructuredOutput's JSON schema into message.content directly).
  const content = msg.content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return flattenFields(content);
  }

  // 2. additional_kwargs.structured_response / structured_output / parsed.
  const ak = msg.additional_kwargs as Record<string, unknown> | undefined;
  if (ak) {
    for (const key of ["structured_response", "structured_output", "parsed"] as const) {
      if (ak[key] && typeof ak[key] === "object") return flattenFields(ak[key]);
    }
  }

  // 3. tool_calls[0].args (when withStructuredOutput uses ToolCalling mode).
  const tcs = msg.tool_calls;
  if (Array.isArray(tcs) && tcs[0]) {
    const args = (tcs[0] as Record<string, unknown>).args;
    if (args && typeof args === "object") return flattenFields(args);
  }
  return null;
}

function flattenFields(v: unknown, prefix = ""): StructuredOutput {
  if (v === null || v === undefined) return [{ path: prefix || "(value)", value: v }];
  if (typeof v !== "object") return [{ path: prefix || "(value)", value: v }];
  if (Array.isArray(v)) {
    if (v.length === 0) return [{ path: prefix || "(array)", value: [] }];
    return [{ path: prefix || "(array)", value: `[${v.length} items]` }];
  }
  const out: StructuredOutput = [];
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

function aggregateUsage(spans: CapturedSpan[]): Record<string, unknown> | null {
  const withUsage = spans.filter((s) => s.usage);
  if (withUsage.length === 0) return null;
  let input = 0,
    output = 0,
    total = 0,
    cache_read = 0,
    reasoning = 0;
  let hasCache = false,
    hasReasoning = false;
  for (const s of withUsage) {
    const t = readTokens(s.usage);
    if (!t) continue;
    input += t.input;
    output += t.output;
    total += t.total;
    if (t.cache_read > 0) {
      cache_read += t.cache_read;
      hasCache = true;
    }
    if (t.reasoning > 0) {
      reasoning += t.reasoning;
      hasReasoning = true;
    }
  }
  const inputDetails: Record<string, unknown> = {};
  const outputDetails: Record<string, unknown> = {};
  if (hasCache) inputDetails.cache_read = cache_read;
  if (hasReasoning) outputDetails.reasoning = reasoning;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    ...(Object.keys(inputDetails).length ? { input_token_details: inputDetails } : {}),
    ...(Object.keys(outputDetails).length ? { output_token_details: outputDetails } : {}),
  };
}

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

// ponytail: detail schema. SpanDetails + TooltipPopup both render from
// the same per-kind section list. To add a new field: declare one
// FieldDef, drop it in the right section, and the details card + the
// hover tooltip (when `tooltip: true`) both pick it up. No more if-chain
// branches to keep in sync.
type FieldValue =
  | { kind: "text"; text: string; mono?: boolean }
  | { kind: "code"; data: unknown; maxHeight?: number }
  | { kind: "tokens"; tokens: TokenBreakdown }
  | { kind: "prompts"; prompts: string[] }
  | { kind: "structured"; fields: StructuredOutput }
  // ponytail: badge — small chip with a colored border + bg, used
  // when a single token-like value should pop out of the row
  // (model name, status, step id). `color` matches the TYPE_COLORS
  // keys; falls back to FALLBACK_COLOR when missing.
  | { kind: "badge"; text: string; color?: string }
  | { kind: "raw"; node: React.ReactNode };

type ResolvedRow = {
  id: string;
  label: string;
  value: FieldValue;
  tooltip: boolean;
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
  // ponytail: opt-in. When true, the field is also surfaced in the
  // hover tooltip. Default false — most fields are too long for a
  // 1-line popup (json blobs, structured fields). Time + status are
  // the obvious yes; tokens are too dense for a tooltip.
  tooltip?: boolean;
  // ponytail: opt-out. Default true — the field renders in the details
  // card. Set false to keep a field in the tooltip only. Use this when
  // the same data is already shown in a more detailed section below
  // (e.g. "Tokens" row duplicates the Total cost breakdown).
  details?: boolean;
  // ponytail: opt-in. When true, the field renders WITHOUT the
  // standard `label: value` row — useful for a single-field section
  // (e.g. Total cost breakdown) where the renderer carries its own
  // internal labels and the wrapper label would be redundant.
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
        tooltip: !!f.tooltip,
        details: f.details !== false,
        bare: !!f.bare,
      });
    }
    if (rows.length > 0) out.push({ id: s.id, title: s.title, rows });
  }
  return out;
}

// ponytail: YYYY-MM-DD HH:MM:SS.mmm — date prefix is non-negotiable
// for debugging; a 30-minute trace that crosses midnight renders
// identically to one that doesn't without it. Format still fits in
// the tooltip's max-w-xs (tooltip content is short by design).
function compactTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// ponytail: stack label above value. Side-by-side (88px label, 1fr
// value) wasted half the card on the value column when the value is
// short (a timestamp, a duration). Stacking lets the value use the
// full width and reads top-to-bottom like a normal form. Row label
// is sentence-style muted, not uppercase — the section title already
// shouts, repeating that at the row level makes "INPUT / Input"
// feel redundant.
const DetailRow: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="text-sm">
    <div className="text-muted-foreground text-xs">{label}</div>
    <div className="mt-0.5 min-w-0">{children}</div>
  </div>
);

const DetailSection: FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="border-border space-y-3 border-t pt-3 first:border-t-0 first:pt-0">
    {/* ponytail: stacked rows mean each row is label+value, so a
        little more between-row gap than the side-by-side layout
        needed. 12px chunk boundary + 12px row rhythm → consistent
        ~24px / 12px feel. */}
    <div className="text-muted-foreground text-[10px] tracking-wider uppercase">{title}</div>
    {children}
  </div>
);

// ponytail: LangSmith-style breakdown — three plain rows
// (Input / Output / Total), each laid out as
//   [label]   [X% · N · {meta}]
// where the meta annotation is `cache N` for input and
// `reasoning N` for output. Single-line per row, no progress bar
// (the percentage is enough), no separate Tokens label (the
// section title already says "Total cost breakdown"). Number
// column right-aligned; label muted, number bold for scannability.
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

// ponytail: compact copy-as-JSON button. Same navigator.clipboard path
// as the chat CodeBlock header; "Copied" feedback flips the icon for
// ~1.5s. No tooltip wrapper — aria-label + the post-click state carry
// the affordance. Floating it top-right of a block lets the pre below
// keep its current padding / scroll behavior.
const CopyJsonButton: FC<{ getText: () => string; label?: string; className?: string }> = ({
  getText,
  label = "Copy",
  className,
}) => {
  const [copied, setCopied] = useState(false);
  const onClick = () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(getText()).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? "Copied" : label}
      className={cn(
        "text-muted-foreground hover:text-foreground hover:bg-muted/60 inline-flex size-5 items-center justify-center rounded transition-colors",
        className,
      )}
    >
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </button>
  );
};

// ponytail: shared renderer for FieldValue. Both SpanDetails rows and
// TooltipPopup rows resolve to the same FieldValue, so the visual
// decision lives in one place. The "raw" variant is the escape hatch
// for one-off cases (e.g. the multi-line prompt group renderer with
// per-message collapse toggles) — we don't try to flatten those into
// the schema.
const FieldRenderer: FC<{ value: FieldValue; compact?: boolean }> = ({ value, compact }) => {
  switch (value.kind) {
    case "text": {
      const cls = compact
        ? "text-muted-foreground font-mono text-[10px]"
        : value.mono
          ? "font-mono text-xs"
          : "text-muted-foreground text-xs";
      return <span className={cls}>{value.text}</span>;
    }
    case "badge": {
      const c = value.color ?? FALLBACK_COLOR;
      // ponytail: same chip pattern as TypeChip — colored text +
      // border in the same hue. `compact` mode drops the border
      // for the tooltip variant (the surrounding tooltip border
      // is enough visual anchor; a chip-in-a-chip looks heavy).
      return (
        <span
          className={
            compact
              ? "font-mono text-[10px] font-medium"
              : "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[11px] font-medium"
          }
          style={{ color: c, ...(compact ? {} : { borderColor: c }) }}
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
            getText={() => text}
            label="Copy JSON"
            className="absolute top-1.5 right-1.5 z-10"
          />
          <JsonBlock data={value.data} maxHeight={value.maxHeight ?? 240} />
        </div>
      );
    }
    case "tokens":
      return <TokenBreakdownView tokens={value.tokens} />;
    case "prompts": {
      // ponytail: each prompt group is split on role-prefixed lines
      // ("system: ...", "human: ...") so the operator can collapse
      // each role independently. Same shape the previous inline block
      // produced — pulled verbatim into the schema path.
      const knownRoles = new Set(["system", "human", "ai", "assistant", "tool", "function"]);
      return (
        <div className="space-y-2">
          {value.prompts.map((promptGroup, i) => {
            const tokens: { role: string; body: string }[] = [];
            let current: { role: string; body: string[] } | null = null;
            for (const line of promptGroup.split("\n")) {
              const colonAt = line.indexOf(": ");
              const maybeRole = colonAt > 0 ? line.slice(0, colonAt) : "";
              if (knownRoles.has(maybeRole)) {
                if (current) tokens.push({ role: current.role, body: current.body.join("\n") });
                current = { role: maybeRole, body: [line.slice(colonAt + 2)] };
              } else if (current) {
                current.body.push(line);
              }
            }
            if (current) tokens.push({ role: current.role, body: current.body.join("\n") });
            return (
              <div key={i} className="border-border space-y-1 rounded-md border p-2">
                {tokens.map((t, j) => (
                  <details key={j} open className="text-xs">
                    <summary className="bg-muted/40 cursor-pointer rounded px-1.5 py-0.5 font-medium">
                      {t.role}
                    </summary>
                    <pre className="text-foreground mt-1 overflow-auto px-1.5 py-1 text-xs whitespace-pre-wrap">
                      {t.body}
                    </pre>
                  </details>
                ))}
              </div>
            );
          })}
        </div>
      );
    }
    case "structured": {
      // ponytail: collapse the flattened {path, value}[] back into a
      // plain JSON object so the user gets the same shape they'd see
      // in the raw output. Duplicates (last wins) are good enough —
      // the renderer already de-dups by `show` so this is rare.
      const json = value.fields.reduce<Record<string, unknown>>((acc, f) => {
        acc[f.path] = f.value;
        return acc;
      }, {});
      return (
        // ponytail: copy button sits to the right of the K column, not
        // floating over the rows. Keeps the table chrome clean and
        // aligns with the rest of the panel's "label + value" rhythm.
        <div className="flex items-start gap-1.5">
          <div className="border-border flex-1 rounded-md border">
            {value.fields.map((f, i) => (
              <div
                key={i}
                className="border-border flex items-baseline gap-3 border-b px-3 py-2 text-xs last:border-b-0"
              >
                <span className="text-muted-foreground shrink-0 font-mono">{f.path}</span>
                <span
                  className="text-foreground ml-auto truncate text-right font-mono"
                  title={String(f.value)}
                >
                  {typeof f.value === "string" ? f.value : JSON.stringify(f.value)}
                </span>
              </div>
            ))}
          </div>
          <CopyJsonButton
            getText={() => JSON.stringify(json, null, 2)}
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

// ponytail: TTFT (time-to-first-token) per span. Read from
// meta.time_to_first_token_ms, set by CapturingHandler.handleLLMNewToken
// on the first streaming token. Null / non-positive → no TTFT (the
// span was either non-LLM or non-streaming).
function readTtftMs(span: CapturedSpan): number | null {
  const v = (span.meta as Record<string, unknown> | null | undefined)?.time_to_first_token_ms;
  return typeof v === "number" && v > 0 ? v : null;
}

// ponytail: per-kind section lists. Both the details card and the
// hover tooltip walk the same list; tooltip:true opts a field into the
// popup. `show` / value() returning null drops the row at render time,
// so empty sections never render.
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
          tooltip: true,
        },
        {
          id: "end",
          label: "End",
          show: (s) => s.ended_at != null,
          value: (s) => ({ kind: "text", text: compactTime(s.ended_at as number) }),
          tooltip: true,
        },
        {
          id: "duration",
          label: "Duration",
          show: (s) => s.ended_at != null,
          value: (s) => ({
            kind: "text",
            text: formatDuration((s.ended_at as number) - s.started_at),
          }),
          tooltip: true,
        },
        {
          id: "ttft",
          label: "Time to first token",
          show: (s) => readTtftMs(s) != null,
          value: (s) => ({ kind: "text", text: formatDuration(readTtftMs(s) as number) }),
          tooltip: true,
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
          // ponytail: badge kind so the model name reads as a
          // pill in the LLM color (purple). When a provider is
          // available, keep it on the same row as muted text —
          // it's a sub-annotation, not a separate data point.
          value: (s) => ({
            kind: "badge",
            text: s.meta?.ls_model_name as string,
            color: TYPE_COLORS.llm,
          }),
          tooltip: true,
        },
        {
          // ponytail: single-line token summary for the hover
          // tooltip — "In 720 / Out 90" reads at a glance. The full
          // TokenBreakdownView (with percentages and cache / reasoning
          // breakdown) lives in the Total cost breakdown section below;
          // we drop the row from the details card to avoid duplication,
          // and keep it in the tooltip only.
          id: "tokens",
          label: "Tokens",
          show: (s) => readTokens(s.usage) != null,
          value: (s) => {
            const t = readTokens(s.usage) as TokenBreakdown;
            const parts = [`In ${fmt(t.input)}`, `Out ${fmt(t.output)}`];
            if (t.cache_read > 0) parts.push(`Cache ${fmt(t.cache_read)}`);
            return { kind: "text", text: parts.join(" / ") };
          },
          tooltip: true,
          details: false,
        },
      ],
    },
    {
      id: "tokens",
      title: "Total cost breakdown",
      fields: [
        {
          // ponytail: bare field — TokenBreakdownView carries its
          // own "Input / Output / Total" labels, so the section's
          // wrapping row label would be redundant. The `bare` flag
          // tells ResolvedSections to skip the DetailRow wrapper
          // and render the value directly under the section title.
          id: "tokens",
          label: "",
          bare: true,
          show: (s) => readTokens(s.usage) != null,
          value: (s) => ({ kind: "tokens", tokens: readTokens(s.usage) as TokenBreakdown }),
        },
      ],
    },
    {
      id: "prompts",
      title: "Prompts",
      fields: [
        {
          id: "prompts",
          label: "Prompts",
          show: (s) => Array.isArray(s.input) && (s.input as string[]).length > 0,
          value: (s) => ({ kind: "prompts", prompts: s.input as string[] }),
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
            fields: readStructuredOutput(s) as StructuredOutput,
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
          tooltip: true,
        },
        {
          id: "end",
          label: "End",
          show: (s) => s.ended_at != null,
          value: (s) => ({ kind: "text", text: compactTime(s.ended_at as number) }),
          tooltip: true,
        },
        {
          id: "duration",
          label: "Duration",
          show: (s) => s.ended_at != null,
          value: (s) => ({
            kind: "text",
            text: formatDuration((s.ended_at as number) - s.started_at),
          }),
          tooltip: true,
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
      // ponytail: tool payload — Input and Output in one section
      // (Payload) so the row labels carry the direction. Splitting
      // them into separate "Input" / "Output" sections with row
      // labels of the same name printed "INPUT / Input" twice in
      // a row, which is visual noise.
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
          tooltip: true,
        },
        {
          id: "end",
          label: "End",
          show: (s) => s.ended_at != null,
          value: (s) => ({ kind: "text", text: compactTime(s.ended_at as number) }),
          tooltip: true,
        },
        {
          id: "duration",
          label: "Duration",
          show: (s) => s.ended_at != null,
          value: (s) => ({
            kind: "text",
            text: formatDuration((s.ended_at as number) - s.started_at),
          }),
          tooltip: true,
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
          tooltip: true,
        },
        {
          id: "name",
          label: "Name",
          // ponytail: hide the Name row when it duplicates the
          // langgraph_node (e.g. step wrappers named after their
          // node like `weatherModel`). The row only carries signal
          // when the LC-level class name is different from the
          // node name (e.g. `RunnableSequence` inside `routerAgent`).
          show: (s) =>
            typeof s.meta?.langgraph_node === "string" && s.name !== s.meta.langgraph_node,
          value: (s) => ({ kind: "text", text: s.name, mono: true }),
          tooltip: true,
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
          tooltip: true,
        },
        {
          id: "end",
          label: "End",
          show: (s) => s.ended_at != null,
          value: (s) => ({ kind: "text", text: compactTime(s.ended_at as number) }),
          tooltip: true,
        },
        {
          id: "duration",
          label: "Duration",
          show: (s) => s.ended_at != null,
          value: (s) => ({
            kind: "text",
            text: formatDuration((s.ended_at as number) - s.started_at),
          }),
          tooltip: true,
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
          tooltip: true,
        },
        {
          id: "name",
          label: "Name",
          // ponytail: hide the Name row when it duplicates the
          // langgraph_node (e.g. step wrappers named after their
          // node like `weatherModel`). The row only carries signal
          // when the LC-level class name is different from the
          // node name (e.g. `RunnableSequence` inside `routerAgent`).
          show: (s) =>
            typeof s.meta?.langgraph_node === "string" && s.name !== s.meta.langgraph_node,
          value: (s) => ({ kind: "text", text: s.name, mono: true }),
          tooltip: true,
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
          tooltip: true,
        },
        {
          id: "end",
          label: "End",
          show: (s) => s.ended_at != null,
          value: (s) => ({ kind: "text", text: compactTime(s.ended_at as number) }),
          tooltip: true,
        },
        {
          id: "duration",
          label: "Duration",
          show: (s) => s.ended_at != null,
          value: (s) => ({
            kind: "text",
            text: formatDuration((s.ended_at as number) - s.started_at),
          }),
          tooltip: true,
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
          // ponytail: same hide-when-duplicate guard as the node /
          // chain Name rows. Interrupt's name is `interrupt` and
          // langgraph_node is the awaited step (e.g. `weatherTools`)
          // — different — so the row fires for interrupts and
          // disappears if a future human span happens to land in
          // a same-named step.
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
          tooltip: true,
        },
        {
          id: "end",
          label: "End",
          show: (s) => s.ended_at != null,
          value: (s) => ({ kind: "text", text: compactTime(s.ended_at as number) }),
          tooltip: true,
        },
        {
          id: "duration",
          label: "Duration",
          show: (s) => s.ended_at != null,
          value: (s) => ({
            kind: "text",
            text: formatDuration((s.ended_at as number) - s.started_at),
          }),
          tooltip: true,
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
          tooltip: true,
        },
        {
          id: "end",
          label: "End",
          show: (s) => s.ended_at != null,
          value: (s) => ({ kind: "text", text: compactTime(s.ended_at as number) }),
          tooltip: true,
        },
        {
          id: "duration",
          label: "Duration",
          show: (s) => s.ended_at != null,
          value: (s) => ({
            kind: "text",
            text: formatDuration((s.ended_at as number) - s.started_at),
          }),
          tooltip: true,
        },
      ],
    },
  ],
};

// ponytail: shared section renderer. Walks the resolved sections and
// emits DetailSection + DetailRow per row. Header is rendered separately
// in SpanDetails (it carries status / id which aren't schema fields).
const ResolvedSections: FC<{ sections: ResolvedSection[] }> = ({ sections }) => (
  <>
    {sections.map((s) => {
      // ponytail: details:false opts a row out of the details card but
      // leaves it in the tooltip. Used when a fuller version of the
      // same data lives in a later section (Tokens row vs Total cost
      // breakdown).
      const visible = s.rows.filter((r) => r.details);
      if (visible.length === 0) return null;
      return (
        <DetailSection key={s.id} title={s.title}>
          {visible.map((r) =>
            r.bare ? (
              <FieldRenderer key={r.id} value={r.value} />
            ) : (
              <DetailRow key={r.id} label={r.label}>
                <FieldRenderer value={r.value} />
              </DetailRow>
            ),
          )}
        </DetailSection>
      );
    })}
    {/* Error sits outside the schema — every kind can have one, and
        putting it in each kind's list would duplicate the boilerplate. */}
  </>
);

const SpanDetails: FC<{ span: CapturedSpan }> = ({ span }) => {
  const meta = span.meta ?? {};
  const node = (meta.langgraph_node as string | undefined) ?? null;
  // ponytail: walk the kind's section list. show/value() returns null
  // → row dropped. Section with all rows dropped → whole section
  // dropped. Single source of truth for both details and tooltip.
  const sections = resolveSections(span, DETAIL_SECTIONS_BY_KIND[span.kind]);
  return (
    <div className="border-border bg-card space-y-3 rounded-lg border p-4 text-sm">
      {/* ponytail: header — name on its own line (full width, no
          squeeze from a floated status column), then a metadata row
          with kind chip + id (left) and StatusBadge (right).
          Duration used to live in the header but it duplicates the
          Duration row in the TIME section below — drop it. */}
      <div className="space-y-1.5">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-semibold">
            {/* ponytail: use span.name for llm/tool/human/retriever
                (those have meaningful names — "ChatOpenAI",
                "ask_location", "interrupt"). For node/chain, name is
                often a generic LC class like "RunnableSequence" and
                the langgraph_node is the readable identifier. The
                `@{node}` annotation sits next to the name when the
                two differ and the kind is one of the meaningful-name
                kinds — the wrapper case (node/chain) doesn't need
                it because node already drives the title. */}
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
            {/* ponytail: kind uses the same colored TypeChip as the
                legend rows so the header shares one label design
                language with the status badge (pill + dot vs pill +
                icon — same shape, different glyph). */}
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

// ponytail: name search was removed — the header now leads with stat
// cards and the waterfall is the only view. SpanData filtering still
// happens in Sheet (filtered route by parent_message_id) when needed.
export const ObservabilityPanel: FC<ObservabilityPanelProps> = ({
  spans,
  rawSpans,
  retentionDays,
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const aui = useAui({ span: SpanResource({ spans }) } as unknown as Parameters<typeof useAui>[0]);

  // ponytail: rawById is keyed by SpanData.id (what the row carries).
  // For leaf rows that's the LC run_id directly. For step wrappers
  // (id = "step-N-node-ns") the transform picks the earliest raw span
  // inside that step as the representative — clicking the row should
  // surface that span's full meta/payload in the details card.
  const rawById = useMemo(() => {
    const m = new Map<string, CapturedSpan>();
    if (!rawSpans) return m;
    for (const s of rawSpans) m.set(s.span_id, s);
    for (const spanData of spans) {
      if (m.has(spanData.id)) continue;
      const node = spanData.name;
      // ponytail: collect every raw span that belongs to this step
      // (same node name) and pick the earliest-starting one — matches
      // transform.ts's repRaw selection.
      const candidates = rawSpans
        .filter((s) => s.meta?.langgraph_node === node)
        .sort((a, b) => a.started_at - b.started_at);
      if (candidates[0]) m.set(spanData.id, candidates[0]);
    }
    return m;
  }, [rawSpans, spans]);

  const root = useMemo(() => (rawSpans ? aggregateRoot(rawSpans) : null), [rawSpans]);
  const selected = selectedId ? (rawById.get(selectedId) ?? null) : null;

  return (
    <>
      {root && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <StatCard
            icon={<ClockIcon className="text-muted-foreground size-3.5" />}
            label="Duration"
            value={formatDuration(root.totalDurationMs)}
          />
          {root.llmSpanCount > 0 && (
            <StatCard
              icon={<BrainIcon className="size-3.5" style={{ color: TYPE_COLORS.llm }} />}
              label="LLM calls"
              value={String(root.llmSpanCount)}
            />
          )}
          {root.toolSpanCount > 0 && (
            <StatCard
              icon={<WrenchIcon className="size-3.5" style={{ color: TYPE_COLORS.tool }} />}
              label="Tool calls"
              value={String(root.toolSpanCount)}
            />
          )}
          {root.failedCount > 0 && (
            <StatCard
              icon={<AlertCircleIcon className="text-destructive size-3.5" />}
              label="Failed"
              value={String(root.failedCount)}
            />
          )}
          {root.waitingCount > 0 && (
            <StatCard
              icon={<ClockIcon className="size-3.5" style={{ color: TYPE_COLORS.human }} />}
              label="Waiting"
              value={String(root.waitingCount)}
            />
          )}
          {root.totalInput > 0 && (
            <StatCard
              icon={<ArrowDownIcon className="text-muted-foreground size-3.5" />}
              label="Input"
              value={`${fmt(root.totalInput)} token`}
            />
          )}
          {root.totalOutput > 0 && (
            <StatCard
              icon={<ArrowUpIcon className="text-muted-foreground size-3.5" />}
              label="Output"
              value={`${fmt(root.totalOutput)} token`}
            />
          )}
          {root.totalTokens > 0 && (
            <StatCard
              icon={<DatabaseIcon className="text-muted-foreground size-3.5" />}
              label="Total"
              value={`${fmt(root.totalTokens)} token`}
            />
          )}
        </div>
      )}

      <div className="-mx-6 min-h-0 flex-1 overflow-auto px-6 lg:overflow-hidden">
        {rawSpans && rawSpans.length === 0 ? (
          <div className="text-muted-foreground text-sm">No spans recorded.</div>
        ) : (
          <AuiProvider value={aui}>
            <SelectionContext.Provider value={{ selectedId, select: setSelectedId, rawById }}>
              {/* ponytail: side-by-side on lg+ (waterfall left, details
                  right). Below lg the grid collapses to a single column
                  so mobile keeps the natural top-to-bottom flow. Both
                  cells need min-h-0 so the inner overflow scroll
                  actually clips instead of pushing the parent taller. */}
              <div className="flex min-h-0 flex-col gap-2 lg:h-full lg:flex-row">
                <div className="min-h-0 lg:flex-1 lg:overflow-auto">
                  <WaterfallTimeline retentionDays={retentionDays ?? null} />
                </div>
                {selected && (
                  <div className="min-h-0 lg:max-w-none lg:w-[min(40%,28rem)] lg:overflow-auto">
                    <SpanDetails span={selected} />
                  </div>
                )}
              </div>
            </SelectionContext.Provider>
          </AuiProvider>
        )}
      </div>
    </>
  );
};

// ponytail: the panel renders inside whatever container the caller
// supplies — Sheet, Dialog, div, anything. We don't pin it to a
// particular chrome.
