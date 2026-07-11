// ponytail: minimal MVP — in-memory only, no DB, no LangGraph wiring.
// Just hook the 25 callbacks into one SpanRow-shaped list so we can see
// what real payloads look like. Delete this whole file once §10 lands.
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import { isGraphInterrupt } from "@langchain/langgraph";
import { lastHumanMessageId } from "@/lib/langgraph/last-human-message-id";
import { bulkInsertSpans } from "@/lib/observability/queries";

// Subset of §9.1 columns that a callback handler can populate. Some
// (thread_id, user_id, turn_no) are fill-in fields — the handler leaves
// them blank and a wrapper adds them before write.
export type CapturedSpan = {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: "llm" | "tool" | "node" | "chain" | "retriever" | "human" | "unknown";
  // ponytail: `waiting` is the status of a span paused on a LangGraph
  // `interrupt()` — the tool call itself is fine, it just yielded the
  // graph back to the runtime so a human (or another agent) can resume.
  status: "running" | "completed" | "failed" | "waiting";
  started_at: number; // ms epoch
  ended_at: number | null;
  // callback payload fields
  input: unknown;
  output: unknown;
  usage: Record<string, unknown> | null;
  error: string | null;
  // ponytail: LLM-only fields live under meta so the top-level columns
  // stay stable for §9.1. TTFT is set on the first token callback,
  // null for non-LLM spans or when streaming isn't observed.
  meta: Record<string, unknown> & {
    time_to_first_token_ms?: number | null;
  };
};

type Partial = Omit<CapturedSpan, "ended_at" | "output" | "usage" | "error" | "meta"> & {
  ended_at: number | null;
  output: unknown;
  usage: Record<string, unknown> | null;
  error: string | null;
  meta: CapturedSpan["meta"];
};

type StartPayload = Pick<Partial, "kind" | "name" | "input"> & {
  meta?: CapturedSpan["meta"];
};

// ponytail: LC messages reach callbacks in four shapes — each detected
// by its own predicate, all normalized into the same
// {role, content, tool_calls, ...} row shape:
//   1. live instance: HumanMessage / AIMessageChunk / ToolMessage objects
//      carrying Symbol.for("langchain.message") = true. Doesn't reach the
//      callback in practice (LC serializes via .toJSON() first), but kept
//      for completeness so the unwrapper never crashes on a class instance.
//   2. V1 envelope: {lc:1, type:"constructor", id:[...], kwargs:{...}}
//      produced by Serializable.toJSON(). Canonical LC wire format.
//   3. V2 envelope: {lc_serializable:true, lc_namespace:[...], lc_kwargs:{...}}
//      emitted when an object crosses a layer that JSON.stringify-walks
//      own properties instead of calling .toJSON() (streaming chunks,
//      custom serializers). lc_namespace is whatever was on the instance —
//      NOT guaranteed to be a class-name path; can be chatcmpl UUIDs.
//   4. flat: {type|role, content, tool_calls, id, ...} already-constructed
//      message objects the reducer / chat template injected into GraphState.
//      Coexist with V1/V2 envelopes in the same array.
//
// Role authority: lc_kwargs.type (V2) > kwargs.type (V1) > top-level type
// > top-level role. Class name derived from id / lc_namespace is NEVER used —
// trusting those arrays produced role:"e" / role:"0" garbage when the array
// was a chatcmpl or message UUID instead of a class-name path.
const MESSAGE_SYMBOL = Symbol.for("langchain.message");

type MessageFields = {
  role?: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  id?: string;
  additional_kwargs?: Record<string, unknown>;
  response_metadata?: Record<string, unknown>;
};

function readMessageField(outer: Record<string, unknown>, field: string): unknown {
  // ponytail: getWireMessageField pattern from @langchain/langgraph-sdk —
  // try top-level first, then kwargs, then lc_kwargs. Peels content /
  // role / tool_calls regardless of envelope shape.
  if (field in outer && outer[field] !== undefined) return outer[field];
  const k = outer.kwargs;
  if (k && typeof k === "object" && field in k) {
    const v = (k as Record<string, unknown>)[field];
    if (v !== undefined) return v;
  }
  const lk = outer.lc_kwargs;
  if (lk && typeof lk === "object" && field in lk) {
    const v = (lk as Record<string, unknown>)[field];
    if (v !== undefined) return v;
  }
  return undefined;
}

function unwrapMessage(v: unknown): MessageFields | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown> & { [MESSAGE_SYMBOL]?: boolean };

  // Path 1 — live BaseMessage instance. Symbol.for("langchain.message") = true
  // is set on the BaseMessage class. Own properties carry everything we need.
  // ponytail: this is actually the dominant path in our graph — LC doesn't
  // call .toJSON() on messages that survive through the reducer into
  // GraphState.output, so handleChainEnd sees live instances, not envelopes.
  if (o[MESSAGE_SYMBOL] === true) {
    const result: MessageFields = {};
    if (typeof o.type === "string") result.role = o.type;
    if (o.content !== undefined) result.content = o.content;
    if (Array.isArray(o.tool_calls) && o.tool_calls.length > 0) result.tool_calls = o.tool_calls;
    if (typeof o.tool_call_id === "string") result.tool_call_id = o.tool_call_id;
    if (typeof o.name === "string") result.name = o.name;
    if (typeof o.id === "string") result.id = o.id;
    if (o.additional_kwargs && typeof o.additional_kwargs === "object") {
      const ak = o.additional_kwargs as Record<string, unknown>;
      if (Object.keys(ak).length > 0) result.additional_kwargs = ak;
    }
    if (o.response_metadata && typeof o.response_metadata === "object") {
      const rm = o.response_metadata as Record<string, unknown>;
      if (Object.keys(rm).length > 0) result.response_metadata = rm;
    }
    return result;
  }

  // Path 2 + 3 — V1 / V2 envelope (serialized form). Same field-extraction
  // path; readMessageField tries top-level → kwargs → lc_kwargs.
  const isV1 = o.lc === 1 && o.type === "constructor";
  const isV2 = "lc_serializable" in o && "lc_namespace" in o;
  if (isV1 || isV2) {
    const result: MessageFields = {};
    const typeVal = readMessageField(o, "type");
    const roleVal = readMessageField(o, "role");
    const raw =
      (typeof typeVal === "string" ? typeVal : null) ??
      (typeof roleVal === "string" ? roleVal : null);
    if (raw) result.role = raw;
    const content = readMessageField(o, "content");
    if (content !== undefined) {
      if (typeof content === "string") {
        // ToolMessage content is often a JSON string — parse for readable display.
        try {
          result.content = JSON.parse(content);
        } catch {
          result.content = content;
        }
      } else {
        result.content = content;
      }
    }
    const ak = readMessageField(o, "additional_kwargs");
    if (ak && typeof ak === "object" && Object.keys(ak).length > 0) {
      result.additional_kwargs = ak as Record<string, unknown>;
    }
    const tc = readMessageField(o, "tool_calls");
    if (Array.isArray(tc) && tc.length > 0) result.tool_calls = tc;
    const tcid = readMessageField(o, "tool_call_id");
    if (typeof tcid === "string") result.tool_call_id = tcid;
    const name = readMessageField(o, "name");
    if (typeof name === "string") result.name = name;
    const id = readMessageField(o, "id");
    if (typeof id === "string") result.id = id;
    const rm = readMessageField(o, "response_metadata");
    if (rm && typeof rm === "object" && Object.keys(rm).length > 0) {
      result.response_metadata = rm as Record<string, unknown>;
    }
    return result;
  }

  // Path 4 — flat (no envelope, no live marker). Caller handles outside.
  return null;
}

// ponytail: walk the messages array in a graph.invoke input, return the
// id of the last HumanMessage (or null). The id is what assistant-ui puts
// on the user message; the assistant message rendered in the thread
// carries the same id as its `parentId`, so the Sheet can later filter
// spans by clicking the icon on a specific assistant message.
//
// Implementation moved to lib/langgraph/last-human-message-id so
// triggerBackgroundAgentNode can share it (also needs the parent
// message id for runs.create metadata).
function isLCMessageEnvelope(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown> & { [MESSAGE_SYMBOL]?: boolean };
  return (
    (o.lc === 1 && o.type === "constructor") ||
    ("lc_serializable" in o && "lc_namespace" in o) ||
    o[MESSAGE_SYMBOL] === true
  );
}

function deepUnwrapLC(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(deepUnwrapLC);
  if (v && typeof v === "object") {
    if (isLCMessageEnvelope(v)) {
      const unwrapped = unwrapMessage(v);
      if (unwrapped) return unwrapped;
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = deepUnwrapLC(val);
    return out;
  }
  return v;
}

export class CapturingHandler extends BaseCallbackHandler {
  name = "capturing";
  // runId → in-flight record. End hooks look up, mutate, leave behind.
  // ponytail: Map, not LRU. Demo only.
  private spans = new Map<string, Partial>();

  // ponytail: LangChain's parent_run_id is unreliable under compiled
  // subgraphs (chains inside a subgraph report the root as parent).
  // We rebuild the call hierarchy from `langgraph_checkpoint_ns`
  // instead — the ns encodes the wrapper stack directly, so the parent
  // of any span is the sibling span whose ns is the current ns with
  // its trailing
  // "|name:uuid" segment stripped. LC's parent_run_id is ignored.
  private runIdByNs = new Map<string, string>();
  // ponytail: previously tracked the most recent open `kind: "human"`
  // span here so the next outermost handleChainStart could finalize it.
  // Removed — in-memory state dies on `langgraphjs dev` process restart
  // (each resume spawns a fresh process), so the field is write-only in
  // practice. The visual marker is still useful, just not auto-finalized;
  // the panel renders `status: "waiting"` as `running` so the bar keeps
  // ticking until something else updates it.
  private actualParent = new Map<string, string | null>();

  // ponytail: per-invoke last HumanMessage id. Set by the outermost
  // handleChainStart from `inputs.messages`, inherited unchanged by
  // nested spans in the same invoke. May be null when the run is a
  // resume / regen / cold-start invoke with empty inputs — null is
  // fine because bulkInsertSpans backfills from DB before INSERT,
  // so spans in interrupted-or-recovered turns still tag with the
  // thread's most recent non-null parent_message_id.
  private currentParentMessageId: string | null = null;

  constructor() {
    super();
  }

  // ---- Start hooks: every Start allocates a span, every End mutates it. ----
  handleChainStart(
    chain: Serialized,
    inputs: Record<string, unknown>,
    runId: string,
    runType?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
    parentRunId?: string,
  ) {
    // ponytail: outermost call only — overwrite `currentParentMessageId`
    // with the last HumanMessage id from `inputs.messages`. Null is OK
    // for resume / regen / cold-start turns — bulkInsertSpans backfills
    // from DB before INSERT.
    if (!runType) {
      this.currentParentMessageId = lastHumanMessageId((inputs as { messages?: unknown }).messages);
    }

    this.start(runId, parentRunId ?? null, {
      kind: "chain",
      name: runName ?? chain.id?.[chain.id.length - 1] ?? "chain",
      input: deepUnwrapLC(inputs),
      meta: { ...metadata, ...(tags?.length ? { tags } : {}) },
    });
  }

  handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) {
    this.start(runId, parentRunId ?? null, {
      kind: "llm",
      name: runName ?? llm.id?.[llm.id.length - 1] ?? "llm",
      input: { prompts },
      meta: {
        ...metadata,
        serialized_llm: llm.id,
        ...(tags?.length ? { tags } : {}),
      },
    });
  }

  handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) {
    this.start(runId, parentRunId ?? null, {
      kind: "llm",
      name: runName ?? llm.id?.[llm.id.length - 1] ?? "chat-model",
      input: { prompts: messages.map(stringifyMessages) },
      meta: {
        ...metadata,
        serialized_llm: llm.id,
        ...(tags?.length ? { tags } : {}),
      },
    });
  }

  handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
    toolCallId?: string,
  ) {
    this.start(runId, parentRunId ?? null, {
      kind: "tool",
      name: runName ?? tool.id?.[tool.id.length - 1] ?? tool.name ?? "tool",
      input,
      meta: { ...metadata, tool_call_id: toolCallId ?? null, ...(tags?.length ? { tags } : {}) },
    });
  }

  handleRetrieverStart(
    _retriever: Serialized,
    query: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string,
  ) {
    this.start(runId, parentRunId ?? null, {
      kind: "retriever",
      name: name ?? "retriever",
      input: query,
      meta: { ...metadata, ...(tags?.length ? { tags } : {}) },
    });
  }

  // ponytail: TTFT (time-to-first-token) — LangSmith's core LLM latency
  // metric. LangChain core 1.2.x signature: handleLLMNewToken(token, idx, runId, ...).
  // The third positional arg is the runId; `rest` is a `unknown[]` so we
  // grab the first string match. Set on the first token; later tokens no-op.
  // ponytail: trimMeta initializes time_to_first_token_ms to null at
  // start() time, so the guard must accept both null and undefined —
  // checking only === undefined means the first token never sets TTFT
  // and every row persists as null.
  handleLLMNewToken(_token: string, ...rest: unknown[]) {
    const runId = rest.find((a) => typeof a === "string") as string | undefined;
    if (!runId) return;
    const s = this.spans.get(runId);
    const current = s?.meta.time_to_first_token_ms;
    if (s && (current === undefined || current === null)) {
      s.meta.time_to_first_token_ms = Date.now() - s.started_at;
    }
  }

  // ---- End hooks: mutate the in-flight span. ----
  handleChainEnd(outputs: Record<string, unknown>, runId: string) {
    this.end(runId, { output: deepUnwrapLC(outputs) });
    // ponytail: outermost chain end → clear the per-invoke parent id so
    // a subsequent invoke (regenerate, follow-up) recomputes it. Inner
    // ends leave it intact.
    this.persistSpan(runId);
  }

  handleLLMEnd(output: LLMResult, runId: string) {
    // §4: usage lives on output.generations[0][0].message.usage_metadata.
    // The Generation type doesn't expose `.message` directly — it's a LangChain
    // ChatGeneration vs LLMResult distinction. Reach through the `text` field's
    // adjacent properties via cast.
    const gen = output.generations?.[0]?.[0] as
      | { message?: { usage_metadata?: unknown } }
      | undefined;
    const usage = (gen?.message?.usage_metadata ?? null) as Record<string, unknown> | null;
    const fallbackUsage = (output.llmOutput as { tokenUsage?: Record<string, unknown> } | undefined)
      ?.tokenUsage;
    this.end(runId, {
      output: trimGenerations(deepUnwrapLC(output)),
      usage: usage ?? fallbackUsage ?? null,
    });
    this.persistSpan(runId);
  }

  handleToolEnd(output: unknown, runId: string) {
    this.end(runId, { output: trimToolOutput(deepUnwrapLC(output)) });
    this.persistSpan(runId);
  }

  handleRetrieverEnd(documents: unknown, runId: string) {
    this.end(runId, { output: deepUnwrapLC(documents) });
    this.persistSpan(runId);
  }

  // ---- Errors close the span as failed. ----
  handleChainError(err: Error, runId: string) {
    // ponytail: `interrupt()` throws a GraphInterrupt that unwinds
    // through every wrapper in the call stack — tools RunnableSequence,
    // inner CompiledStateGraph, outer RunnableSequence. Each one fires
    // handleChainError here, but they're not failures; the interrupt
    // is the intended pause. Mirror handleToolError: flip status to
    // completed + null error, stamp ended_at so markRunningAsFailed
    // doesn't mis-flag the wrapper on restart.
    if (isGraphInterrupt(err)) {
      const span = this.spans.get(runId);
      if (span) {
        span.status = "waiting";
        span.error = null;
        // ponytail: waiting ended_at can't be inferred yet, will be backfilled later.
        span.ended_at = null;
        this.persistSpan(runId);
      }
      return;
    }
    this.end(runId, { status: "failed", error: err.message });
    this.persistSpan(runId);
  }

  handleLLMError(err: Error, runId: string) {
    this.end(runId, { status: "failed", error: err.message });
    this.persistSpan(runId);
  }

  handleToolError(err: Error, runId: string) {
    // ponytail: GraphInterrupt is what `interrupt()` throws to yield the
    // graph back to the runtime pending a human resume. It's NOT a
    // failure — the tool itself is fine. Two observable changes:
    //   1. The interrupted tool span flips to status="completed" with
    //      ended_at cleared (the tool "ended" from the model's POV but
    //      didn't produce a value — the resume will fill it in via the
    //      re-invoked tool's normal End).
    //   2. A child synthetic span kind="human" / status="waiting" is
    //      inserted so the panel shows the wait gap explicitly. It
    //      stays open (`status: "waiting"` → panel `running`) until the
    //      next bulkInsert of the same span overwrites it; previously
    //      an in-memory `openHumanSpanId` field finalized it on the
    //      next outermost handleChainStart, but that field dies on
    //      `langgraphjs dev` process restart.
    if (isGraphInterrupt(err)) {
      const span = this.spans.get(runId);
      if (span) {
        span.status = "completed";
        span.error = null;
        span.ended_at = Date.now();
        this.persistSpan(runId);

        // add human interrupt span
        const humanSpanId = `${span.span_id}-interrupt`;
        const humanSpan: CapturedSpan = {
          span_id: humanSpanId,
          parent_span_id: span.span_id,
          name: "interrupt",
          kind: "human",
          status: "waiting",
          started_at: Date.now() + 100, // add 100ms to ensure it's after the tool ended
          ended_at: null,
          input: null,
          output: null,
          usage: null,
          error: null,
          // ponytail: stamp the awaited tool name so bulkInsertSpans'
          // backfillWaitingInterruptSpans can match on it instead of
          // closing every waiting human span on the thread. The
          // openHumanSpanId in-memory finalize was dropped (dies on
          // langgraphjs dev restart); the DB-side backfill is the
          // survivor.
          meta: { ...span.meta, interrupt: true, interrupt_tool: span.name },
        };
        this.spans.set(humanSpanId, humanSpan);
        this.persistSpan(humanSpanId);
      }
      return;
    }

    this.end(runId, { status: "failed", error: err.message });
    this.persistSpan(runId);
  }

  // ---- Internal ----
  private start(runId: string, parentRunId: string | null, partial: StartPayload) {
    // ponytail: parent = sibling span whose ns is the current ns with its
    // trailing "|name:uuid" stripped. Outer nodes have no "|" in their ns
    // → parent is null (root). The wrapper's ns was registered the moment
    // it started, before its inner children's Starts fire — no race.
    const ns = partial.meta?.langgraph_checkpoint_ns;
    let actual: string | null = null;
    if (typeof ns === "string") {
      const pipeAt = ns.lastIndexOf("|");
      if (pipeAt > 0) actual = this.runIdByNs.get(ns.slice(0, pipeAt)) ?? null;
    }
    if (typeof ns === "string") this.runIdByNs.set(ns, runId);
    this.actualParent.set(runId, actual);
    // ponytail (Phase 1b): strip verbose keys from incoming meta before
    // anything else. Keeps only what the panel actually renders:
    //   thread id, the run lineage, the route (langgraph_node/_step/_ns),
    //   tags for nostream/etc., model name for header, and the TTFT.
    const meta = trimMeta(partial.meta);
    meta.time_to_first_token_ms ??= null;
    meta.parent_message_id = this.currentParentMessageId;

    // ponytail: when `currentParentMessageId` is null at the outermost
    // span (interrupt resume / regenerate / cold start — `inputs.messages`
    // had no HumanMessage), the span gets stamped null here on purpose.
    // Don't fire a DB lookup from this synchronous Start hook — the
    // promise would resolve after handleChainEnd has already triggered
    // bulkInsertSpans, and the `.then()` patch would land on a span
    // that's been INSERTed (or about to be). The backfill in
    // `bulkInsertSpans` reads the column at INSERT time and fills every
    // null row in one pass — single source of truth, race-free by
    // construction.

    this.spans.set(runId, {
      span_id: runId,
      parent_span_id: parentRunId,
      kind: partial.kind,
      name: partial.name,
      status: "running",
      started_at: Date.now(),
      ended_at: null,
      input: partial.input,
      output: undefined,
      usage: null,
      error: null,
      meta,
    });
  }

  private end(
    runId: string,
    patch: {
      output?: unknown;
      usage?: Record<string, unknown> | null;
      status?: "failed" | "completed" | "waiting";
      error?: string;
    },
  ) {
    const s = this.spans.get(runId);
    if (!s) {
      // End without matching Start — usually tool args streaming. Drop silently.
      return;
    }
    s.ended_at = Date.now();
    if (patch.output !== undefined) s.output = patch.output;
    if (patch.usage !== undefined) s.usage = patch.usage;
    if (patch.error !== undefined) s.error = patch.error;
    if (patch.status) s.status = patch.status;
    // ponytail: don't auto-flip a `waiting` span back to `completed` —
    // that would clobber the interrupt marker set by handleToolError
    // when an outer chain End fires after the tool errored.
    else if (s.status !== "failed" && s.status !== "waiting") s.status = "completed";
  }

  // ponytail: persist on every End hook that fires. LC's callback
  // order is unpredictable — under StateGraph, the outer chain end
  // doesn't reach a handler that's only attached via model
  // .withConfig({callbacks}). Each *End we receive is independently
  // persisted; ON CONFLICT DO NOTHING swallows the duplicate that
  // happens when the outer chain eventually fires too.
  private persistSpan(runId: string) {
    const span = this.spans.get(runId);
    if (!span) return;
    bulkInsertSpans([span]).catch((err: unknown) => {
      console.error(`[CapturingHandler] bulkInsert failed for ${runId}:`, err);
    });
  }

  /** Snapshot — finished spans plus any still-running. */
  snapshot(): CapturedSpan[] {
    return Array.from(this.spans.values()).map((s) => ({
      ...s,
      // ponytail: overwrite parent_span_id with the ns-derived one.
      // LC's parent_run_id is unreliable under compiled subgraphs.
      parent_span_id: this.actualParent.has(s.span_id)
        ? (this.actualParent.get(s.span_id) ?? null)
        : s.parent_span_id,
    }));
  }

  /** ponytail: aborted invokes leave Start-only spans with ended_at: null.
   *  Mark them failed so the panel doesn't render them as "running" forever —
   *  SpanResource uses null-ended spans to extend timeRange.max to Date.now(). */
  markRunningAsFailed(): void {
    const now = Date.now();
    for (const s of this.spans.values()) {
      if (s.ended_at === null) {
        s.status = "failed";
        s.error = s.error ?? "aborted";
        s.ended_at = now;
      }
    }
  }
}

import type { BaseMessage } from "@langchain/core/messages";

// ---- Phase 1 payload trims ------------------------------------------------
// ponytail (Phase 1b): meta whitelist. Anything outside `META_KEEPERS` is
// either a duplicate (checkpoint_ns == langgraph_checkpoint_ns) or noise
// (langgraph_api_url, host, version). Drop before persist — the panel only
// renders node/step/ns/tags/run name/model/thread.
const META_KEEPERS = new Set([
  "tags",
  "run_id",
  "thread_id",
  "langgraph_thread_id",
  "langgraph_node",
  "langgraph_step",
  "langgraph_checkpoint_ns",
  "ls_model_name",
  "time_to_first_token_ms",
  "tool_call_id",
  "parent_message_id",
]);

function trimMeta(raw: Record<string, unknown> | undefined): CapturedSpan["meta"] {
  const out: CapturedSpan["meta"] = {
    time_to_first_token_ms: null,
  };
  if (!raw) return out;

  for (const k of Object.keys(raw)) {
    if (META_KEEPERS.has(k)) (out as Record<string, unknown>)[k] = raw[k];
  }
  // ponytail: if upstream already populated ttft (handleLLMNewToken fired
  // before meta was set), keep it. Otherwise default null.
  if (out.time_to_first_token_ms === undefined) out.time_to_first_token_ms = null;
  return out;
}

// ponytail (Phase 1c): strip OpenAI noise from generations[*][*].genInfo.
// `prompt`, `completion` are per-token streaming counters (always 0 once the
// stream closes); system_fingerprint is provider metadata that doesn't help
// debugging. model_name + finish_reason are kept (panel headers).
function trimGenerations(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  const o = output as Record<string, unknown>;
  if (!Array.isArray(o.generations)) return output;
  o.generations = (o.generations as unknown[]).map((row) => {
    if (!Array.isArray(row)) return row;
    return (row as unknown[]).map((msg) => {
      if (!msg || typeof msg !== "object") return msg;
      const m = msg as Record<string, unknown>;
      const gi = m.generationInfo as Record<string, unknown> | undefined;
      if (gi) {
        delete gi.prompt;
        delete gi.completion;
        delete gi.system_fingerprint;
      }
      return m;
    });
  });
  return o;
}

// ponytail (Phase 1c): cap tool output's content field to 2KB so fetch_url
// on a long page doesn't bloat the row. Keep the first 1.5KB, a marker,
// and the last 200B so the operator gets the start and the conclusion.
const TOOL_HEAD_BYTES = 1500;
const TOOL_TAIL_BYTES = 200;

function trimToolOutput(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  const o = output as Record<string, unknown>;
  const raw = typeof o.content === "string" ? o.content : null;
  if (!raw) return o;
  if (raw.length <= TOOL_HEAD_BYTES + TOOL_TAIL_BYTES + 32) return o;
  o.content =
    raw.slice(0, TOOL_HEAD_BYTES) +
    `\n\n…[truncated ${raw.length - TOOL_HEAD_BYTES - TOOL_TAIL_BYTES} chars]…\n\n` +
    raw.slice(raw.length - TOOL_TAIL_BYTES);
  return o;
}

// ponytail: one helper, one place. Prompts are what the provider sees — keep
// them as the model sees them, don't down-cast to structured messages.
//
// AIMessage with tool_calls has empty content (the model emitted no prose,
// just a function call). Without the tool_call fallback the panel renders a
// blank <pre> for that message.
function stringifyMessages(msgs: BaseMessage[]): string {
  return msgs
    .map((m) => {
      // _getType is deprecated but still works on every version we ship;
      // getType() returns the same value via the modern public API.
      const role = (m as unknown as { getType: () => string }).getType();
      const content =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content, null, 0);
      // ponytail: tool_calls lives on AIMessage; ToolMessage has tool_call_id
      // instead. Cast mirrors LangChain's own serialize() shape.
      const toolCalls = (m as unknown as { tool_calls?: Array<{ name: string; args: unknown }> })
        .tool_calls;
      const toolCallBody =
        toolCalls && toolCalls.length > 0
          ? toolCalls.map((tc) => `[tool_call ${tc.name}(${JSON.stringify(tc.args)})]`).join("\n")
          : "";
      return `${role}: ${content || toolCallBody}`;
    })
    .join("\n");
}
