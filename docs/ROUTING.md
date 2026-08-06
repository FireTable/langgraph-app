# Intent Recognition & Tiered Router System (`ROUTING.md`)

## Architecture Overview

The routing node (`routerAgentNode`) in the LangGraph architecture utilizes a three-tier cascade routing design (Tiered Routing Cascade) to minimize response latency and LLM Token expenditure while maintaining high classification precision.

```
                       +-------------------------------+
                       |      Incoming User Message    |
                       +---------------+---------------+
                                       |
                                       v
                       +-------------------------------+
                       | Tier 1: Rule Short-Circuit    |
                       | hasUnprocessedFile?           |
                       +---------------+---------------+
                                       |
                              +--------+--------+
                              |                 |
                           (Yes)               (No)
                              |                 |
                              v                 v
                   +-------------------+   +-------------------------------+
                   | Route: kbAgent    |   | Tier 2: Keyword Short-Circuit |
                   | source: "rule"    |   | matchKeywordRoute()           |
                   +-------------------+   +---------------+---------------+
                                                           |
                                                  +--------+--------+
                                                  |                 |
                                               (Match)           (Miss)
                                                  |                 |
                                                  v                 v
                                       +-------------------+   +-------------------------------+
                                       | Target Agent      |   | Tier 3: LLM Fallback Classifier|
                                       | source: "keyword" |   | withStructuredOutput          |
                                       +-------------------+   +---------------+---------------+
                                                                               |
                                                                               v
                                                                   +-------------------+
                                                                   | Target Agent      |
                                                                   | source: "llm"     |
                                                                   +-------------------+
```

---

## Tiered Routing Layers

### Tier 1: Rule Short-Circuit (`source: "rule"`)

- **Trigger**: Evaluates if the current conversation history contains any unprocessed file/document upload (`hasUnprocessedFile`).
- **Target Agent**: `kbAgent`
- **Latency**: `< 1ms` (Zero I/O, Zero LLM overhead)

### Tier 2: Priority Keyword Short-Circuit (`source: "keyword"`)

- **Trigger**: Evaluates the trailing user message against priority-ordered keyword and regex rule groups via `lib/router/keywords.ts`.
- **Priority Groups**:
  1. `codeAgent`: Matches Markdown code blocks (` ```ts `), code writing/refactoring phrases, runtime stack traces, and data format conversions (JSON -> CSV).
  2. `cryptoAgent`: Matches unambiguous tickers (`BTC`, `ETH`, `USDT`, `SOL`), cryptocurrency terms, and wallet/swap intent.
  3. `weatherAgent`: Matches meteorological terms (`weather`, `forecast`, `celsius`, `air quality`, `AQI`).
- **Target Agents**: `codeAgent` | `cryptoAgent` | `weatherAgent`
- **Metadata**: Includes `source: "keyword"` and the exact matched rule string (`matchedKey`).
- **Latency**: `< 1ms`

### Tier 3: LLM Structured Output Fallback (`source: "llm"`)

- **Trigger**: Triggered when both Tier 1 and Tier 2 short-circuits pass without a match.
- **Mechanism**: Invokes LLM with `withStructuredOutput(InvokeRouteDecisionSchema)` for deep semantic intent classification.
- **Target Agents**: `weatherAgent` | `cryptoAgent` | `codeAgent` | `chatAgent` (default fallback)
- **Latency**: `200ms - 1s`

---

## Routing Decision Schema (`RouterDecision`)

```typescript
export const RouteDecisionSchema = z.object({
  next: z.enum(["weatherAgent", "chatAgent", "cryptoAgent", "codeAgent", "kbAgent"]),
  source: z.enum(["rule", "keyword", "llm"]).optional(),
  matchedKey: z.string().optional(),
});
```

---

## Source Files

- **Routing Node**: [`backend/node/router-agent-node.ts`](file:///Users/FireTable/OpenClaw/Code/langgraph-app/backend/node/router-agent-node.ts)
- **Keyword Matching Engine**: [`lib/router/keywords.ts`](file:///Users/FireTable/OpenClaw/Code/langgraph-app/lib/router/keywords.ts)
- **Documentation**: [`docs/ROUTING.md`](file:///Users/FireTable/OpenClaw/Code/langgraph-app/docs/ROUTING.md)
- **Unit Tests**:
  - [`tests/lib/router/keywords.test.ts`](file:///Users/FireTable/OpenClaw/Code/langgraph-app/tests/lib/router/keywords.test.ts)
  - [`tests/backend/node/router-agent-node.test.ts`](file:///Users/FireTable/OpenClaw/Code/langgraph-app/tests/backend/node/router-agent-node.test.ts)
