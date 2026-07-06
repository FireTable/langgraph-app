# Data Model: LangGraph Long-Term Memory

**Branch**: `feat/003-langgraph-store` | **Date**: 2026-07-02 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## 实体概览

| 实体                | 存储后端                                                     | Owner                   | 读路径                                                  | 写路径                                |
| ------------------- | ------------------------------------------------------------ | ----------------------- | ------------------------------------------------------- | ------------------------------------- |
| **Profile doc**     | PostgresStore `[userId, "profile"]` key=`main`               | `lib/memory/queries.ts` | withMemoryRecall middleware / `GET /api/memory/profile` | `save_memory` tool(append JSON Patch) |
| **Summary doc**     | PostgresStore `[userId, "threads"]` key=`${threadId}:${seq}` | 同上                    | withMemoryRecall middleware / `GET /api/memory/threads` | `threadSummarize` node(LLM 生成)      |
| **Session context** | better-auth session cookie                                   | `lib/auth/`             | withMemoryRecall middleware / API response              | better-auth(登录 / 改名 / 邮箱改时)   |
| **Social accounts** | better-auth `account` 表                                     | `lib/auth/schema.ts`    | withMemoryRecall middleware / API response              | better-auth(绑 / 解绑 provider 时)    |

四类实体之间通过 `userId` 关联,**不**通过外键(用户态 store 是 PostgresStore 自己的 table,better-auth 是 drizzle 表)。

---

## Entity 1: Profile Doc

### 字段

`Record<string, unknown>` —— 扁平 k-v JSON,无 schema 约束。

| Key(任意字符串)   | Value 示例                  | 来源     |
| ----------------- | --------------------------- | -------- |
| `role`            | `"frontend"` / `"backend"`  | 模型写入 |
| `language`        | `"zh"` / `"en"`             | 模型写入 |
| `wallet_address`  | `"0x1234...abcd"`(用户陈述) | 模型写入 |
| `current_project` | `"langgraph-demo"`          | 模型写入 |
| `prefers_brief`   | `true`(布尔)                | 模型写入 |
| ... 任意其他 key  | 任意 JSON-compatible value  | 模型写入 |

### 不存的字段(由 session / socialAccounts 实时注入,不在 profile doc 内)

- `name` / `email` / `image`(从 `auth.api.getSession` 取)
- `socialAccounts`(从 `account` 表取)

### 校验规则

| 规则                                                                                 | 来源                           |
| ------------------------------------------------------------------------------------ | ------------------------------ |
| `Buffer.byteLength(JSON.stringify(profile)) <= MEMORY_PROFILE_MAX_BYTES` (默认 8192) | FR-003 / NFR-003               |
| key 是 string,长度 1..64                                                             | profile doc 软约束(zod refine) |
| value 是 JSON-compatible(`!== undefined`,可序列化)                                   | RFC 6902 隐含                  |

### Zod Schema(草图,落到 `lib/memory/validators.ts`)

```ts
export const ProfileDocSchema = z.record(z.string().min(1).max(64), z.unknown());
// ProfileDoc = z.infer<typeof ProfileDocSchema>;
```

### 状态转换

```
getProfile(userId) → StoreItem | null
  ↓
apply(profile, patches)               // fast-json-patch
  ↓
assertSize(after)                     // ≤ 8192 bytes
  ↓
store.put([userId, "profile"], "main", after)
```

`profile` 始终是单文档(无 history,无 version,FR spec Out of Scope)。

---

## Entity 2: Summary Doc

> **Closed-interval invariant (spec FR-010 / FR-012).** All index fields describe the **closed range `[startMessageIndex, endMessageIndex]` — both ends inclusive**. `messageCount = endMessageIndex - startMessageIndex + 1`. The window skips when `endMessageIndex < startMessageIndex` (zero messages). Off-by-one subtractions (`endIdx - 1`) are NEVER applied at storage time.

### 字段

| 字段                | 类型               | 说明                                                                                                                                       |
| ------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `threadId`          | `string`           | 摘要所属 thread ID。冗余(也可从 key 解析)但便于读端不解 key 直接用。                                                                       |
| `sequence`          | `number`           | thread 内序号(1, 2, 3 ...)。与 key 后缀对齐。                                                                                              |
| `name`              | `string`           | LLM 生成的一句话标题(如 "Onboarding preferences")。≤ 80 chars。                                                                            |
| `description`       | `string`           | LLM 生成的 1-2 句摘要,涵盖该区间聊了什么。                                                                                                 |
| `startMessageIndex` | `number`           | 区间起始 user message index(**inclusive**)。从 0 开始。等于 node 计算的 `startIdx`。                                                       |
| `endMessageIndex`   | `number`           | 区间结束 user message index(**inclusive**)。等于 node 计算的 `endIdx`,**不**做 `endIdx - 1` 减法。`endMessageIndex >= startMessageIndex`。 |
| `messageCount`      | `number`           | `endMessageIndex - startMessageIndex + 1`(闭区间长度)。区间内消息数(user + assistant)。                                                    |
| `updatedAt`         | `string`(ISO 8601) | 写 store 的时间戳。供 recall 排序用。                                                                                                      |

### Key 格式

`${threadId}:${sequence}`,例:`thread-abc123:1`、`thread-abc123:2`。

- `:` 分隔符让 `store.search` 通过 key prefix filter(`{ threadId: ... }`?不需要,因为整个 namespace 都是单用户的 thread summaries)实现 "删整 thread" 时 `delete([userId, "threads"], "${threadId}:1")` + `delete([userId, "threads"], "${threadId}:2")`,或用 `batch` 操作
- sequence 用整数,`Int.parseInt(key.split(":")[1])` 解析后排序

### 校验规则

| 规则                                                       | 来源                         |
| ---------------------------------------------------------- | ---------------------------- |
| `startMessageIndex >= 0`                                   | FR-010                       |
| `endMessageIndex >= startMessageIndex`                     | FR-010(闭区间两端 inclusive) |
| `messageCount === endMessageIndex - startMessageIndex + 1` | 闭区间长度,FR-010            |
| `sequence >= 1`                                            | key 格式                     |
| `updatedAt` 是有效 ISO 8601 字符串                         | 写时构造                     |

### Zod refine 例(closed-interval 一致性)

```ts
SummaryDocSchema.refine((s) => s.messageCount === s.endMessageIndex - s.startMessageIndex + 1, {
  message: "messageCount must equal endMessageIndex - startMessageIndex + 1 (closed interval)",
});
```

### Zod Schema(草图)

```ts
export const SummaryDocSchema = z
  .object({
    threadId: z.string().min(1),
    sequence: z.number().int().min(1),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    startMessageIndex: z.number().int().min(0),
    endMessageIndex: z.number().int(),
    messageCount: z.number().int().min(1),
    updatedAt: z.string().datetime(),
  })
  .refine(
    (s) => s.endMessageIndex >= s.startMessageIndex,
    "endMessageIndex must be >= startMessageIndex",
  );
```

### 状态转换

```
userMessageCount = state.messages.filter(isHuman).length
  ↓
latestSummary = searchSummaries(userId, threadId).sort(endMessageIndex desc)[0]
  ↓
startIdx = (latestSummary?.endMessageIndex ?? -1) + 1
endIdx = userMessageCount - KEEP_RECENT
  ↓
if endIdx < startIdx → skip                                    # 0 条消息才跳过;1 条也处理
  ↓
range = messages.filter(isHuman | isAI).slice(startIdx, endIdx + 1)   # slice 末位 exclusive → 闭区间用 endIdx + 1
  ↓
chatModel.invoke(summarizePrompt, structuredOutput({ name, description }))
  ↓
store.put([userId, "threads"], `${threadId}:${latestSeq + 1}`, {
  threadId, sequence: latestSeq + 1, name, description,
  startMessageIndex: startIdx,                                 # inclusive
  endMessageIndex:   endIdx,                                   # inclusive, 不做 -1
  messageCount:      endIdx - startIdx + 1,                    # 闭区间长度
  updatedAt:         new Date().toISOString()
})
```

---

## Entity 3: Session Context

### 字段

| 字段    | 类型             | 来源                               |
| ------- | ---------------- | ---------------------------------- |
| `name`  | `string \| null` | `auth.api.getSession().user.name`  |
| `email` | `string \| null` | `auth.api.getSession().user.email` |
| `image` | `string \| null` | `auth.api.getSession().user.image` |

### 校验规则

- 任何字段都可以是 `null`(用户名为空等)
- email 是 RFC 5322 简单校验(由 better-auth 强制)

### Zod Schema(草图)

```ts
export const SessionContextSchema = z.object({
  name: z.string().nullable(),
  email: z.string().email().nullable(),
  image: z.string().url().nullable(),
});
```

### 状态转换

无状态转换。Middleware 每次 invoke 调一次 `auth.api.getSession({ headers })`。

---

## Entity 4: Social Accounts

### 字段(API 响应形状,投影自 better-auth `account` 表)

| 字段       | 类型     | 来源                                           |
| ---------- | -------- | ---------------------------------------------- |
| `provider` | `string` | `account.providerId`(重命名映射,如 `"github"`) |

### 不暴露的字段(在 SELECT 中明确排除)

| 字段                    | reason                                  |
| ----------------------- | --------------------------------------- |
| `accountId`             | oauth 第三方 user id,泄漏会造成账户关联 |
| `accessToken`           | secret(观测 §9 敏感字段规则同款)        |
| `refreshToken`          | secret                                  |
| `idToken`               | secret                                  |
| `accessTokenExpiresAt`  | metadata,前端不需要                     |
| `refreshTokenExpiresAt` | metadata                                |
| `scope`                 | metadata                                |
| `password`              | secret(credential 表)                   |

### Zod Schema(草图)

```ts
export const SocialAccountSchema = z.object({
  provider: z.string().min(1),
});
export const SocialAccountsSchema = z.array(SocialAccountSchema);
```

### 状态转换

无状态转换。Middleware 每次 invoke 查一次 `drizzle: select providerId as provider from account where userId = ?`。

---

## Namespace × Key 总览

| Namespace             | Key                    | Value 类型                | 写并发模型                                   |
| --------------------- | ---------------------- | ------------------------- | -------------------------------------------- |
| `[userId, "profile"]` | `"main"`               | `Record<string, unknown>` | 单文档原子写,无锁                            |
| `[userId, "threads"]` | `"${threadId}:${seq}"` | `SummaryDoc`              | 跨 thread 无冲突;同 thread sequence 单调递增 |

并发不变量:

- profile 的多次并发 `save_memory` 由 `store.put` 全文档覆盖保证最终一致(last-write-wins);不存版本历史(Out of Scope)
- threads 同 thread sequence 由 `threadSummarize` 单 node 串行执行保证不重复

---

## 配置常量(`lib/memory/constants.ts`)

| 常量                                | 默认值 | 来源 env                            |
| ----------------------------------- | ------ | ----------------------------------- |
| `MEMORY_PROFILE_MAX_BYTES`          | 8192   | `MEMORY_PROFILE_MAX_BYTES`          |
| `MEMORY_THREAD_SUMMARY_THRESHOLD`   | 10     | `MEMORY_THREAD_SUMMARY_THRESHOLD`   |
| `MEMORY_THREAD_SUMMARY_KEEP_RECENT` | 4      | `MEMORY_THREAD_SUMMARY_KEEP_RECENT` |
| `MEMORY_THREAD_RECALL_LIMIT`        | 3      | `MEMORY_THREAD_RECALL_LIMIT`        |

所有常量 `as const` + `Number.parseInt(env, 10)` + fallback default,在 module load 时 read 一次(NFR-004)。

---

## Open Questions

None。
