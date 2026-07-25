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

The evaluation system manages 6 dedicated PostgreSQL tables:

1. **`prompt_template`**: System Prompt definitions and revision history.
2. **`prompt_variant`**: A/B variants with configurable traffic weights (0–100%).
3. **`prompt_variant_assignment`**: Sticky variant assignment per `(userId, agent)`.
4. **`eval_run`**: Turn execution record with latency (`totalMs`), token usage, and `parentMessageId` (connecting directly to `observability_spans`).
5. **`eval_feedback`**: User/Admin feedback (`rating`: 1 to 5 integer; 👍 maps to 5, 👎 maps to 1).
6. **`eval_rubric`**: Criteria rules for AI Judge evaluation.
7. **`eval_judgment`**: Assessment scores and reasoning emitted by `evalAgent`.

---

## 🔀 A/B Testing & Sticky Traffic Splitting

- **Sticky Assignment**: When a user invokes `chatAgent`, `prepareDataNode` checks `prompt_variant_assignment`. If an assignment exists for `(userId, "chatAgent")`, the user stays on their assigned variant.
- **Weighted Splitting**: If unassigned, a variant is chosen via weighted random selection according to `trafficWeight` (configured in Admin console).
- **Fallback**: If DB is unavailable, system prompts fall back seamlessly to static constants in `backend/prompt/system.ts`.

---

## ⚖️ LLM-as-a-Judge (`evalAgent`)

The system registers an independent evaluation agent graph in `langgraph.json`:

- **Graph Name**: `"evalAgent": "./backend/agent/eval-agent.ts:graph"`
- **Provider Binding**: Uses `getEvalModelFromDB()` (falling back to `"chat"` pool if `"eval"` pool has no registered models).
- **Output Validation**: Emits structured JSON matching `relevance` (1-5) and `accuracy` (1-5) scores with detailed reasoning.

---

## 🌐 API Routes (`/api/eval/*`)

All evaluation API endpoints are wrapped with `withAuth` and run on `runtime = "nodejs"`:

- **`POST /api/eval/feedback`**: Submits user or admin rating (`rating: 1..5`, `source: "user_online"` | `"admin_manual"`).
- **`GET /api/eval/prompts`**: Returns active prompt templates and variants.
- **`POST /api/eval/prompts`**: Admin actions to create templates/variants or update traffic split weights.
- **`GET /api/eval/runs/compare`**: Aggregates A/B performance stats (run counts, latencies, ratings) for the Admin Dashboard (`/admin/eval`).
