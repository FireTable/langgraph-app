# Implementation Plan: LangGraph Long-Term Memory

**Branch**: `feat/003-langgraph-store` | **Date**: 2026-07-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-langgraph-store/spec.md`

## Summary

把 `backend/store.ts` 已接好的 `PostgresStore` 真正用起来,落地 per-user 长期记忆。短期(checkpointer)管 thread 内消息,长期(store)管跨 thread 用户画像 + 历史摘要。

- **写入面**: 单个 `save_memory(patches: JSONPatch[])` 工具(RFC 6902),大小上限 8KB fail-fast,接进 `ALL_TOOLS`,所有 `chatModelNode` 自动可见
- **召回面**: `withMemoryRecall` middleware 包 `chatModel`,每次 invoke 合并 profile + better-auth session + socialAccounts + threads top-K,合成为单个 `<memory>{...}</memory>` system message prepend
- **摘要节点**: `threadSummarize` node 在 `afterAgent` 后,user msg > threshold 触发,生成 `{name, description}` 写 `[userId, "threads"]`
- **API**: 4 个 `withAuth` 端点(`GET /api/memory/profile`、`DELETE /api/memory/profile/:key`、`GET /api/memory/threads`、`DELETE /api/memory/threads/:threadId`)
- **Settings UI**: 通过 better-auth-ui 的 `settingsTabs` 插件加 "Memory" tab,声明 `SettingsViewPaths.memory`,两个区块 Profile / Thread Summaries

## Technical Context

**Language/Version**: TypeScript 5.x / Node 22(项目固定)

**Primary Dependencies**(全部项目内已有):

- `@langchain/langgraph-checkpoint-postgres/store`(`PostgresStore`,已在 `backend/store.ts` 接好)
- `@langchain/core` 1.2.x(middleware API 来自 `Runnable` 链式)
- `fast-json-patch`(项目目前未引入,**新增依赖**;RFC 6902 patch 应用 + 校验)
- `zod` 3.x(工具入参 / API 出参 validator)
- `drizzle-orm` + `drizzle-zod`(`account` 表查询复用)
- `better-auth`(`auth.api.getSession` + `account` 表)
- `@better-auth-ui/core` 的 `settingsTabs` 插件(`SettingsViewPaths` module augmentation)

**Storage**: PostgreSQL(项目已有 `db/client.ts`;`PostgresStore.setup()` 在 `backend/store.ts` 启动时已跑)

**Testing**: Vitest(`pnpm test`),TDD(rule #2 强制)

**Target Platform**: Next.js 16 App Router + LangGraph dev server(`pnpm dev`)

**Project Type**: Web application(frontend + backend in monorepo,沿用现有结构)

**Performance Goals**:

- `withMemoryRecall` middleware 在 p50 profile 大小(< 1KB)时 p95 < 50ms(NFR-001)
- 单次 `save_memory` 工具调用 < 100ms(包含 patch apply + 校验 + Postgres write)
- `threadSummarize` LLM 调用 < 5s,不阻塞后续 turn

**Constraints**:

- 4 个 API 必须 `withAuth` 包裹(rule #9)
- API 改动必须同步 `docs/APIS.md`(rule #1)
- `save_memory` 大小校验在写之前(NFR-003 fail-fast,不允许半写)
- namespace 必须 `[userId, ...]` 开头,无全局 / 跨用户

**Scale/Scope**:

- profile 文档 < 8KB,通常 < 50 个 k-v
- thread summaries:每 thread 多 sequence,每用户最多 ~50 个 thread × ~5 sequence = 250 docs
- recall 时 threads top-K=3,profile 单文档读全

## Constitution Check

_GATE: 必须通过才能进入 Phase 0 research。Phase 1 设计后再校验一次。_

本项目无独立 `constitution.md`,规则源自 `CLAUDE.md` 的 11 条 Engineering Rules + 章程 v1.5.0(若适用)。逐条对照:

| 原则                       | 状态 | 备注                                                                                                                   |
| -------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------- |
| 一、规格 / 代码 / 文档同步 | ✅   | spec + plan + research + data-model + contracts + quickstart 全部生成;route handler 落地时同步 `docs/APIS.md`(rule #1) |
| 二、测试先行(rule #2)      | ✅   | tool / middleware / node / validators / queries 全部 TDD,queries+validators ≥ 90% 覆盖,route 全 status code 覆盖       |
| 三、首选标准方案           | ✅   | `fast-json-patch` 是 RFC 6902 的事实标准实现;无手写 patch 引擎                                                         |
| 四、UI 改动必须视觉验证    | ✅   | settings Memory tab 在 plan 阶段标 TODO:`pnpm dev` + Chrome DevTools MCP 截图(rule #4)                                 |
| 五、注释克制               | ✅   | 仅在 JSON Patch 大小校验 / `[userId]` namespace 隔离 / store write order 等非显然点使用                                |
| 六、Spec-kit 中文输出      | ✅   | spec / plan / research / data-model / quickstart / contracts 全部中文,代码 / SQL / commit message 保持英文             |
| Rule #1 API doc 同步       | ✅   | `docs/APIS.md` 在 PR 合并前更新                                                                                        |
| Rule #2 TDD                | ✅   | 每个新 module 先写失败测试                                                                                             |
| Rule #9 withAuth           | ✅   | 4 个 API endpoint 全部 `withAuth` 包裹                                                                                 |

无违规,无需 Complexity Tracking。

## Project Structure

### Documentation (this feature)

```text
specs/003-langgraph-store/
├── plan.md              # 本文件
├── research.md          # Phase 0 输出
├── data-model.md        # Phase 1 输出
├── contracts/
│   ├── save-memory-tool.md   # Phase 1 输出 — 工具 schema
│   ├── memory-api.md         # Phase 1 输出 — 4 个 API endpoint 契约
│   └── store-namespaces.md   # Phase 1 输出 — namespace 与 key 格式
├── quickstart.md        # Phase 1 输出
├── spec.md              # 已存在(draft)
└── tasks.md             # Phase 2 输出(/speckit-tasks)
```

### Source Code (repository root)

新增 / 修改路径(全部为真实路径,无占位):

```text
backend/
├── store.ts                     # 已有 — 维持不变,export `store` 复用
├── agent.ts                     # 修改 — compile({ store }) 已在;新增 threadSummarize node 接入 graph
├── state.ts                     # 修改 — CommonAgentState 加 userMessageCount 字段(节点读写用)
├── model.ts                     # 修改 — chatModel.withConfig({ callbacks }) 改为 .withMiddleware([withMemoryRecall])
├── node/
│   ├── call-model-node.ts       # 修改 — 透传 config(已透传,无需大改)
│   ├── after-agent-node.ts      # 已有 — 维持
│   ├── thread-summarize-node.ts # 新增 — 独立 node,afterAgent 之后
│   └── (其余节点不动)
├── tool/
│   ├── index.ts                 # 修改 — ALL_TOOLS 加 saveMemoryTool
│   └── memory/
│       ├── save-memory-tool.ts  # 新增 — JSON Patch 工具实现
│       └── profile-size.ts      # 新增 — 大小校验辅助
├── middleware/
│   └── with-memory-recall.ts    # 新增 — middleware 实现
└── memory/
    ├── profile.ts               # 新增 — profile 读 / patch 应用 / 大小校验
    ├── threads.ts               # 新增 — threads 读 / 写 / top-K 查询
    └── types.ts                 # 新增 — Summary / ProfileDoc / SessionContext 类型

lib/
├── auth/
│   └── (复用) withAuth, getSession
├── memory/
│   ├── queries.ts               # 新增 — profile / threads 的 store 查询封装
│   ├── validators.ts            # 新增 — Zod:Patch / ProfileResponse / ThreadsResponse / 等
│   └── schema.ts                # 新增 — 复刻 better-auth account 投影类型(仅 provider)
├── observability/               # 不动
└── threads/                     # 不动

app/api/memory/
├── profile/
│   ├── route.ts                 # 新增 — GET /api/memory/profile
│   └── [key]/route.ts           # 新增 — DELETE /api/memory/profile/:key
└── threads/
    ├── route.ts                 # 新增 — GET /api/memory/threads
    └── [threadId]/route.ts      # 新增 — DELETE /api/memory/threads/:threadId

components/
├── auth/
│   └── settings-tabs.tsx        # 新增(或在 auth-provider.tsx 注册) — settingsTabs 插件配置
└── settings/
    └── memory-view.tsx          # 新增 — Profile + Thread Summaries 区块组件

app/
└── settings/[view]/page.tsx     # 新增(或复用 better-auth-ui 自带路由)— settings 视图壳

global.d.ts                      # 修改 — declare module "@better-auth-ui/core" 加 SettingsViewPaths.memory
tests/
├── api/memory/                  # 新增 — 4 个 endpoint 测试
├── backend/memory/              # 新增 — middleware / node / queries 测试
└── backend/tool/memory/         # 新增 — save_memory 工具测试

docs/
└── APIS.md                      # 修改 — 加 § Memory 章节(rule #1)
```

**Structure Decision**: 沿用现有 monorepo 结构(单仓,Next.js + LangGraph),无新增 sub-project。新增 module 集中放在:

- `backend/memory/` + `backend/middleware/` + `backend/node/thread-summarize-node.ts` + `backend/tool/memory/` —— 后端
- `lib/memory/` —— 跨层共享(store 查询封装、validators)
- `app/api/memory/` —— API endpoint
- `components/settings/` —— UI

模块边界遵守章程 v1.5.0:store 读写归 `lib/memory/queries.ts`,agent 决策(`save_memory` 触发、recall 注入)归 `backend/`,UI 归 `components/` + `app/`。

## Architecture

### 数据流

#### 写路径

```
chatModelNode(model invoke)
  → model emit tool_calls [{name: "save_memory", args: {patches: [...]}}]
    → saveMemoryTool(patches)
      → lib/memory/queries.ts: getProfile(userId)              # 读现 profile
      → fast-json-patch.apply(profile, patches, validate: false)
      → profile-size.ts: assertSize(JSON.stringify(profile))  # 8KB fail-fast
      → store.put([userId, "profile"], "main", profile)
      → return { ok: true, bytes: profileBytes }
```

#### 读路径(middleware)

```
chatModel.invoke(messages, config)
  → withMemoryRecall middleware
    → if !config.configurable?.userId → pass-through          # dev 启动期透传(FR-007)
    → parallel:
        store.get([userId, "profile"], "main")               # profile doc
        auth.api.getSession(headers)                          # { name, email, image }
        drizzle: account table where userId                  # socialAccounts(provider only)
        store.search([userId, "threads"], { limit: K })       # threads top-K by updatedAt
    → compose { profile, session, socialAccounts, threads }
    → system message: "<memory>{json}</memory>"
    → prepend → messages = [systemMemory, ...messages]
    → invoke inner chatModel
```

#### 摘要节点

```
afterAgent → threadSummarize(node)
  → if userMessageCount <= THRESHOLD → return {} (no-op)
  → latestSummary = store.search([userId, "threads"], filter: key ^= "${threadId}:")
                       .sort(endMessageIndex desc)[0]
  → startIdx = (latestSummary?.endMessageIndex ?? -1) + 1
  → endIdx   = userMessageCount - KEEP_RECENT
  → if endIdx < startIdx → return {} (no-op, FR-010 跳过)    # 严格小于;1 条也处理
  → messages.filter(isHuman | isAI).slice(startIdx, endIdx + 1)   # slice 末位 exclusive → 闭区间 [startIdx, endIdx]
  → chatModel.invoke(prompt: summarize, messages)
       .withStructuredOutput({ name, description })
  → store.put([userId, "threads"], `${threadId}:${sequence}`, {
       threadId, sequence, name, description,
       startMessageIndex: startIdx,                                # inclusive, FR-010
       endMessageIndex:   endIdx,                                  # inclusive, 不做 -1, FR-010
       messageCount:      endIdx - startIdx + 1,                   # 闭区间长度
       updatedAt:         new Date().toISOString()
    })
```

### Namespace & Key 规范(完整定义见 `contracts/store-namespaces.md`)

| Namespace             | Key 格式               | Value 类型                                                                                               |
| --------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `[userId, "profile"]` | `"main"`(固定)         | `Record<string, unknown>`(扁平 k-v)                                                                      |
| `[userId, "threads"]` | `"${threadId}:${seq}"` | `{ threadId, sequence, name, description, startMessageIndex, endMessageIndex, messageCount, updatedAt }` |

### 中间件顺序

`chatModel` 当前的 `withConfig({ callbacks: [getCapturingHandler()] })` → 改为 `.withMiddleware([withMemoryRecall]).withConfig({ callbacks: [getCapturingHandler()] })`。Middleware 顺序:记忆召回在 callback 之外(独立 transformer),callback 仍按现有 span 捕获逻辑运行。

### threadSummarize 节点接入

修改 `backend/agent.ts` 的 parent graph:在 `afterAgent` 之后加一个 conditional edge → `threadSummarize`。`threadSummarize` 是终点 node(无下游 edge)。两个 builder(`buildSubgraph()` / `buildInlined()`)都要改(rule #1:保持同步)。

### Design decisions(本 feature 内部)

- **D-009. `userId` 缺失时,middleware 软跳过 vs `save_memory` 工具硬失败(不对称)**

  - **Middleware(FR-007)**:`config.configurable.userId` 缺失 → pass-through,**不**注入 `<memory>` system message。
  - **`save_memory` 工具(FR-023)**:`config.configurable.userId` 缺失 → fail-fast,抛 `MissingUserIdError`,tool 返回明确错误给模型。
  - **理由**:
    - Middleware 是**隐式上下文提取**。recall 缺失意味着模型少了一些上下文,属降级模式,用户无感,下一次正确调用的 invoke 会补回来。
    - Tool 调用是**显式 user action**(模型代用户写长期事实)。写入面 userId 缺失是**配置错误**,任何"假装成功"或"默认用户"语义都会:
      1. 把 A 用户的事实写到 B 用户 profile(数据泄漏)
      2. 或 silently no-op(模型以为写成功,后续对话引用了用户没确认的事实)
    - 这两种后果都不可逆,且比"对话短暂无记忆"严重得多。Hard fail 把问题暴露到模型层 → 模型可以告知用户"无法保存这条记忆,请尝试新会话"。
  - **落地位置**:`backend/tool/memory/save-memory-tool.ts` 入口立即 `assertUserIdPresent(config)`,缺则抛 `MissingUserIdError`(继承自 `Error`,带 `code: "MISSING_USER_ID"`)。Middleware `with-memory-recall.ts` 保持现有 pass-through 分支。
  - **测试矩阵**:`tests/backend/tool/memory/save-memory-tool.test.ts` 加 `config.configurable.userId` 缺失 → 抛 `MissingUserIdError` 且**不**调 `store.put`(`vi.mock("backend/store")` 验证 0 次调用)。

## Phase 0: Research

详见 [research.md](./research.md)。

主要确认项:

1. **`fast-json-patch` API**: `apply(document, patches, validateOperation, mutateDocument, banPrototypeModifications)` 的入参顺序,以及 `remove` op 在 path 不存在时的行为(必须 fail-fast 而非 no-op)
2. **`Runnable.withMiddleware`(或等价的 LangGraph 1.x 注入点)**:确认用什么 API 包 chatModel 来 prepend system message。备选 `dynamicSystemPromptMiddleware`(@assistant-ui 风格)、`RunnableSequence` 手工 wrap
3. **`PostgresStore.search` 的 limit 行为**:确认它返回的是按 namespace 内 natural order 还是按 `updatedAt`,以及如何显式 sort
4. **`account` 表的 schema**:`lib/auth/schema.ts` 已有,确认 `providerId` 字段名,以便 SELECT 时排除
5. **better-auth-ui `settingsTabs` 插件的注册位置**:项目当前未启用 settings,确认是改 `components/auth/auth-provider.tsx` 还是新建 `components/settings/` 目录
6. **memoryRecall 在 dev 启动期的 `userId` 来源**:`config.configurable.userId` 何时被注入——`langgraphjs dev` 的 InMemorySaver 路径下,`/threads/<id>/runs` 的 POST 体里是否带;若不带,需要 `withAuth` proxy 注入(rule #9 已统一)

## Phase 1: Design & Contracts

详见:

- [data-model.md](./data-model.md) —— Profile doc / Summary doc / Session context / Social accounts 四类实体的字段、校验、关系
- [contracts/save-memory-tool.md](./contracts/save-memory-tool.md) —— save_memory 工具的入参 schema、返回值、错误类型
- [contracts/memory-api.md](./contracts/memory-api.md) —— 4 个 API endpoint 的 request / response / status code
- [contracts/store-namespaces.md](./contracts/store-namespaces.md) —— namespace + key 格式 + filter 表达式
- [quickstart.md](./quickstart.md) —— 端到端可执行的验证步骤(US1 / US2 / US3 三大场景)

### Agent Context 更新

完成后需在 `CLAUDE.md` 中 `<!-- SPECKIT START -->` 与 `<!-- SPECKIT END -->` 标记之间,更新 plan 引用路径为 `specs/003-langgraph-store/plan.md`(由 `speckit-agent-context-update` hook 自动执行,见 extensions.yml `after_plan` 钩子)。

## Re-evaluation (Post-Phase 1)

| 原则                      | 状态 | 备注                                                                                                                                                                                                        |
| ------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 一、规格同步              | ✅   | spec + plan + research + data-model + contracts + quickstart 已落位                                                                                                                                         |
| 二、TDD(rule #2)          | ✅   | 实施阶段先写 tests:`tests/backend/tool/memory/save-memory.test.ts`、`tests/backend/middleware/with-memory-recall.test.ts`、`tests/backend/node/thread-summarize-node.test.ts`、`tests/api/memory/*.test.ts` |
| 三、首选标准方案          | ✅   | `fast-json-patch` 是社区 RFC 6902 事实标准;middleware 用 LangGraph 官方 `withMiddleware`                                                                                                                    |
| 四、UI 视觉验证           | ✅   | settings Memory tab 用 Chrome DevTools MCP 截图(rule #4)                                                                                                                                                    |
| 五、注释克制              | ✅   | 见 Architecture 内的 fail-fast / namespace 隔离注释                                                                                                                                                         |
| 六、Spec-kit 中文         | ✅   | 全部 spec-kit 产物中文                                                                                                                                                                                      |
| Rule #1 docs/APIS.md 同步 | ✅   | 在最后任务里                                                                                                                                                                                                |
| Rule #9 withAuth          | ✅   | 4 个 API 全部包                                                                                                                                                                                             |

无新增违规。

## Open Questions

None — spec Clarifications 已覆盖所有决策点。
