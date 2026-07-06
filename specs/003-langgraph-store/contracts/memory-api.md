# Contract: Memory API Endpoints

**Branch**: `feat/003-langgraph-store` | **Date**: 2026-07-02 | **Spec**: [spec.md § FR-013..FR-016](./spec.md) | **Data Model**: [data-model.md](./data-model.md)

## 概述

4 个 `withAuth` 端点,前端 Memory tab 调用于拉取 / 删除。全部在 `app/api/memory/` 下。`rule #9` 强制 withAuth。`rule #1` 同步 `docs/APIS.md`。

| Method   | Path                            | 操作                                      | 返回                                                     |
| -------- | ------------------------------- | ----------------------------------------- | -------------------------------------------------------- |
| `GET`    | `/api/memory/profile`           | 读 profile + session + socialAccounts     | `{ profile, session, socialAccounts }`                   |
| `DELETE` | `/api/memory/profile/:key`      | 删 profile 单字段(走 patch remove)        | `{ ok: true, deletedKey: string }`                       |
| `GET`    | `/api/memory/threads`           | 读所有 thread summaries(按 threadId 分组) | `{ threads: Array<{ threadId, summaries: Summary[] }> }` |
| `DELETE` | `/api/memory/threads/:threadId` | 删整 thread 所有 sequence                 | `{ ok: true, deletedCount: number }`                     |

---

## 通用前置

### Auth

所有 4 个 handler 必须包 `withAuth`(rule #9):

```ts
import { withAuth } from "@/lib/auth/with-auth";

export const GET = withAuth(async (_req, { user }) => {
  // user.id is the authenticated userId
  // ...
});
```

### Runtime

**不要** `export const runtime = "edge"` —— `withAuth` 需要 `drizzle/postgres-js`,edge 抛 `Failed to get session`(rule #9 备注)。留默认 `nodejs`。

### Response Shape

```ts
type ApiOk<T> = { ok: true; data: T };
// Or 简化形态(本 spec 不引 wrapper):
type ProfileResponse = {
  profile: ProfileDoc;
  session: SessionContext;
  socialAccounts: SocialAccount[];
};
type ProfileDeleteResponse = { ok: true; deletedKey: string };
type ThreadsResponse = { threads: ThreadSummaryGroup[] };
type ThreadsDeleteResponse = { ok: true; deletedCount: number };
```

错误统一走 HTTP status + JSON `{ error: string }`(rule #9 风格)。

---

## Endpoint 1: `GET /api/memory/profile`

**Handler**: `app/api/memory/profile/route.ts`

### Request

- Method: `GET`
- Path: `/api/memory/profile`
- Query / Body: 无
- Auth: `withAuth`

### Response 200

```ts
{
  profile: Record<string, unknown>; // 从 [userId, "profile"] main 读
  session: {
    name: string | null;
    email: string | null;
    image: string | null;
  }
  socialAccounts: Array<{ provider: string }>; // 从 account 表 SELECT providerId as provider
}
```

### 错误

| Status | 触发                              |
| ------ | --------------------------------- |
| 401    | `withAuth` 内部 → 未登录(rule #9) |
| 500    | store / drizzle 查询异常          |

### 实现位置

- `app/api/memory/profile/route.ts` —— handler
- `lib/memory/queries.ts` —— `getProfileDoc(userId)` + `getSocialAccounts(userId)` 封装
- `lib/memory/validators.ts` —— `ProfileResponseSchema`(zod,测试用)

### Zod 响应 schema(`lib/memory/validators.ts`)

```ts
export const ProfileResponseSchema = z.object({
  profile: z.record(z.string(), z.unknown()),
  session: SessionContextSchema,
  socialAccounts: z.array(z.object({ provider: z.string().min(1) })),
});
```

---

## Endpoint 2: `DELETE /api/memory/profile/:key`

**Handler**: `app/api/memory/profile/[key]/route.ts`

### Request

- Method: `DELETE`
- Path param: `:key` —— profile 字段名(URL 编码)
- Auth: `withAuth<{ key: string }>`

### Response 200

```ts
{
  ok: true;
  deletedKey: string;
}
```

### 错误

| Status | 触发                                              |
| ------ | ------------------------------------------------- |
| 401    | 未登录                                            |
| 404    | profile doc 不存在 / 该 key 不在 profile 内       |
| 400    | `:key` 不在 path regex 范围内(防止 `..` / 空 key) |
| 500    | store 异常                                        |

### 行为

1. `key = decodeURIComponent(params.key)`
2. 校验:`key` 匹配 `^[A-Za-z0-9_-]+$`(同 `save_memory` tool 的 path segment 规则)
3. `current = await store.get([userId, "profile"], "main")`
4. 若 `!current || !(key in current.value)` → return 404
5. `next = structuredClone(current.value); delete next[key];`
6. `await store.put([userId, "profile"], "main", next)`
7. `return { ok: true, deletedKey: key }`

### Zod 响应 schema

```ts
export const ProfileDeleteResponseSchema = z.object({
  ok: z.literal(true),
  deletedKey: z.string(),
});
```

### 实现位置

- `app/api/memory/profile/[key]/route.ts` —— handler
- `lib/memory/queries.ts` —— `deleteProfileField(userId, key)`

---

## Endpoint 3: `GET /api/memory/threads`

**Handler**: `app/api/memory/threads/route.ts`

### Request

- Method: `GET`
- Path: `/api/memory/threads`
- Query / Body: 无
- Auth: `withAuth`

### Response 200

```ts
{
  threads: Array<{
    threadId: string;
    summaries: Array<{
      sequence: number;
      name: string;
      description: string;
      startMessageIndex: number;
      endMessageIndex: number;
      messageCount: number;
      updatedAt: string; // ISO 8601
    }>;
  }>;
}
```

### 排序

- **thread 之间**:按 `summaries[0].updatedAt` desc(最近更新的 thread 排前)
- **summaries 之间**:按 `sequence` desc(最新摘要排前)

### 错误

| Status | 触发       |
| ------ | ---------- |
| 401    | 未登录     |
| 500    | store 异常 |

### 行为

```
1. items = await store.search([userId, "threads"], { limit: 1000 })  // 单用户总上限
2. parsed = items
     .map(toSummaryDoc)                                            // zod parse
     .filter(s => s !== null)                                      // 跳过损坏 doc
3. grouped = groupBy(parsed, s => s.threadId)
4. for each group:
     sort by sequence desc
     pick latest updatedAt
5. sort groups by latest updatedAt desc
6. return { threads: Array.from(grouped.values()).map(g => ({ threadId: g.threadId, summaries: g.summaries })) }
```

### Zod 响应 schema

```ts
export const SummaryEntrySchema = z.object({
  sequence: z.number().int().min(1),
  name: z.string(),
  description: z.string(),
  startMessageIndex: z.number().int().min(0),
  endMessageIndex: z.number().int(),
  messageCount: z.number().int().min(1),
  updatedAt: z.string().datetime(),
});

export const ThreadSummaryGroupSchema = z.object({
  threadId: z.string(),
  summaries: z.array(SummaryEntrySchema),
});

export const ThreadsResponseSchema = z.object({
  threads: z.array(ThreadSummaryGroupSchema),
});
```

---

## Endpoint 4: `DELETE /api/memory/threads/:threadId`

**Handler**: `app/api/memory/threads/[threadId]/route.ts`

### Request

- Method: `DELETE`
- Path param: `:threadId`
- Auth: `withAuth<{ threadId: string }>`

### Response 200

```ts
{
  ok: true;
  deletedCount: number;
}
```

### 错误

| Status | 触发                                      |
| ------ | ----------------------------------------- |
| 401    | 未登录                                    |
| 404    | 该 threadId 下没有 summaries(无 doc 可删) |
| 500    | store 异常                                |

### 行为

1. `threadId = params.threadId`
2. `items = await store.search([userId, "threads"], { limit: 1000 })`
3. `keysToDelete = items.filter(i => i.key.startsWith(`${threadId}:`)).map(i => i.key)`
4. 若 `keysToDelete.length === 0` → return 404
5. `await store.batch(keysToDelete.map(key => ({ namespace: [userId, "threads"], key, op: "delete" })))`
6. `return { ok: true, deletedCount: keysToDelete.length }`

### Zod 响应 schema

```ts
export const ThreadsDeleteResponseSchema = z.object({
  ok: z.literal(true),
  deletedCount: z.number().int().min(1),
});
```

---

## 测试矩阵(落在 `tests/api/memory/*.test.ts`)

每 endpoint 必须覆盖:`200` happy path + 每个 error status code(rule #2)。

| Endpoint                               | 200 | 401 | 404 | 400 | 500 |
| -------------------------------------- | --- | --- | --- | --- | --- |
| `GET /api/memory/profile`              | ✓   | ✓   |     |     | ✓   |
| `DELETE /api/memory/profile/:key`      | ✓   | ✓   | ✓   | ✓   | ✓   |
| `GET /api/memory/threads`              | ✓   | ✓   |     |     | ✓   |
| `DELETE /api/memory/threads/:threadId` | ✓   | ✓   | ✓   |     | ✓   |

401 mock pattern(rule #9 测试样板):

```ts
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/config", () => ({ auth: { api: { getSession } } }));

beforeEach(() => {
  getSession.mockReset();
  getSession.mockResolvedValue({ user: { id: "u1" }, session: { id: "s1", userId: "u1" } });
});
```

## 文档同步

实现落地后必须在 `docs/APIS.md` 加新章节(rule #1):

```
## Memory

### GET /api/memory/profile
...

### DELETE /api/memory/profile/:key
...

### GET /api/memory/threads
...

### DELETE /api/memory/threads/:threadId
...
```

PR 描述里要 link 这个 doc 改动。

## Open Questions

None。
