# Agent Evaluation & A/B Testing Platform (`docs/EVALUATION.md`)

Architecture and operational guidelines for the built-in **Agent Evaluation & A/B Testing Platform** in `langgraph-app`.

---

## 🎯 Architectural Overview

The Agent Evaluation Platform provides prompt versioning, sticky A/B traffic splitting, turn-level execution tracking, online user feedback (👍 / 👎), per-agent Benchmark Datasets, and LLM-as-a-Judge assessment.

```
                  ┌─────────────────────────────────┐
                  │      User Conversation Turn     │
                  └────────────────┬────────────────┘
                                   │
                   ┌───────────────▼───────────────┐
                   │  prepareDataNode (A/B Split)   │
                   └───────────────┬───────────────┘
                                   │
                   ┌───────────────▼───────────────┐
                   │     chatAgent / subAgent      │
                   └───────────────┬───────────────┘
                                   │
                   ┌───────────────▼───────────────┐
                   │ EvalCallbackHandler (End Hook)│
                   └───────────────┬───────────────┘
                                   │
                     ┌─────────────┴─────────────┐
                     │                           │
          ┌──────────▼──────────┐     ┌──────────▼──────────┐
          │  eval_run Table     │     │ observability_spans │
          └──────────┬──────────┘     └─────────────────────┘
                     │ (JOIN parent_message_id)
        ┌────────────┴────────────┐
        │                         │
┌───────▼─────────┐      ┌────────▼────────┐
│ Online Feedback │      │   evalAgent     │
│ (1-5 Rating 👍👎)│      │(LLM-as-a-Judge) │
└─────────────────┘      └────────┬────────┘
                                  │
                         ┌────────▼────────┐
                         │  eval_judgment  │
                         └─────────────────┘
```

---

## 📊 Database Schema (`lib/eval/schema.ts`)

The evaluation system manages 8 dedicated PostgreSQL tables:

1. **`prompt_template`**: System Prompt definitions and revision history.
2. **`prompt_variant`**: A/B variants with configurable traffic weights (0–100%).
3. **`prompt_variant_assignment`**: Sticky variant assignment per `(userId, agent)`.
4. **`eval_run`**: Turn execution record with latency (`totalMs`), token usage, and `parentMessageId` (connecting directly to `observability_spans`).
5. **`eval_feedback`**: User/Admin feedback (`rating`: 1 to 5 integer; 👍 maps to 5, 👎 maps to 1). Silently no-ops when no `eval_run` row matches the submitted `runId` (see `lib/eval/queries.ts:submitFeedback`) — the chat thumbs-up button must never FK-violate on a missing run.
6. **`eval_rubric`**: Per-agent criteria rules for AI Judge evaluation. The `id` is keyed as `rubric_${agentId}` for agent-specific rubrics; `rubric_default` is the generic fallback used by both `backend/agent/eval-agent.ts:judgeByLLMNode` and `app/api/eval/judge/route.ts` when no agent-specific rubric exists.
7. **`eval_benchmark`**: Admin-defined offline benchmark test cases per agent (`id`, `agent`, `title`, `input_prompt`, `expected_output`). Denormalized `latest_judgment_id` / `latest_run_at` / `latest_run_status` / `latest_score` let the Benchmark Datasets table render "Last Result" inline without joining `eval_run` + `eval_judgment` per render.
8. **`eval_judgment`**: Assessment scores and reasoning emitted by `evalAgent`, with `judge_thread_id` tracking AI Judge execution traces.

---

## 🔀 A/B Testing & Sticky Traffic Splitting

- **Sticky Assignment**: When a user invokes `chatAgent`, `prepareDataNode` checks `prompt_variant_assignment`. If an assignment exists for `(userId, "chatAgent")`, the user stays on their assigned variant.
- **Weighted Splitting**: If unassigned, a variant is chosen via weighted random selection according to `trafficWeight` (configured in Admin console).
- **Fallback**: If DB is unavailable, system prompts fall back seamlessly to static constants in `backend/prompt/system.ts`.

---

## 🧪 Per-Agent Benchmark Studio & English Initial Prompts

The system seeds 100% English initial system prompts, domain-tailored Rubric Criteria, and Benchmark Test Datasets for all 11 Agent Nodes on first migration:

- **Agent IDs (DB canonical)** — match the LangGraph node names so Online Executions can resolve `meta.langgraph_node` directly:
  - `chatAgent`, `routerAgent`, `weatherAgent`, `cryptoAgent`, `codeAgent`
  - `pageToMarkdown` (KB OCR), `chunkExtract` (KB entity extraction), `chunkAlignment` (KB entity alignment)
  - `renameThreadAgent`, `threadSummarizeAgent`
  - `judgeByLLM` (the LLM-as-a-Judge scorer itself — its Rubric evaluates the quality of the judge's output)

- **Domain Rubrics**:
  - `rubric_default`: `relevance`, `accuracy` — generic fallback used when no `rubric_${agentId}` exists.
  - `chatAgent`: `relevance`, `accuracy`
  - `routerAgent`: `intent_precision`, `routing_efficiency`
  - `weatherAgent`: `location_extraction`, `forecast_completeness`
  - `cryptoAgent`: `market_data_accuracy`, `financial_disclaimer`
  - `codeAgent`: `syntax_correctness`, `logic_clarity`
  - `chunkExtract`: `entity_completeness`, `relationship_precision`
  - `pageToMarkdown`: `text_extraction_fidelity`, `layout_preservation`
  - `chunkAlignment`: `alias_resolution`, `deduplication_accuracy`
  - `renameThreadAgent`: `title_conciseness`, `semantic_relevance`
  - `threadSummarizeAgent`: `information_density`, `context_continuity`
  - `judgeByLLM`: `criteria_alignment`, `reasoning_clarity`, `calibration`

- **Unified Table UI**:
  - **Rubric Criteria**: Rendered as a clean `<table className="table-fixed">` with fixed column widths (`220px` KEY, `100px` WEIGHT, `auto` Description).
  - **Sub-Tabs**: `Online Executions` (with `Activity` icon, default 1st position) and `Benchmark Datasets` (with `FlaskConical` icon) unified using the exact same `<table className="table-fixed">` structure, providing row-level evaluation triggers (`Run Judge` / `Run Evaluate`), trace links, and vertical middle alignment (`align-middle`).

---

## ⚖️ LLM-as-a-Judge (`evalAgent`) & Tracing

The system registers an independent evaluation agent graph in `langgraph.json`:

- **Graph Name**: `"evalAgent": "./backend/agent/eval-agent.ts:graph"`
- **Provider Binding**: Uses `getEvalModelFromDB()` (falling back to `"chat"` pool if `"eval"` pool has no registered models).
- **Output Validation**: Emits structured JSON matching agent-specific rubric criteria with detailed reasoning.
- **Trace Linking**: Executes under thread `eval-judge-${runId}` (kind `eval-judge`), recording `judge_thread_id` to allow 1-click Observability trace inspection directly from the UI.

The benchmark mode of the same graph records an `eval_run` under a synthetic thread (kind `eval-benchmark`) — see `backend/agent/eval-agent.ts:recordEvalRunNode`. The two `kind` values are split so Online Executions surfaces real judge scoring work while keeping synthetic benchmark activity on the Benchmark Datasets surface only.

---

## 🧵 Thread `kind` Enum Semantics (`lib/threads/schema.ts`)

The `threads.kind` column discriminates thread purpose. Evaluations split the legacy single `eval` value into two so Online Executions can show judge work without leaking benchmark noise:

- `chat` — user conversation turns (sidebar visible).
- `kb` — standalone `kbAgent` ingestion runs (uploads, reprocess).
- `eval-judge` — LLM-as-a-Judge scoring runs (Run Judge / Re-evaluate). Surfaces in Online Executions.
- `eval-benchmark` — synthetic benchmark runs (Run Evaluate). Hidden from Online Executions.

Both `lib/eval/queries.ts:getRunsByAgentPage` and `app/api/eval/runs/compare/route.ts` apply the same `kind != 'eval-benchmark'` filter so the frontend never has to second-guess.

---

## 🌐 API Routes (`/api/eval/*`)

All evaluation API endpoints are wrapped with `withAuth` and run on `runtime = "nodejs"`:

- **`POST /api/eval/feedback`**: Submits user or admin rating (`rating: 1..5`, `source: "user_online"` | `"admin_manual"`). The chat UI sends the assistant message id (`resp_...`); the route resolves it via `eval_run.parent_message_id`. No match → silent no-op (200, 0 rows) — see `lib/eval/queries.ts:submitFeedback`.
- **`GET /api/eval/prompts`**: Returns active prompt templates and variants (ordered by `id`).
- **`POST /api/eval/prompts`**: Admin actions — `create_template` / `create_cohort_variant` / `delete_cohort_variant` / `create_variant` / `update_variant_weight` / `batch_update_weights`.
- **`PUT /api/eval/prompts`**: Updates a `prompt_template`'s content / notes (admin only — system templates can't be deleted).
- **`DELETE /api/eval/prompts`**: Deletes an admin-authored `prompt_template` (system templates with `userId = null` are 403).
- **`GET /api/eval/rubrics`**: Returns all rubrics + recent judgments joined to their `eval_run.agent` / `variant_id`.
- **`POST /api/eval/rubrics`**: Inserts or updates a rubric by `id` (default `rubric_${Date.now()}`), criteria shape `{ key, description, weight }`.
- **`GET /api/eval/benchmarks`**: Returns all benchmarks with their latest judgment denormalized onto each row.
- **`POST /api/eval/benchmarks`**: Admin actions — `create` / `delete` / `update_rubric`.
- **`POST /api/eval/benchmarks/run`**: Triggers `Run Evaluate` for one benchmark; dispatches `evalAgent` in benchmark mode (kind `eval-benchmark`).
- **`POST /api/eval/judge`**: Triggers `Run Judge` for an existing `eval_run`; dispatches `evalAgent` in judge mode (kind `eval-judge`).
- **`GET /api/eval/runs/compare`**: Aggregates A/B performance stats (run counts, latencies, ratings) for the Admin Dashboard. Excludes `kind = 'eval-benchmark'`.
- **`GET /api/eval/runs/page`**: Per-agent paginated Online Executions (`?agent=`, `?cursor=`, `?limit=` — clamped to 50). Excludes `kind = 'eval-benchmark'`.
- **`GET /api/eval/runs/[id]`**: Single run detail + feedback + judgment + first 20 observability spans.
- **`GET /api/eval/assignments`**: Sticky `prompt_variant_assignment` rows joined to user + variant + template.
- **`POST /api/eval/assignments`**: Cohort-level variant reassignment (`cohortLabel` walks every agent) or single agent reassignment (`agent` + `targetVariantId`).
