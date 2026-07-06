# Contract: Store Namespaces & Keys

**Branch**: `feat/003-langgraph-store` | **Date**: 2026-07-02 | **Spec**: [spec.md § FR-021..FR-022](./spec.md) | **Data Model**: [data-model.md](./data-model.md)

## 概述

`PostgresStore` 提供层级 namespace(`string[]`)+ 单层 key(`string`)的 KV 模型。本 spec 锁定两个 namespace 和它们的 key 格式,作为所有读 / 写操作的契约。

## Namespace 总览

| Namespace 数组        | Key 字符串             | Value 类型                              | Owner 写者             |
| --------------------- | ---------------------- | --------------------------------------- | ---------------------- |
| `[userId, "profile"]` | `"main"`(固定)         | `Record<string, unknown>`(扁平 k-v)     | `save_memory` tool     |
| `[userId, "threads"]` | `"${threadId}:${seq}"` | `SummaryDoc`(见 data-model.md Entity 2) | `threadSummarize` node |

### 关键不变量

- **所有 namespace 第一段必须是 `userId`**(FR-021)——无全局 namespace,无跨用户读
- **`threads` key 通过 `:` 分隔 `threadId` 和 `sequence`**,使 `key.startsWith("${threadId}:")` 一次扫描能枚举该 thread 所有 sequence
- **`profile` 单文档**(`key="main"` 固定),无 history(Out of Scope)

---

## Namespace 1: `[userId, "profile"]`

### 完整 namespace 形态

```
[userId, "profile"]      // 例如: ["u_abc123", "profile"]
```

### Key

固定为 `"main"`。**禁止**用其它 key 写其他文档(单文档设计)。

### Value

`Record<string, unknown>`,JSON-compatible,UTF-8 序列化后 ≤ `MEMORY_PROFILE_MAX_BYTES`(默认 8192)。

### 读操作(`lib/memory/queries.ts: getProfileDoc`)

```ts
const item = await store.get([userId, "profile"], "main");
return item?.value ?? {};
```

### 写操作(`lib/memory/queries.ts: putProfileDoc`)

```ts
await store.put([userId, "profile"], "main", value);
```

### 删单字段(`lib/memory/queries.ts: deleteProfileField`)

```ts
// 不删整文档(那会清空所有字段,这是错的)
// 取整文档 → delete 一个 key → put 回去
const current = await store.get([userId, "profile"], "main");
if (!current || !(key in current.value)) return null;
const next = { ...current.value };
delete next[key];
await store.put([userId, "profile"], "main", next);
```

### 跨用户防护

`getProfileDoc(userId)` 接收的 `userId` 来自 `config.configurable.userId`(proxy 注入,`research.md` D-006)。**不**接 query param 传入的 userId —— API handler 必须从 `withAuth({ user })` 取 `user.id`,不信任 client 传值。

---

## Namespace 2: `[userId, "threads"]`

### 完整 namespace 形态

```
[userId, "threads"]      // 例如: ["u_abc123", "threads"]
```

### Key

`${threadId}:${sequence}`,例:

- `thread-xyz789:1`
- `thread-xyz789:2`
- `thread-abc123:1`

其中:

- `threadId` —— 来源于 LangGraph thread ID(由 frontend 创建时生成,`lib/threads/` 模块负责)。在 key 内不重新编码字符(假设 threadId 不含 `:` —— 验证:LangGraph SDK 生成的 threadId 是 UUID-like,无冒号)。
- `sequence` —— thread 内序号,`1, 2, 3, ...`,单调递增。下一个 sequence = `(已有的最大 sequence) + 1`。

### Value: `SummaryDoc`

见 [data-model.md § Entity 2](./data-model.md)。关键字段:`threadId`, `sequence`, `name`, `description`, `startMessageIndex`, `endMessageIndex`, `messageCount`, `updatedAt`。

### 读操作

#### 单 thread 全部 summaries(`lib/memory/queries.ts: getThreadSummaries`)

```ts
const items = await store.search([userId, "threads"], { limit: 1000 });
const filtered = items.filter((i) => i.key.startsWith(`${threadId}:`));
return filtered
  .map((i) => SummaryDocSchema.safeParse(i.value))
  .filter((r) => r.success)
  .map((r) => r.data);
```

#### 该 user 全部 summaries(`lib/memory/queries.ts: getAllUserSummaries`,被 threads API + recall middleware 共用)

```ts
const items = await store.search([userId, "threads"], { limit: 1000 });
return items
  .map((i) => SummaryDocSchema.safeParse({ ...i.value, key: i.key }))
  .filter((r) => r.success)
  .map((r) => r.data);
```

### Recall: 取最近 top-K(`lib/memory/queries.ts: getRecentThreadSummaries`)

```ts
const all = await getAllUserSummaries(userId);
return all
  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  .slice(0, MEMORY_THREAD_RECALL_LIMIT);
```

排序依据 `updatedAt` desc(`research.md` D-003)。

### 写单 summary(`threadSummarize` node)

```ts
const allForThread = await getThreadSummaries(userId, threadId);
const nextSeq = (allForThread[0]?.sequence ?? 0) + 1;
await store.put([userId, "threads"], `${threadId}:${nextSeq}`, {
  threadId,
  sequence: nextSeq,
  name,
  description,
  startMessageIndex,
  endMessageIndex,
  messageCount,
  updatedAt: new Date().toISOString(),
});
```

### 删整 thread 全部 sequence(`DELETE /api/memory/threads/:threadId`)

```ts
const all = await store.search([userId, "threads"], { limit: 1000 });
const keys = all.filter((i) => i.key.startsWith(`${threadId}:`)).map((i) => i.key);
if (keys.length === 0) return 0;
await store.batch(keys.map((key) => ({ namespace: [userId, "threads"], key, op: "delete" })));
return keys.length;
```

注:`store.batch` 是 `BaseStore` 抽象提供的 batch operation(`research.md` D-003 已确认 API),M 个 delete 在单次 round-trip 完成。

---

## Namespace 隔离保证

| 场景                                     | 防护                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| 用户 A 通过 API 查用户 B 的 profile      | `userId` 来自 `withAuth({ user })`,不是 client 传入,handler 不接受其它 userId |
| middleware 误注入别的 userId             | proxy 是唯一注入点(`research.md` D-006),且从 auth session 取 user.id          |
| 跨用户 `[otherUserId, "profile"]` 读取   | 无任何代码路径构造其它 userId 的 namespace —— 跨用户 = 不可达                 |
| store.search 返回别人的 thread summaries | 搜索 prefix 是 `[userId, "threads"]`,userId 是当前 session 的,跨用户隔离      |

## 测试覆盖

`tests/backend/memory/queries.test.ts` 覆盖:

- profile get / put / delete field
- threads get all / get single thread / delete thread / write summary
- 跨 user 防护:用 userId="u1" 写,userId="u2" 读 → 0 命中(若 mock store 不隔离,直接断言 query 用的 namespace 数组)

## Open Questions

None。
