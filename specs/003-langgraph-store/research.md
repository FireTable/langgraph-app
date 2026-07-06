# Phase 0 Research: LangGraph Long-Term Memory

**Branch**: `feat/003-langgraph-store` | **Date**: 2026-07-02

**Input**: Plan unknowns from `plan.md` § Phase 0 + 实际依赖审查。

## Decision Log

### D-001. JSON Patch 库选型

**Decision**: 使用 `fast-json-patch` 作为 RFC 6902 patch 的实现。

**Rationale**:

- 事实标准:NPM 下载量 1B+ 周,被 VS Code、webpack-toolkit、yarn 等大量项目使用
- 同步 API + 纯函数 `apply(document, patches, validateOperation, mutateDocument, banPrototypeModifications)`,无副作用
- 支持 `apply` 返回新对象 + mutate 模式,选用 mutate 模式配合 `JSON.parse(JSON.stringify(profile))` 浅拷贝避免污染上游
- `remove` op 在 path 不存在时返回 Patch application failed 而非静默 no-op,符合 FR-003 fail-fast 语义

**Alternatives considered**:

- `rfc6902`(slow,API 较老)— 拒绝
- 手写 patch engine — 拒绝(rule #3 标准方案)
- `immer` — 拒绝,语义是 immutable state 不是 RFC 6902

**Compatibility impact**: 新增 `fast-json-patch` 依赖。`package.json` dependencies 段加一行(`^3.1.1`),无 peer 冲突。

### D-002. chatModel middleware 实现路径

**Decision**: 用 `Runnable` 链式组合 + 自定义 `withMemoryRecall` 包装函数,**不**用 `dynamicSystemPromptMiddleware`(那是 assistant-ui 的概念,不在 LangGraph)。

**Rationale**:

- LangGraph 1.4.x 没有独立的 `withMiddleware` API。chatModel 是 `Runnable<BaseLanguageModelInput, AIMessage>`,标准注入点是 `RunnableSequence.from([transformer, model])` 或 `model.withConfig({ runnable: ... })`
- 包成 `RunnableLambda`:`(input) => prependMemory(input)` → 接在 chatModel 前面。实现为:
  ```ts
  const recallLambda = new RunnableLambda({
    func: async (input: BaseLanguageModelInput, options?: RunnableOptions) => {
      const userId = options?.config?.configurable?.userId;
      if (!userId) return input; // FR-007 透传
      const memory = await composeMemory(userId);
      return prependSystemMessage(input, memoryBlock(memory));
    },
  });
  export const chatModelWithRecall = recallLambda.pipe(chatModel);
  ```
- `chatModelNode` 改用 `chatModelWithRecall`(原 `chatModel` 仍导出,供 `renameThreadAgent` 用 — FR-005)

**Alternatives considered**:

- 自定义 node 包 chatModel — 拒绝,违反 FR-005(middleware 模式,且 spec 明确"不并入每 agent 一 node")
- `ChatOpenAI.bind({ tools: ... })` 旁路 — 拒绝,无法 prepend system message
- `StateGraph` 加 pre-router node — 拒绝,rename 任务也会被污染

### D-003. PostgresStore.search 行为与排序

**Decision**: `search` 返回 `SearchItem[]` 含 `key` / `value` / `created_at` / `updated_at` / `score`(lib API 已确认:BaseStore.search signature)。**默认按 namespace 内 key 顺序返回,不显式按 `updated_at` 排序**——在应用层 `[userId, "threads"]` namespace 里 `client.sort((a, b) => b.updated_at.localeCompare(a.updated_at))` 后再 `.slice(0, K)`。

**Rationale**:

- `PostgresStore` 实现来自 `@langchain/langgraph-checkpoint-postgres`,`search` 通过 `LIKE` 查 prefix,不保证 global 时间排序
- 应用层 sort 简单、可读,且 summary 数 < 50 时排序成本可忽略(< 1ms)
- 跨 thread recall 时 `key` 前缀 `${threadId}:`,不同 thread 间不需要全局排序

**Alternatives considered**:

- 用 SQL `ORDER BY updated_at` 旁路 store API — 拒绝,违反 NFR-004(env read at module load)且维护成本高
- 把 `updated_at` 塞进 `value` 后用 Postgres trigger 自动维护 — 拒绝,MVP 不需要

### D-004. account 表 provider 字段语义

**Decision**: better-auth `account` 表实际字段名是 `providerId`(语义 = provider 类型,如 `"github"`、`"google"`),**没有** `provider` 字段。Spec FR-013 / FR-019 / FR-020 写的"`socialAccounts: Array<{ provider }>`"在实现层映射为 `account.providerId`。

**Rationale**:

- `lib/auth/schema.ts` 第 41 行:`providerId: text("provider_id").notNull()`
- 出于可读性,API response shape 把 `providerId` 重命名映射为 `provider`(前端 / LLM 都不关心 PK 命名)
- SELECT 只 `select({ provider: account.providerId })`,**不查** `accountId` / `accessToken` / `refreshToken` / `idToken` / `password`,避免敏感字段泄漏到 middleware / API response

**Alternatives considered**:

- 用 `accountId`(github user id 之类)当 `provider` 返回 — 拒绝,这是 oauth account id,不是 provider 类型,违反 spec "only provider not providerId"
- 在 Drizzle 层 `select *` 后手工 strip — 拒绝,容易漏字段,显式 `select` 更安全

### D-005. better-auth-ui settingsTabs 注入位置

**Decision**: 项目当前**未启用** better-auth-ui 的 settings 路由(grep `settingsTabs` / `SettingsView` 无命中),需要在两处同时改动:

1. **`components/auth/auth-provider.tsx`** 注册带 `settingsTabs` 字段的 plugin 对象(模仿 organization plugin 的结构)
2. **`global.d.ts`** 加 module augmentation:
   ```ts
   declare module "@better-auth-ui/core" {
     interface SettingsViewPaths {
       memory: string;
     }
   }
   ```
3. **`components/settings/memory-view.tsx`** 新增 view 组件,由 plugin 的 `settingsTabs: [{ view: "memory", label: "Memory", component: MemoryView }]` 引用

**Rationale**:

- `SettingsView = keyof SettingsViewPaths` 是 union type,新加 `memory` 必须先 `declare module` 让 TS 接受字面量
- `SettingsTab.view` 字段类型就是 `SettingsView`,所以新 view 自动被类型系统接受
- 路由:better-auth-ui 用 dynamic `[view]` segment,URL 默认 `/settings/memory`(因 `SettingsViewPaths.memory` 默认值 = key 名)

**Alternatives considered**:

- 独立写 `app/settings/page.tsx` 不接 better-auth-ui — 拒绝(spec 明确 "settingsTabs 插件,不重建 settings 页")
- 不加 `declare module`,把 component 用 `as any` 强转 — 拒绝(rule #3 标准方案,失去类型安全)

### D-006. userId 注入来源(`config.configurable.userId`)

**Decision**: `userId` 由 Next.js proxy route 注入。`app/api/[..._path]/route.ts`(已存在,rule #9 改造后)在转发到 LangGraph 前,从 session 取 `user.id`,写进 `config.configurable.userId` 并通过 `x-config-user-id` header(或 body 字段)转发。

**Rationale**:

- LangGraph dev server 的 `POST /threads/<id>/runs` body 已支持 `config` 字段(`configurable` 是其子字段)
- 注入点在 proxy 最自然(唯一已认证边界,rule #9 的延伸)
- middleware 只需读 `config.configurable.userId`,不直接调 better-auth — 降低 middleware 依赖

**Alternatives considered**:

- middleware 内直接调 `auth.api.getSession` — 拒绝,需要从 request headers 取 session cookie,在 middleware 层要么 `next/headers` 注入要么从 config 拿,proxy 注入更集中
- 让前端(assistant-ui runtime)在 invoke 前手动 setConfig — 拒绝,跨 layer 耦合

**Compatibility**: 与 rule #9 一致——proxy 已 `withAuth`,session user.id 已经在 handler scope 内可用。

### D-007. threadSummarize 节点 userMessageCount 来源

**Decision**: `userMessageCount` 字段加进 `CommonAgentState`(由 `messages` 数组 reducer 计算,或新增独立 channel)。节点读 `state.userMessageCount`(已在 `state.ts` 添加 channel)。

**Rationale**:

- checkpointer 持久化 state,跨 turn 可用
- 直接 `state.messages.filter(BaseMessage.isInstance('human')).length` 也可以,但每次节点都要 recompute,加 channel 后 reducer 维护一次
- `userMessageCount` 是 graph 元数据,不属于 message content,放 state channel 正确

**Alternatives considered**:

- 节点内 recompute — 拒绝,O(n) per turn
- 单独存 DB 行 — 拒绝,MVP 不需要,store threads 已有 summary 区间索引可推导

### D-008. 写入大小校验时机

**Decision**: `save_memory` 工具:**先 apply patch → 校验 size → store.put**(如果 size 超限抛错,**不**调 store)。

**Rationale**:

- FR-003 / NFR-003 明确 "写入前校验 fail-fast,不允许半写"
- patch apply 后的 JSON 序列化成本 < 1ms(p50 profile 大小),校验失败不污染 store
- 实现:`const after = apply(currentProfile, patches); const bytes = Buffer.byteLength(JSON.stringify(after)); if (bytes > MAX) throw new MemorySizeError(); await store.put(...)`

**Alternatives considered**:

- 写完再 size check 回滚 — 拒绝,需要事务,store 不暴露 transaction API
- stream chunks 累加校验 — 拒绝,profile 是 JSON document 不是 blob,整文档概念

## Cross-Cutting Findings

- **`PostgresStore.setup()`** 已在 `backend/store.ts` 启动时调用(`await store.setup()`),不需重复
- **`auth.api.getSession`** 接受 `headers: HeadersLike`,proxy 路径已经 `await auth.api.getSession({ headers: await headers() })`(rule #9 模式),可复用
- **`account` 表查询走 drizzle**(`lib/auth/queries.ts` 或新建 `lib/memory/queries.ts` 的 `getSocialAccounts(userId)`),不要直接接 pg client — 与项目内 `threads` 模块同款
- **`fast-json-patch`** patch schema 验证需要 zod(`z.array(z.object({ op, path, value? }))`),RFC 6902 op 枚举 `add | remove | replace | move | copy | test` —— MVP 只允许 `add | replace | remove`,zod refine 拒绝其他 op

## Open Questions

None — 所有 plan 中标记的 NEEDS CLARIFICATION 已在 D-001..D-008 解决。
