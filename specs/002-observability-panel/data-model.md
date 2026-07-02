# Data Model: Observability Spans

**Phase**: 1
**Created**: 2026-07-01

## Entities

### 1. ObservabilitySpanRow

DB 表 `observability_spans` 的一行。

**定义位置**: `lib/observability/schema.ts`(Drizzle table)

**列定义**:

| 列               | 类型        | 约束                                                              | 说明                                          |
| ---------------- | ----------- | ----------------------------------------------------------------- | --------------------------------------------- |
| `span_id`        | text        | PRIMARY KEY                                                       | LangChain `runId`(UUID)                       |
| `thread_id`      | text        | NOT NULL, REFERENCES `threads(id)` ON DELETE CASCADE              | thread 关联,删 thread 自动清 spans            |
| `parent_span_id` | text        | NULL                                                              | backend 从 `langgraph_checkpoint_ns` 推导     |
| `name`           | text        | NOT NULL                                                          | callback name(类名尾段或工具名)               |
| `kind`           | text        | NOT NULL, CHECK ∈ {llm, tool, chain, retriever, unknown}          | callback 入口决定                             |
| `status`         | text        | NOT NULL, CHECK ∈ {running, completed, failed}, DEFAULT 'running' | 状态机三态                                    |
| `started_at`     | bigint      | NOT NULL                                                          | Date.now() at start,epoch ms                  |
| `ended_at`       | bigint      | NULL                                                              | Date.now() at end;interrupt 时为 NULL         |
| `input`          | jsonb       | NULL                                                              | unwrap 后的入参,见 spec                       |
| `output`         | jsonb       | NULL                                                              | unwrap 后的出参                               |
| `usage`          | jsonb       | NULL                                                              | LLM token 用量                                |
| `error`          | text        | NULL                                                              | 错误信息                                      |
| `meta`           | jsonb       | NOT NULL                                                          | LangChain metadata passthrough + 写入时间戳等 |
| `created_at`     | timestamptz | NOT NULL, DEFAULT now()                                           | retention 用                                  |

**索引**:

```sql
CREATE INDEX observability_spans_thread_started_idx ON observability_spans (thread_id, started_at);
CREATE INDEX observability_spans_created_idx ON observability_spans (created_at);
```

- `(thread_id, started_at)` — GET 接口主查询路径
- `(created_at)` — retention cron 全表扫描

**外键约束**:

```sql
ALTER TABLE observability_spans
  ADD CONSTRAINT observability_spans_thread_id_fkey
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE;
```

**写入语义**:

| 时机                             | 操作                                                                    | 原因                                                     |
| -------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| `handleChainStart`               | 标 in-memory `spans.set(runId, partial)`                                | 不立即写 DB,start 路径过多会爆                           |
| `handleChainEnd`                 | `bulkInsert(spansForRun)`                                               | 一次 invoke 末尾批量写入,时机跟 `renameThreadAgent` 一致 |
| `handleLLM/Chat/Tool/Start`      | 标 in-memory                                                            | 同上                                                     |
| `handleLLM/Chat/Tool/End`        | 标 in-memory                                                            | 同上                                                     |
| `markRunningAsFailed(thread_id)` | `UPDATE ... SET status='failed' WHERE thread_id=? AND status='running'` | GET 前兜底                                               |
| DELETE API                       | `DELETE FROM observability_spans WHERE thread_id=?`                     | 用户显式清空                                             |

**验证规则**(Drizzle schema 内):

```ts
status: text("status", { enum: ["running", "completed", "failed"] }).notNull().default("running"),
kind: text("kind", { enum: ["llm", "tool", "chain", "retriever", "unknown"] }).notNull(),
```

**敏感字段防御**(FR-009):

`insertSpan` 在写入前 `JSON.stringify(span)` 后 grep 敏感模式:

```ts
const FORBIDDEN =
  /(?:api[_-]?key|_password|^password$|_secret$|^secret$|baseURL|organization|bearer\s+[a-z0-9])/i;
if (FORBIDDEN.test(JSON.stringify(span))) {
  throw new Error(`observability: forbidden sensitive field in span ${span.span_id}`);
}
```

### 2. 关系

```
threads (1) ──< (N) observability_spans
  ON DELETE CASCADE
```

删 thread → 自动删 spans,无需 DELETE observability API 调用方关心。

## 状态转换

### Span status

```
              Start
               │
               ▼
           ┌────────┐
           │running │
           └───┬────┘
               │
       ┌───────┼───────┐
       │       │       │
       ▼       ▼       ▼
  completed failed (interrupt + markRunningAsFailed)
```

- `running` 是初始态(`handleChainStart` 等)
- `completed` 是 happy path(`handleChainEnd` 等)
- `failed` 是错误态(`handleXxxError` 或 GET 时 `markRunningAsFailed`)

### Thread lifecycle 对 spans 的影响

```
thread create ───► 新 invoke ───► handleChainStart ──► handleChainEnd ──► bulkInsert
                                                          │
                                                          └─► thread.lastMessageAt 更新

thread archive ─► spans 不变(archived 只是 status='archived',row 还在)

thread delete  ─► ON DELETE CASCADE 自动删 spans
```

## Query contract

`lib/observability/queries.ts` 暴露的函数:

```ts
// 内部 helper — buffer 满时调用
export async function bulkInsertSpans(spans: CapturedSpan[]): Promise<void>;

// 公开 API
export async function getSpansByThreadId(threadId: string): Promise<CapturedSpan[]>;
export async function markRunningAsFailed(threadId: string): Promise<void>;
export async function deleteSpansByThreadId(threadId: string): Promise<number>;
```

## 假设

- 单次 invoke 产生的 spans 数 ≤ 200(LLM 100 token + 工具 5 + chain 5 ≈ 110)
- 单 span payload ≤ 50KB(input/output 可能含 message history)
- retention 周期由 `OBSERVABILITY_RETENTION_DAYS` 配置,默认 30 天;retention cron 每天跑一次(可调到每小时)
- ON DELETE CASCADE 在 Postgres 9.x+ 默认启用,无需额外配置
