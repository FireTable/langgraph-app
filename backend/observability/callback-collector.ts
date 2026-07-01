// ponytail: minimal MVP — in-memory only, no DB, no LangGraph wiring.
// Just hook the 25 callbacks into one SpanRow-shaped list so we can see
// what real payloads look like. Delete this whole file once §10 lands.
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";

// Subset of §9.1 columns that a callback handler can populate. Some
// (thread_id, user_id, turn_no) are fill-in fields — the handler leaves
// them blank and a wrapper adds them before write.
export type CapturedSpan = {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: "llm" | "tool" | "node" | "chain" | "retriever" | "unknown";
  status: "running" | "completed" | "failed";
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

// ponytail: `llm.kwargs` for ChatOpenAI includes the openai_api_key in
// plaintext. We strip any field whose name matches an api-key / secret
// pattern so the key never lands in the spans table.
// Patterns: *_api_key, *_apikey, api_key, apikey, *_secret, secret,
// password, *_password. Doesn't match `max_tokens` (no "key/secret/password"
// substring after stripping the word boundary).
const REDACT_KWARG_KEY = /(?:api[_-]?key|_password|^password$|_secret$|^secret$)/i;

function redactLLMKwargs(kwargs: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!kwargs) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(kwargs)) {
    out[k] = REDACT_KWARG_KEY.test(k) ? "***" : v;
  }
  return out;
}

// ponytail: Serialized is a union; only SerializedConstructor carries
// `kwargs`. Narrow before reading.
function serializedKwargs(s: Serialized): Record<string, unknown> | undefined {
  if (s.lc === 1 && s.type === "constructor" && s.kwargs && typeof s.kwargs === "object") {
    return s.kwargs as Record<string, unknown>;
  }
  return undefined;
}

export class CapturingHandler extends BaseCallbackHandler {
  name = "capturing";
  // runId → in-flight record. End hooks look up, mutate, leave behind.
  // ponytail: Map, not LRU. Demo only.
  private spans = new Map<string, Partial>();

  // ponytail: LangChain's parent_run_id is unreliable under USE_SUBGRAPH
  // (chains inside compiled subgraphs report root as parent). We rebuild
  // the call hierarchy from `langgraph_checkpoint_ns` instead — the ns
  // encodes the wrapper stack directly, so the parent of any span is the
  // sibling span whose ns is the current ns with its trailing
  // "|name:uuid" segment stripped. LC's parent_run_id is ignored.
  private runIdByNs = new Map<string, string>();
  private actualParent = new Map<string, string | null>();

  constructor() {
    super();
  }

  // ---- Start hooks: every Start allocates a span, every End mutates it. ----
  handleChainStart(
    chain: Serialized,
    inputs: Record<string, unknown>,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) {
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
        llm_kwargs: redactLLMKwargs(serializedKwargs(llm)),
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
        llm_kwargs: redactLLMKwargs(serializedKwargs(llm)),
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
  // metric. LangChain core 1.2.x signature: handleLLMNewToken(token, runId).
  // Set on the first token; later tokens no-op.
  handleLLMNewToken(_token: string, ...rest: unknown[]) {
    const runId = rest.find((a) => typeof a === "string") as string | undefined;
    if (!runId) return;
    const s = this.spans.get(runId);
    if (s && s.meta.time_to_first_token_ms === undefined) {
      s.meta.time_to_first_token_ms = Date.now() - s.started_at;
    }
  }

  // ---- End hooks: mutate the in-flight span. ----
  handleChainEnd(outputs: Record<string, unknown>, runId: string) {
    this.end(runId, { output: deepUnwrapLC(outputs) });
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
      output: deepUnwrapLC(output),
      usage: usage ?? fallbackUsage ?? null,
    });
  }

  handleToolEnd(output: unknown, runId: string) {
    this.end(runId, { output: deepUnwrapLC(output) });
  }

  handleRetrieverEnd(documents: unknown, runId: string) {
    this.end(runId, { output: deepUnwrapLC(documents) });
  }

  // ---- Errors close the span as failed. ----
  handleChainError(err: Error, runId: string) {
    this.end(runId, { status: "failed", error: err.message });
  }

  handleLLMError(err: Error, runId: string) {
    this.end(runId, { status: "failed", error: err.message });
  }

  handleToolError(err: Error, runId: string) {
    this.end(runId, { status: "failed", error: err.message });
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
    const meta: CapturedSpan["meta"] = { ...partial.meta };
    meta.time_to_first_token_ms ??= null;
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
      status?: "failed";
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
    else if (s.status !== "failed") s.status = "completed";
  }

  /** Snapshot — finished spans plus any still-running. */
  snapshot(): CapturedSpan[] {
    return Array.from(this.spans.values()).map((s) => ({
      ...s,
      // ponytail: overwrite parent_span_id with the ns-derived one.
      // LC's parent_run_id is unreliable under USE_SUBGRAPH.
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

// ponytail: one helper, one place. Prompts are what the provider sees — keep
// them as the model sees them, don't down-cast to structured messages.
function stringifyMessages(msgs: BaseMessage[]): string {
  return msgs
    .map((m) => {
      // _getType is deprecated but still works on every version we ship;
      // getType() returns the same value via the modern public API.
      const role = (m as unknown as { getType: () => string }).getType();
      const content =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content, null, 0);
      return `${role}: ${content}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// ponytail: __demo__ runner lives in this same file. It is the smallest thing
// that imports the real graph, attaches the handler, and dumps a JSON file
// under /tmp so we can inspect real callback payloads. Delete when §10 lands.
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const { graph } = await import("@/backend/agent");
    const handler = new CapturingHandler();
    const threadId = `demo-${Date.now()}`;
    const prompt = process.argv[2] ?? "What is the weather in Tokyo?";
    // ponytail: abort after 30s so an interrupt pause (waiting for human
    // resume) doesn't hang the demo. Generous default for the natural-flow
    // runs; bump if a real prompt needs more.
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 30_000);
    console.log(`[demo] thread=${threadId}  prompt=${JSON.stringify(prompt)}`);
    try {
      await graph.invoke(
        { messages: [{ role: "user", content: prompt }] },
        { configurable: { thread_id: threadId }, callbacks: [handler], signal: ac.signal },
      );
    } catch (e) {
      const isInterrupt = (e as { name?: string })?.name === "GraphInterrupt";
      console.error(
        `[demo] invoke ended (${isInterrupt ? "INTERRUPT" : "ERR"}):`,
        e instanceof Error ? e.message : e,
      );
    } finally {
      clearTimeout(timeout);
    }
    // ponytail: aborted invokes leave Start-only spans with ended_at: null.
    // Mark them failed so the panel doesn't render them as "running" forever —
    // SpanResource uses null-ended spans to extend timeRange.max to Date.now().
    handler.markRunningAsFailed();
    const spans = handler.snapshot();
    const { writeFileSync } = await import("node:fs");
    // ponytail: pick output path by USE_SUBGRAPH so the side-by-side preview
    // page can load both runs without one overwriting the other. Allow a
    // 3rd CLI arg to override (useful when benchmarking custom prompts).
    const subgraphOn = process.env.USE_SUBGRAPH === "true" || process.env.USE_SUBGRAPH === "1";
    const outPath =
      process.argv[3] ??
      (subgraphOn ? "/tmp/captured-spans-subgraph.json" : "/tmp/captured-spans-inlined.json");
    writeFileSync(outPath, JSON.stringify(spans, null, 2));
    console.log(`[demo] ${spans.length} spans → ${outPath}`);
    for (const s of spans) {
      const dur = s.ended_at ? s.ended_at - s.started_at : "RUN";
      const usage = s.usage ? `tokens=${JSON.stringify(s.usage)}` : "";
      const node = s.meta?.langgraph_node ? `  @${s.meta.langgraph_node}` : "";
      console.log(
        `  [${s.kind.padEnd(7)}] ${s.status.padEnd(9)} ${dur === "RUN" ? "RUN" : `${dur}ms`} ${s.name}${node} ${usage}`,
      );
    }
  })();
}
