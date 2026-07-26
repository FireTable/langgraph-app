# Agent Evaluation & A/B Testing Platform (`docs/EVALUATION.md`)

Architecture and operational guidelines for the built-in **Agent Evaluation & A/B Testing Platform** in `langgraph-app`.

---

## 🎯 Architectural Overview

The Agent Evaluation Platform provides prompt versioning, sticky A/B traffic splitting, turn-level execution tracking, online user feedback (👍 / 👎), and LLM-as-a-Judge assessment.

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

The evaluation system manages 7 dedicated PostgreSQL tables:

1. **`prompt_template`**: System Prompt definitions and revision history.
2. **`prompt_variant`**: A/B variants with configurable traffic weights (0–100%).
3. **`prompt_variant_assignment`**: Sticky variant assignment per `(userId, agent)`.
4. **`eval_run`**: Turn execution record with latency (`totalMs`), token usage, and `parentMessageId` (connecting directly to `observability_spans`).
5. **`eval_feedback`**: User/Admin feedback (`rating`: 1 to 5 integer; 👍 maps to 5, 👎 maps to 1).
6. **`eval_rubric`**: Per-agent criteria rules for AI Judge evaluation (keyed directly by `id = "rubric_${agentId}"`).
7. **`eval_benchmark`**: Admin-defined offline benchmark test cases per agent (`id`, `agent`, `title`, `input_prompt`, `expected_output`).
8. **`eval_judgment`**: Assessment scores and reasoning emitted by `evalAgent`, with `judge_thread_id` tracking AI Judge execution traces.

---

## 🔀 A/B Testing & Sticky Traffic Splitting

- **Sticky Assignment**: When a user invokes `chatAgent`, `prepareDataNode` checks `prompt_variant_assignment`. If an assignment exists for `(userId, "chatAgent")`, the user stays on their assigned variant.
- **Weighted Splitting**: If unassigned, a variant is chosen via weighted random selection according to `trafficWeight` (configured in Admin console).
- **Fallback**: If DB is unavailable, system prompts fall back seamlessly to static constants in `backend/prompt/system.ts`.

---

## 🧪 Per-Agent Benchmark Studio & English Initial Prompts

The system seeds 100% English initial system prompts, domain-tailored Rubric Criteria, and Benchmark Test Datasets for all 10 Agent Nodes upon `db:migrate`:

- **Domain Rubrics**:
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

- **Unified Table UI**:
  - **Rubric Criteria**: Rendered as a clean `<table className="table-fixed">` with fixed column widths (`220px` KEY, `100px` WEIGHT, `auto` Description).
  - **Sub-Tabs**: `Online Executions` (with `Activity` icon, default 1st position) and `Benchmark Datasets` (with `FlaskConical` icon) unified using the exact same `<table className="table-fixed">` structure, providing row-level evaluation triggers (`Run Judge` / `Run Evaluate`), trace links, and vertical middle alignment (`align-middle`).

---

## ⚖️ LLM-as-a-Judge (`evalAgent`) & Tracing

The system registers an independent evaluation agent graph in `langgraph.json`:

- **Graph Name**: `"evalAgent": "./backend/agent/eval-agent.ts:graph"`
- **Provider Binding**: Uses `getEvalModelFromDB()` (falling back to `"chat"` pool if `"eval"` pool has no registered models).
- **Output Validation**: Emits structured JSON matching agent-specific rubric criteria with detailed reasoning.
- **Trace Linking**: Executes under thread `eval-judge-${runId}`, recording `judge_thread_id` to allow 1-click Observability trace inspection directly from the UI.

---

## 🌐 API Routes (`/api/eval/*`)

All evaluation API endpoints are wrapped with `withAuth` and run on `runtime = "nodejs"`:

- **`POST /api/eval/feedback`**: Submits user or admin rating (`rating: 1..5`, `source: "user_online"` | `"admin_manual"`).
- **`GET /api/eval/prompts`**: Returns active prompt templates and variants.
- **`POST /api/eval/prompts`**: Admin actions to create templates/variants or update traffic split weights.
- **`GET /api/eval/runs/compare`**: Aggregates A/B performance stats (run counts, latencies, ratings) for the Admin Dashboard (`/admin/eval`).
- **`GET / POST / DELETE /api/eval/benchmarks`**: Manages per-agent Benchmark Test Datasets and Rubric Criteria updates.
