# Feature Specification: LangGraph Long-Term Memory

**Feature Branch**: `feat/003-langgraph-store`

**Created**: 2026-07-02

**Status**: Completed (refactored)

**Input**: User requirement: "对接 store, 各种长期记忆" — wire LangGraph `PostgresStore` for cross-thread long-term memory (per-user profile + thread summaries), exposed through a single JSON-Patch tool, a `withMemoryRecall` middleware, and a thread-summarize node; visible/deletable via a Memory tab in settings.

## Clarifications

### Session 2026-07-02

- Q: 长期记忆底层叫什么? → A: **memory**(不是"知识库"——store 是 per-user 状态,不是 RAG 静态语料)
- Q: 短期 vs 长期怎么分工? → A: 短期(checkpointer)管 thread 内消息持久化;长期(store)管跨 thread 的用户状态 + 历史摘要
- Q: 跨 thread 续聊 vs thread 内压缩? → A: MVP **都做**——前者跨 thread 摘要(用户换 thread 后能回忆),后者用 state 字段而非 store(避免给 state 加压力)。但触发都通过 threadSummarize node,store 保留为未来切换更灵活
- Q: 主动回忆 vs 等用户问? → A: **主动**——`withMemoryRecall` middleware 自动 prepend,模型不靠 tool call 触发
- Q: 写错 memory 谁负责? → A: **用户从 settings 删**,不准编辑。模型不会"重说一遍再学"
- Q: 隐私 / consent? → A: **不做 consent 开关**——永远记录;用户只能删除单条
- Q: profile + facts 合并还是分表? → A: **合并**为 `[userId,"profile"]` 单文档(扁平 k-v JSON),JSON Patch 写。preferences 是子字段,不独立 namespace
- Q: thread summary 怎么存? → A: 跨 thread 用 store `[userId,"threads"]`;每个 chunk 一条 doc,key=`${threadId}:${sequence}`,value 包含 sequence / name / description / 区间索引
- Q: memoryRecall 怎么注入所有 agent? → A: **包 chatModel**(middleware 模式,跟现有 `CapturingHandler` 一致),所有 model node 自动受益
- Q: profile 是否混合 better-auth session 信息? → A: **合并**——session.name / email / image 每次 recall 取最新;social accounts(provider 类型)实时查 account 表;store 只存用户陈述的事实
- Q: better-auth-ui settings 页怎么用? → A: 已有 `settingsTabs` 插件机制,加 "Memory" tab,不重建 settings 页

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 跨 thread 续聊 (Priority: P1)

作为 end user,我跟 chat 聊过我的项目和偏好,关掉 thread 第二天开新 thread,新 thread 的 agent 已经记得我之前说过什么(项目背景、我是前端、不喜欢冗长回复),不需要我重新说一遍。

**Why this priority**: 这是整个 memory 功能的"为什么存在"——没有跨 thread 续聊,memory 价值归零。其余故事都建立在这之上。

**Independent Test**: 登录后开 thread A,聊"我在做一个 LangGraph demo,我是前端,以后回答别太长";关 A 开 thread B,问"我上次说我在做什么项目"。B 的回复应该提到 LangGraph demo、前端、简短风格偏好。

**Acceptance Scenarios**:

1. **Given** 用户在 thread A 说"我是前端工程师", **When** user message 触发 `save_memory` 写入 `[/userId/profile]`, **Then** store 中存在 `{"role": "frontend"}` 字段,且 thread B 的 `memoryRecall` 能读到
2. **Given** thread B 的 `memoryRecall` 触发, **When** middleware 读取 profile + session 信息 + threads top-K, **Then** 这些上下文以 system message 注入 chatModel.invoke,LLM 在生成回复时已"知道"用户背景
3. **Given** 用户改口说"其实我是后端", **When** 模型 emit JSON Patch `[{op:"replace",path:"/role",value:"backend"}]`, **Then** store 中 `role` 被覆盖,其他字段(如 `wallet`)保留

---

### User Story 2 - Thread 长到压缩上下文 (Priority: P1)

作为 end user,我跟同一个 thread 聊了 20+ 轮,继续聊时 agent 不会因为 token 超限崩掉,而且早先聊过的话题(被摘要压缩的)仍然能在后续对话中被回忆起来。

**Why this priority**: 上下文窗口耗尽 = thread 实际死掉。这是 P1 因为单 thread 寿命直接影响可用性。

**Independent Test**: 单 thread 聊到 user msg 数 > `MEMORY_THREAD_SUMMARY_THRESHOLD`(默认 10),观察 store `[userId,"threads"]` 出现 summary doc;再聊到 > 阈值 + 增量,出现第二条摘要 doc;后续 turn 的 model 调用不超出 token 上限。

**Acceptance Scenarios**:

1. **Given** thread 的 user message 计数 > THRESHOLD, **When** `threadSummarize` node 在 afterAgent 后运行, **Then** store 出现 key=`${threadId}:1` 的 summary doc,含 `sequence=1`、`name`、`description`、`startMessageIndex`、`endMessageIndex`
2. **Given** thread 已有一条 summary,user msg 再增长, **When** 新一轮触发 `threadSummarize`, **Then** 新 doc key=`${threadId}:2`,`sequence=2`,`startMessageIndex` 接续上一条的 `endMessageIndex+1`
3. **Given** summary 区间计算, **When** `endIdx <= startIdx`(新消息不够), **Then** 跳过本轮摘要,不写入 store
4. **Given** summary 区间计算, **When** 取 `[startIdx, endIdx]` 的 messages, **Then** 包含 user + assistant 两种消息(不止 user),保证摘要连贯

---

### User Story 3 - 用户在 settings 看见并删除 memory (Priority: P2)

作为 end user,我打开 settings 页面看到一个 "Memory" tab,能列出 agent 当前记得我的所有事(身份、偏好、wallet、最近 thread 摘要),每条带删除按钮,我点删除后该条立即消失,后续对话 agent 不再引用。

**Why this priority**: 没有 visibility = 黑盒,用户不知道 agent 在记什么;无法控制 = 不信任 → 不用 memory。P2 而非 P1 是因为首次使用 memory 不需要这个也能跑通,但留存需要。

**Independent Test**: 登录后通过 user menu 进 `/settings/memory`,看到 profile 区块的 k-v 列表(包含 session 自动填充的 name/email/social providers + user-stated facts)和 threads 区块的 threadId 列表;点删除按钮,行消失;再开新 thread 问"我叫什么",agent 不再引用被删的字段。

**Acceptance Scenarios**:

1. **Given** 用户登录后进 `/settings/memory`, **When** 页面加载, **Then** 看到两个区块:Profile(从 store `[userId,"profile"]` main 读 + session 实时字段) / Thread Summaries(从 store `[userId,"threads"]` 按 threadId 分组)
2. **Given** 用户点 profile 行删除按钮, **When** DELETE `/api/memory/profile/:key` 返回 200, **Then** 该行从 UI 消失;新 thread 的 `memoryRecall` 不再包含该字段
3. **Given** 用户点 thread summary 行删除按钮, **When** DELETE `/api/memory/threads/:threadId` 返回 200, **Then** 该 threadId 下所有 sequence 的 summary doc 全部删除;UI 该 thread 区块折叠消失
4. **Given** 未登录用户访问 `/settings/memory`, **When** better-auth-ui 渲染, **Then** 重定向到 sign-in(由 better-auth-ui 的 `Authenticated` gate 处理,不在本 spec)

---

### User Story 4 - profile 自动包含 better-auth session + social (Priority: P2)

作为 end user,我用 GitHub 登录后,agent 不需要我额外说明就知道我叫 XXX、邮箱是 YYY、绑定了 GitHub 账号;这些信息在我改名后立即反映在新对话中,不需要用户手动改 memory。

**Why this priority**: 体验加成,但不是 memory 核心价值。如果不做,用户也能用 P1/P2 完成大部分需求。P2。

**Independent Test**: 用 GitHub 登录(本地 dev 可注入 social account),开 thread 问"我绑了哪些 social 账号"。Agent 回复提到 "github"。改名后开新 thread 问"我叫什么",新名生效。

**Acceptance Scenarios**:

1. **Given** 用户登录后 `memoryRecall` 触发, **When** middleware 调 `auth.api.getSession`, **Then** `session.user.name` / `email` / `image` 被加入 memory context
2. **Given** 用户绑定了 GitHub social account, **When** middleware 查 better-auth `account` 表, **Then** memory context 含 `socialAccounts: [{ provider: "github" }]`(**不含** `providerId`,避免敏感 ID 泄漏)
3. **Given** 用户改名(改 GitHub display name), **When** 新 thread 触发 recall, **Then** memory context 中的 `name` 已是新值(不读 store,直接从 session 取)

---

## Functional Requirements

### Memory write surface

- **FR-001** The agent MUST expose a single `save_memory(patches: JSONPatch[])` tool that accepts RFC 6902 patch operations against the user's profile doc (`[userId, "profile"]` key="main").
- **FR-002** The tool MUST support `add` / `replace` / `remove` operations; `remove` is the only deletion path — there is no separate `forget_memory` tool.
- **FR-003** The tool MUST reject writes that would cause the serialized profile doc to exceed `MEMORY_PROFILE_MAX_BYTES` (default 8192), returning a clear error so the model can retry with a smaller patch.
- **FR-004** The tool MUST be wired into `ALL_TOOLS` so it's reachable from `chatModelNode` (and any future model node that uses `ALL_TOOLS`).

### Memory recall surface

- **FR-005** A `withMemoryRecall` middleware MUST wrap `chatModel`.
- **FR-006** On each `invoke`, the middleware MUST: read `[userId, "profile"] main`, fetch `auth.api.getSession`, query better-auth `account` table for `socialAccounts`, search `[userId, "threads"]` with `limit: MEMORY_THREAD_RECALL_LIMIT` ordered by recency.
- **FR-007** If `config.configurable.userId` is absent (e.g., internal invoke during `langgraphjs dev` startup), the middleware MUST pass through unchanged — no system message injected.
- **FR-008** The merged context MUST be prepended as a single system message in the form `<memory>{...}</memory>` so the model can distinguish recalled memory from operational system prompt.

### Thread summary surface

- **FR-009** A `threadSummarize` node MUST run after `afterAgent`, gated on `userMessageCount > MEMORY_THREAD_SUMMARY_THRESHOLD` (default 10).
- **FR-010** The node MUST compute `startIdx = (latestSummary?.endMessageIndex ?? -1) + 1` and `endIdx = userMessageCount - MEMORY_THREAD_SUMMARY_KEEP_RECENT` (default 4); skip when `endIdx <= startIdx`. **Index semantics (closed interval)**:
  - `startIdx` is **inclusive** — the first user-message index included in the summary window.
  - `endIdx` is **inclusive** — the last user-message index included in the summary window.
  - The summary window is the **closed integer range** `[startIdx, endIdx]`, i.e. **every integer `i` with `startIdx ≤ i ≤ endIdx`**.
  - Therefore `messageCount = endIdx - startIdx + 1` (NOT `endIdx - startIdx`). Edge cases: `startIdx === endIdx` → 1 message summarized; `startIdx + 1 === endIdx` → 2 messages summarized; both are valid and the node MUST process them (the only skip condition is `endIdx < startIdx`, i.e. zero messages).
  - **Store the closed range as-is**: `startMessageIndex = startIdx`, `endMessageIndex = endIdx` (both inclusive — they ARE the actual last index of the window, not `endIdx - 1`). The off-by-one subtraction (`endIdx - 1`) is **NOT** applied anywhere in storage.
- **FR-011** The node MUST call a lightweight LLM (`chatModel` is fine) with the message range to produce `{ name, description }`, then `store.put([userId, "threads"], ${threadId}:${sequence}, { threadId, sequence, name, description, startMessageIndex, endMessageIndex, messageCount, updatedAt })`. `startMessageIndex === startIdx` and `endMessageIndex === endIdx` (both inclusive, see FR-010). `messageCount === endMessageIndex - startMessageIndex + 1`.
- **FR-012** Summary content MUST include both user and assistant messages in the closed range `[startIdx, endIdx]` (not just user), to preserve conversational context. The slice operation is `messages.filter(isHuman | isAI).slice(startIdx, endIdx + 1)` (note `endIdx + 1` because JS `Array.slice` end is exclusive).

### API surface

- **FR-013** `GET /api/memory/profile` — returns `{ profile: Record<string, unknown>, session: { name, email, image }, socialAccounts: Array<{ provider: string }> }`. Wrapped in `withAuth`.
- **FR-014** `DELETE /api/memory/profile/:key` — removes a single field from the profile doc (apply a `remove` patch). 404 if key not present. Wrapped in `withAuth`. `:key` MUST match `^[A-Za-z0-9_-]{1,64}$` — non-conforming keys (empty string, `..`, array indices, percent-encoded slashes) MUST return 400.
- **FR-015** `GET /api/memory/threads` — returns `{ threads: Array<{ threadId: string, summaries: Summary[] }> }`, grouped by threadId, ordered by `updatedAt` desc within group. Wrapped in `withAuth`.
- **FR-016** `DELETE /api/memory/threads/:threadId` — deletes ALL summary docs whose key starts with `${threadId}:` for the current user. 404 if threadId has no summaries. Wrapped in `withAuth`.

### Settings UI surface

- **FR-017** A "Memory" tab MUST be added to the better-auth-ui settings page via `settingsTabs` plugin, with view id `"memory"`.
- **FR-018** The tab MUST render two sections: Profile rows (k-v, deletable) and Thread Summaries (per-threadId group, each summary line deletable individually OR whole-thread delete per FR-016).
- **FR-019** Profile rows MUST show session fields (name, email, image, social providers) with a "(from account)" hint AND store fields with "(saved by you)" hint — visually distinct so user knows what's editable vs read-only.
- **FR-020** Session-derived fields (name, email, image, socialAccounts) MUST be marked non-deletable in the UI (no delete button). Only store fields have delete.

### Isolation & namespace

- **FR-021** All namespaces MUST begin with `[userId, ...]`. No global namespace. No cross-user reads.
- **FR-022** Cross-thread search (`memoryRecall` thread top-K) MUST filter by the calling user's `userId` — explicit, not implicit.

### userId-missing behavior (fail-fast vs pass-through)

- **FR-023** The `save_memory` tool MUST **fail-fast** and return a clear, structured error when `config.configurable.userId` is absent — it MUST NOT silently no-op, return success, or write to any default / global namespace. Rationale: a tool invocation is an explicit user action (the model is acting on the user's behalf to persist facts). A missing `userId` would otherwise write to the wrong user's profile or to a global namespace, corrupting memory and leaking data across users. Hard failure surfaces the misconfiguration to the model so it can surface it to the user.

  > **Asymmetry with FR-007.** FR-007 lets `withMemoryRecall` middleware **pass through unchanged** when `userId` is missing. This is intentional and consistent with FR-023:
  >
  > - Middleware pass-through is safe: a missing recall is a **degraded mode** — the model just answers without memory context, the user sees nothing wrong, and the next call (with `userId` properly injected) catches up.
  > - Tool hard-fail is required: a missing `userId` on a **write** is **never safe** — silently writing to a default user would corrupt state, and silently no-opping would confuse the model (it thinks it saved the fact and references it later).
  >
  > Decision recorded as `plan.md` D-009.

## Non-Functional Requirements

- **NFR-001** `withMemoryRecall` middleware MUST add < 50ms p95 latency to chatModel.invoke at the p50 user profile size (< 1KB).
- **NFR-002** Store writes MUST be idempotent — re-running `save_memory` with the same patch MUST produce the same end state.
- **NFR-003** Profile size guard MUST run before the store write, not after (fail-fast, no half-written state).
- **NFR-004** All env vars MUST be read at module load, not per-call, to avoid hot-reload thrash.
- **NFR-005** API endpoints MUST follow rule #9 (`withAuth` wrapper) and rule #1 (documented in `docs/APIS.md`).
- **NFR-006** Backend logic MUST follow rule #2 (TDD): every tool / middleware / node / API handler gets a failing test first.

## Key Entities

- **Profile doc** — `Record<string, unknown>`. Flat k-v. No enforced schema. Keys are arbitrary strings chosen by the model (e.g., `role`, `language`, `wallet_address`, `current_project`).
- **Summary doc** — `{ threadId, sequence, name, description, startMessageIndex, endMessageIndex, messageCount, updatedAt }`. See `data-model.md`.
- **Session context** — `{ name, email, image }` from better-auth `user` table.
- **Social accounts** — `Array<{ provider: string }>` from better-auth `account` table (provider only, no `providerId`).

## Environment Variables

| Var                                 | Default | Purpose                                       |
| ----------------------------------- | ------- | --------------------------------------------- |
| `MEMORY_THREAD_SUMMARY_THRESHOLD`   | 10      | user msg count to trigger threadSummarize     |
| `MEMORY_THREAD_SUMMARY_KEEP_RECENT` | 4       | recent user msgs to keep raw (not summarized) |
| `MEMORY_PROFILE_MAX_BYTES`          | 8192    | profile doc serialized size cap               |
| `MEMORY_THREAD_RECALL_LIMIT`        | 3       | threads top-K for memoryRecall                |

## Out of Scope (MVP)

- **Cross-thread memory in user prompt** beyond thread summaries — no auto-extraction of user facts from arbitrary text
- **Memory TTL / expiration** — no auto-cleanup of stale profile fields
- **Memory import / export** — no JSON dump of user's memory
- **Memory version history** — `save_memory` overwrites without audit trail
- **Memory sharing** — no shared namespaces across users (per FR-021)
- **Semantic search** — profile is loaded whole, not searched by embedding (per design decision: structured k-v doesn't benefit from semantic search)
- **Memory in non-chat agents** — code / weather / crypto agents receive profile + threads via the middleware automatically; if any agent needs to be excluded, that's a follow-up

## Open Questions

None — all decisions in Clarifications section.
