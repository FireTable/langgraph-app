# API Contract: Observability Captures

**Phase**: 1
**Created**: 2026-07-01

## Endpoints

### GET /api/threads/[id]/observability

获取一个 thread 的所有 captures。

**鉴权**: `withAuth<IdParams>`(rule #9)。

**路径参数**:

| 名称 | 类型   | 说明                             |
| ---- | ------ | -------------------------------- |
| `id` | string | thread_id(也是 path 中的 `[id]`) |

**所有权校验**: route handler 内部先 `getThreadForUser(id, user.id)`:

- 返回 `undefined` → 404(不区分 thread 不存在 / 越权)
- 返回 thread → 调 `getSpansByThreadId(id)`

**请求**:

```http
GET /api/threads/abc-123/observability HTTP/1.1
Cookie: better-auth.session_token=...
```

**响应 200**:

```json
{
  "thread_id": "abc-123",
  "retention_days": 30,
  "spans": [
    {
      "span_id": "uuid-1",
      "parent_span_id": null,
      "name": "graph.invoke",
      "kind": "chain",
      "status": "completed",
      "started_at": 1719840000000,
      "ended_at": 1719840005000,
      "input": { "...": "..." },
      "output": { "...": "..." },
      "usage": null,
      "error": null,
      "meta": {
        "langgraph_node": "agent",
        "langgraph_step": 1,
        "langgraph_checkpoint_ns": "abc-123",
        "ls_model_name": "gpt-5-mini-2025-08-07",
        "ls_model_type": "chat",
        "ls_provider": "openai",
        "thread_id": "abc-123"
      }
    }
  ]
}
```

**响应 401**(未登录):

```json
{ "error": "Unauthorized" }
```

**响应 404**(thread 不存在 OR 越权 — 不可区分):

```json
{ "error": "Not Found" }
```

**响应 500**(DB 异常):

```json
{ "error": "Internal Server Error" }
```

**副作用**: 调用前 `markRunningAsFailed(thread_id)` 把 `running` 状态的所有 spans 标为 `failed`,确保客户端拿到的全是终态。

**`retention_days` 字段**: 当前服务配置的 `OBSERVABILITY_RETENTION_DAYS` 值(默认 30),供 UI 顶部 banner 展示「保留 X 天,超过 X 天的数据将在下次 retention 清理时删除」。

### DELETE /api/threads/[id]/observability

清空一个 thread 的所有 spans。

**鉴权**: 同 GET。

**请求**:

```http
DELETE /api/threads/abc-123/observability HTTP/1.1
Cookie: better-auth.session_token=...
```

**响应 200**:

```json
{ "cleared": 42 }
```

**响应 401 / 404**: 同 GET。

## 数据结构

### CapturedSpan(传输格式)

来自 `backend/observability/callback-collector.ts` 的 `CapturedSpan` 类型,字段对齐 spec Key Entities。

### Validators

定义在 `lib/observability/validators.ts`:

```ts
import { z } from "zod";

export const CapturedSpanSchema = z.object({
  span_id: z.string(),
  parent_span_id: z.string().nullable(),
  name: z.string(),
  kind: z.enum(["llm", "tool", "chain", "retriever", "unknown"]),
  status: z.enum(["running", "completed", "failed"]),
  started_at: z.number().int().nonnegative(),
  ended_at: z.number().int().nonnegative().nullable(),
  input: z.unknown().nullable(),
  output: z.unknown().nullable(),
  usage: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
});

export const GetSpansResponseSchema = z.object({
  thread_id: z.string(),
  retention_days: z.number().int().positive(),
  spans: z.array(CapturedSpanSchema),
});

export const DeleteSpansResponseSchema = z.object({
  cleared: z.number().int().nonnegative(),
});

export const IdParamsSchema = z.object({ id: z.string().min(1) });
```

## 错误响应约定

| HTTP | 触发                  | 响应体                                 |
| ---- | --------------------- | -------------------------------------- |
| 200  | 成功                  | endpoint-specific                      |
| 401  | 未登录                | `{ "error": "Unauthorized" }`          |
| 404  | thread 不存在 OR 越权 | `{ "error": "Not Found" }`             |
| 500  | DB 异常 / 写入失败    | `{ "error": "Internal Server Error" }` |

不暴露:

- thread 是否存在(避免 enumeration)
- 详细错误信息(避免 DB schema 泄漏)

## CORS

由 `withAuth` 处理;observability 端点不需要跨域(同源调用)。

## 测试覆盖

`tests/api/threads/observability.test.ts` 必须覆盖:

| 场景                                        | 期望                            |
| ------------------------------------------- | ------------------------------- |
| GET + 有效 session + 自己的 thread 有 spans | 200 + spans 数组                |
| GET + 无 session                            | 401                             |
| GET + 其他用户的 thread                     | 404(不暴露存在性)               |
| GET + 不存在的 thread                       | 404                             |
| GET + thread 有 running span                | 200 + 该 span.status = "failed" |
| DELETE + 有效 session + 自己的 thread       | 200 + cleared = N               |
| DELETE + 无 session                         | 401                             |
| DELETE + 其他用户的 thread                  | 404                             |

覆盖率目标: 100%(rule #2)。
