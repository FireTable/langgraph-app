"use client";

// ponytail: pure renderer. The button.tsx controller owns fetch + the
// Sheet chrome; the panel just needs data and renders the search box
// + waterfall + details. Hosting its own <Sheet> here would wrap the
// panel in a second dialog — exactly what we don't want. No Sheet /
// Dialog imports in this file.
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
import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BoxIcon,
  BrainIcon,
  ClockIcon,
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

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", " UTC");
}

// ponytail: same shape as the waterfall's axis ticks — <1s in ms, else seconds.
// Consistent readout across the panel.
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return `${s.toFixed(s < 10 ? 2 : 1)}s`;
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

const WaterfallRow: FC = () => {
  const { barWidth, contentWidth } = useWaterfallLayout();
  const id = useAuiState((s) => (s as unknown as { span: SpanItemState }).span.id);
  const { selectedId, select, rawById } = useSelection();
  const isSelected = selectedId === id;
  // ponytail: surface the LLM model name ahead of the LangChain class
  // name (e.g. "ChatOpenAI") so the row reads model-first — useful
  // when a thread hops between providers. meta.ls_model_name is the
  // LangSmith-shaped key, set by ChatOpenAI / Anthropic / etc. on
  // every LLM callback. Falls back silently for tool / node / human.
  const raw = rawById.get(id);
  const meta = (raw?.meta ?? null) as Record<string, unknown> | null;
  const modelName = typeof meta?.ls_model_name === "string" ? meta.ls_model_name : null;
  return (
    <SpanPrimitive.Root
      onClick={() => select(id)}
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

const WaterfallTimeline: FC<{ retentionDays: number | null }> = ({ retentionDays }) => {
  const outerRef = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(400);

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
    totalCacheRead: cache_read,
    totalReasoning: reasoning,
    ttftAvgMs,
    ttftMaxMs,
    llmSpanCount: llms.length,
    toolSpanCount: spans.filter((s) => s.kind === "tool").length,
    failedCount: spans.filter((s) => s.status === "failed").length,
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

const DetailRow: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="grid grid-cols-[140px_1fr] gap-3 py-1 text-sm">
    <div className="text-muted-foreground">{label}</div>
    <div>{children}</div>
  </div>
);

const TokenBreakdownView: FC<{ tokens: TokenBreakdown }> = ({ tokens }) => {
  const input = Math.max(tokens.input, 1);
  const output = Math.max(tokens.output, 1);
  const total = tokens.total || input + output;
  const inputPct = Math.round((tokens.input / Math.max(total, 1)) * 100);
  const outputPct = 100 - inputPct;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">Input</span>
        <span className="text-xs tabular-nums">
          {inputPct}% / {fmt(tokens.input)}
        </span>
        {tokens.cache_read > 0 && (
          <span className="text-muted-foreground text-xs">cache_read {fmt(tokens.cache_read)}</span>
        )}
        <div className="bg-muted ml-auto h-1.5 w-32 overflow-hidden rounded">
          <div className="bg-primary h-full" style={{ width: `${inputPct}%` }} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">Output</span>
        <span className="text-xs tabular-nums">
          {outputPct}% / {fmt(tokens.output)}
        </span>
        {tokens.reasoning > 0 && (
          <span className="text-muted-foreground text-xs">reasoning {fmt(tokens.reasoning)}</span>
        )}
        <div className="bg-muted ml-auto h-1.5 w-32 overflow-hidden rounded">
          <div className="bg-primary h-full" style={{ width: `${outputPct}%` }} />
        </div>
      </div>
      <div className="text-muted-foreground text-xs">Total {fmt(total)}</div>
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

const SpanDetails: FC<{ span: CapturedSpan }> = ({ span }) => {
  const tokens = readTokens(span.usage);
  const durationMs = span.ended_at ? span.ended_at - span.started_at : null;
  const meta = span.meta ?? {};
  const node = (meta.langgraph_node as string | undefined) ?? null;
  const step = meta.langgraph_step;
  const model = (meta.ls_model_name as string | undefined) ?? null;
  const provider = (meta.ls_provider as string | undefined) ?? null;
  return (
    <div className="border-border bg-card mt-3 space-y-2 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs">
          {span.kind}
        </span>
        <span className="font-medium">
          {span.kind === "tool" || span.kind === "llm" ? span.name : (node ?? span.name)}
        </span>
        {node && span.name !== node && (span.kind === "tool" || span.kind === "llm") && (
          <span className="text-muted-foreground text-xs">@ {node}</span>
        )}
        <span className="text-muted-foreground text-xs">id={span.span_id.slice(0, 8)}</span>
        <span className="ml-auto text-xs">
          {span.status} · {durationMs !== null ? formatDuration(durationMs) : "running"}
        </span>
      </div>

      <DetailRow label="Time">
        <div className="text-xs">
          Start {formatTimestamp(span.started_at)}
          {span.ended_at && <span> · End {formatTimestamp(span.ended_at)}</span>}
        </div>
      </DetailRow>

      {step !== undefined && (
        <DetailRow label="Tags">
          <span className="bg-muted rounded px-1.5 py-0.5 text-xs">{`graph:step:${String(step)}`}</span>
          {typeof meta.aggregated_children === "number" && meta.aggregated_children > 1 && (
            <span className="text-muted-foreground ml-2 text-xs">
              (aggregated {String(meta.aggregated_children)} spans)
            </span>
          )}
        </DetailRow>
      )}

      {model && (
        <DetailRow label="Model">
          <span className="text-xs">
            {model}
            {provider && <span className="text-muted-foreground"> · {provider}</span>}
          </span>
        </DetailRow>
      )}

      {tokens && (
        <DetailRow label="Token breakdown">
          <TokenBreakdownView tokens={tokens} />
        </DetailRow>
      )}

      {span.kind === "tool" && (
        <>
          <DetailRow label="Input">
            <JsonBlock data={typeof span.input === "string" ? span.input : span.input} />
          </DetailRow>
          <DetailRow label="Output">
            <JsonBlock data={span.output} maxHeight={240} />
          </DetailRow>
        </>
      )}

      {span.kind === "llm" && Array.isArray(span.input) && span.input.length > 0 && (
        <DetailRow label={`Wire prompts (${span.input.length})`}>
          <div className="space-y-2">
            {span.input.map((promptGroup: string, i: number) => {
              // ponytail: stringifyMessages joins messages with "\n", so a
              // multi-line system prompt ("system: ...\n  rules...\n- next: ...")
              // looks like a sequence of role lines. Only split on lines
              // whose prefix is a known role — otherwise treat as body.
              const knownRoles = new Set([
                "system",
                "human",
                "ai",
                "assistant",
                "tool",
                "function",
              ]);
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
        </DetailRow>
      )}

      {span.kind === "llm" &&
        (() => {
          const fields = readStructuredOutput(span);
          if (!fields || fields.length === 0) return null;
          return (
            <DetailRow label={`Fields (${String(fields.length)})`}>
              <div className="border-border rounded-md border">
                {fields.map((f, i) => (
                  <div
                    key={i}
                    className="border-border flex items-center gap-2 border-b px-2 py-1 text-xs last:border-b-0"
                  >
                    <span className="text-muted-foreground font-mono">{f.path}</span>
                    <span className="ml-auto font-mono">
                      {typeof f.value === "string" ? f.value : JSON.stringify(f.value)}
                    </span>
                  </div>
                ))}
              </div>
            </DetailRow>
          );
        })()}

      {span.error && (
        <DetailRow label="Error">
          <pre className="text-destructive text-xs whitespace-pre-wrap">{span.error}</pre>
        </DetailRow>
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

  // ponytail: rawById is keyed by LangChain run_id (UUID). The SpanDetails
  // card looks up the clicked span by its row id.
  const rawById = useMemo(() => {
    const m = new Map<string, CapturedSpan>();
    if (!rawSpans) return m;
    for (const s of rawSpans) m.set(s.span_id, s);
    return m;
  }, [rawSpans]);

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
          {root.totalInput > 0 && (
            <StatCard
              icon={<ArrowDownIcon className="text-muted-foreground size-3.5" />}
              label="Input"
              value={`${fmt(root.totalInput)} tok`}
            />
          )}
          {root.totalOutput > 0 && (
            <StatCard
              icon={<ArrowUpIcon className="text-muted-foreground size-3.5" />}
              label="Output"
              value={`${fmt(root.totalOutput)} tok`}
            />
          )}
          {root.totalCacheRead > 0 && (
            <StatCard
              icon={<DatabaseIcon className="text-muted-foreground size-3.5" />}
              label="Cache read"
              value={`${fmt(root.totalCacheRead)} tok`}
            />
          )}
          {root.ttftAvgMs != null && (
            <StatCard
              icon={<ZapIcon className="text-muted-foreground size-3.5" />}
              label="TTFT avg / max"
              value={`${formatDuration(root.ttftAvgMs)} / ${formatDuration(root.ttftMaxMs ?? 0)}`}
            />
          )}
        </div>
      )}

      <div className="-mx-6 min-h-0 flex-1 overflow-auto px-6">
        {rawSpans && rawSpans.length === 0 ? (
          <div className="text-muted-foreground text-sm">No spans recorded.</div>
        ) : (
          <AuiProvider value={aui}>
            <SelectionContext.Provider value={{ selectedId, select: setSelectedId, rawById }}>
              <WaterfallTimeline retentionDays={retentionDays ?? null} />
              {selected && <SpanDetails span={selected} />}
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
