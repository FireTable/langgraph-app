---
description: "Task list for LangGraph Long-Term Memory MVP"
---

# Tasks: LangGraph Long-Term Memory

**Input**: Design documents from `/specs/003-langgraph-store/`
**Prerequisites**: plan.md · spec.md · research.md · data-model.md · contracts/save-memory-tool.md · contracts/memory-api.md · contracts/store-namespaces.md · quickstart.md

## Format: `[ID] [P?] [Story] 文件路径 + 描述`

- **[P]**: 可并行(不同文件,无未完成依赖)
- **[Story]**: 归属 user story(US1-US4)
- **所有路径**: 相对仓库根

---

## Phase 1: Setup(已有项目,仅补充配置 + 依赖)

**目标**: 新增 fast-json-patch 依赖,登记 4 个 memory env var 到 `.env.example`,作为整个 feature 的运行时入口

- [ ] T001 在 `package.json` dependencies 段加 `"fast-json-patch": "^3.1.1"`,运行 `pnpm install` 验证 lockfile 更新
- [ ] T002 在 `.env.example` 末尾追加 4 个 env var + 注释(描述 / 默认值 / 校验规则):`MEMORY_PROFILE_MAX_BYTES=8192`、`MEMORY_THREAD_SUMMARY_THRESHOLD=10`、`MEMORY_THREAD_SUMMARY_KEEP_RECENT=4`、`MEMORY_THREAD_RECALL_LIMIT=3`

**Checkpoint**: 配置就位,后续 phase 可读 env var

---

## Phase 2: Foundational(常量、Validators、Queries、Profile Size Guard)🚧 阻塞所有 user story

**目标**: 把 memory 模块的 shared layer 建好 —— 常量 / 校验 / store 查询封装 / 大小守卫 —— 作为 US1-US4 的共同依赖

### Tests(RED first,rule #2)

- [ ] T003 [P] 在 `tests/lib/memory/validators.test.ts` 写失败测试:`MemoryPatch` discriminated union 拒 `move`/`copy`/`test`、path regex 拒 `..` / 数组下标、空 patches 数组拒、`add` / `replace` 缺 `value` 拒、`SaveMemoryInput` 数组长度 1..50
- [ ] T004 [P] 在 `tests/lib/memory/queries.test.ts` 写失败测试:`getProfileDoc` 缺 profile 返回 `{}` / `putProfileDoc` 调 `store.put([userId,"profile"],"main",value)` / `deleteProfileField` key 不存在返回 null / `getAllUserSummaries` zod parse 跳过损坏 doc / `getRecentThreadSummaries` 按 `updatedAt` desc 取 top-K / `deleteThreadSummaries` 返回删除数
- [ ] T005 [P] 在 `tests/backend/memory/profile-size.test.ts` 写失败测试:`assertProfileSize` < 8KB 不抛、= 8KB 不抛、> 8KB 抛 `MemorySizeError` 携带 attemptedBytes / maxBytes

### Implementation

- [ ] T006 创建 `lib/memory/constants.ts`:导出 4 个常量(读 `process.env`,缺失回退默认;module load 一次,NFR-004),`as const` + 简单类型守卫(空 / 非数字回退默认)
- [ ] T007 在 `lib/memory/validators.ts` 实现 T003 测试所需 schema:`MemoryPatch`(discriminated union) / `SaveMemoryInput` / `ProfileResponse` / `SummaryEntry` / `ThreadSummaryGroup` / `ThreadsResponse` / `ProfileDeleteResponse` / `ThreadsDeleteResponse`(对应 `contracts/memory-api.md` § Zod 段)
- [ ] T008 在 `lib/memory/queries.ts` 实现 T004 测试所需封装:`getProfileDoc(userId)` / `putProfileDoc(userId, value)` / `deleteProfileField(userId, key)` / `getAllUserSummaries(userId)` / `getRecentThreadSummaries(userId, limit)` / `deleteThreadSummaries(userId, threadId)` / `writeSummary(userId, doc)`(全部用 `backend/store.ts` export 的 `store`,不连真实 Postgres —— 测试用 `vi.mock`)
- [ ] T009 [P] 在 `backend/memory/profile-size.ts` 实现 `assertProfileSize(value)` + 自定义 `MemorySizeError`(attemptedBytes / maxBytes);导出 `MemorySizeError` 给 `save-memory-tool.ts` 复用

**Checkpoint**: 跑 `pnpm test tests/lib/memory tests/backend/memory`,foundational 全绿;queries + validators 覆盖率 ≥ 90%(rule #2 强制)

---

## Phase 3: User Story 1 - 跨 thread 续聊(P1)🎯 MVP

**目标**: save_memory 工具 + withMemoryRecall middleware 全链路打通,跨 thread 模型正确引用 profile

**Independent Test**: `pnpm dev` + Chrome DevTools MCP 登录账号,thread-A 说「我前端 + LangGraph demo」,观察 Network `save_memory` 调用 + DB `SELECT * FROM store WHERE prefix=ARRAY[<uid>,'profile']` 有新字段;开 thread-B 问「我在做什么项目」,回复提到 LangGraph demo

### Tests(RED)

- [ ] T010 [P] [US1] 在 `tests/backend/tool/memory/save-memory-tool.test.ts` 写失败测试矩阵(`contracts/save-memory-tool.md` § 测试矩阵 11 条):空 profile + add / 合并 / replace / remove / 多 patch 顺序 / 超 8KB 抛 / remove path 不存在抛 / replace path 不存在抛 / op=move 拒 / 空 patches 拒
- [ ] T010b [P] [US1] **F1 修复专项**:在 `tests/backend/tool/memory/save-memory-tool.test.ts` 追加"userId 缺失 fail-fast"测试矩阵,与 middleware FR-007 软跳过形成对照:
  - `config` 为 undefined → 抛 `MissingUserIdError`,`code === "MISSING_USER_ID"`,且**不**调 `store.put`(用 `vi.mock("@/backend/store")` 验证 `store.put` 调用次数为 0)
  - `config.configurable` 为 undefined → 同上
  - `config.configurable.userId` 为空字符串 `""` → 同上(空字符串视同缺失,不视同有效 id)
  - `config.configurable.userId` 为合法非空 string → 正常路径,不抛
  - 测试组标题写明 `describe("FR-023 fail-fast vs FR-007 middleware pass-through")` 让 reviewer 一眼看见不对称语义(plan D-009)
- [ ] T011 [P] [US1] 在 `tests/backend/middleware/with-memory-recall.test.ts` 写失败测试:`config.configurable.userId` 缺失 → pass-through(不动 messages,FR-007);有 userId → prepend `<memory>{...}</memory>` system message,内含 profile + session + socialAccounts + threads top-K;`threads` 缺失时不报错(middleware 容错);`session` 调用 `auth.api.getSession`;`socialAccounts` 走 drizzle,只 SELECT `providerId as provider`
- [ ] T012 [P] [US1] 在 `tests/backend/middleware/with-memory-recall-proxy.test.ts` 写失败测试:proxy handler 从 `headers()` 取 session,`user.id` 注入 `body.config.configurable.userId`(或 header,见 `research.md` D-006),无 session → 401(rule #9)

### Implementation

- [ ] T013 [US1] 创建 `backend/tool/memory/save-memory-tool.ts`:从 `config.configurable.userId` 取 userId,**首行** `assertUserIdPresent(config)` 校验 —— 缺失或空字符串立即抛 `MissingUserIdError`(code: `MISSING_USER_ID`,**不**走后续 patch / store 调用,FR-023 / plan D-009)→ `SaveMemoryInput.parse(input)` → `getProfileDoc(userId)` → `fastJsonPatch.apply(structuredClone, patches, false, true, true)` → `assertProfileSize(after)` → `putProfileDoc(userId, after)` → 返回 `{ ok: true, bytes, keyCount }`;异常捕获 → `MemoryPatchError` / `MemorySizeError` / `MissingUserIdError`(后者是显式 fail-fast,不入 tool success 输出)
- [ ] T014 [US1] 在 `backend/tool/index.ts` 的 `ALL_TOOLS` 数组里加 `saveMemoryTool`(按现有 `StructuredTool` 类型)
- [ ] T015 [P] [US1] 在 `backend/middleware/with-memory-recall.ts` 实现 middleware:`new RunnableLambda({ func: async (input, options) => ... })`,`options?.config?.configurable?.userId` 缺失时 pass-through,否则并行 `getProfileDoc` / `auth.api.getSession({ headers })` / drizzle `select(providerId as provider) from account where userId` / `getRecentThreadSummaries(userId, K)`,合成 `<memory>{json.stringify(...)}</memory>` system message prepend 到 `messages` 数组首位
- [ ] T016 [US1] 在 `backend/model.ts` 把 `chatModel` 改为 `chatModelWithRecall`(即 `withMemoryRecallLambda.pipe(chatModel)`);`chatModelWithoutThink` **不**包(NFR-005 / FR-005,rename 是后台任务);回调仍走 `.withConfig({ callbacks: [getCapturingHandler()] })`
- [ ] T017 [US1] 在 `app/api/[..._path]/route.ts` 的 POST/PUT/PATCH handler 内,从 `await auth.api.getSession({ headers: await headers() })` 取 user.id,合并到 body 的 `config.configurable.userId`(若 body 没有 config 字段则新建;rule #9 兼容)
- [ ] T018 [US1] 跑 T010 / T011 / T012 测试,全绿;若红则修实现(rule #2 RED → GREEN)
- [ ] T019 [US1] Chrome DevTools MCP 视觉验证(rule #4):登录 → thread-A 聊偏好 → Network 抓 `save_memory` → DB 确认 profile 有字段 → thread-B 问「我在做什么」→ 截图回复含 LangGraph demo

**Checkpoint**: US1 可独立 demo,MVP 达到「跨 thread 续聊」

---

## Phase 4: User Story 2 - Thread 长到压缩上下文(P1)

**目标**: threadSummarize node 在 afterAgent 后跑,user msg 超过阈值时写 summary doc,区间索引正确

**Independent Test**: 单 thread 连续发 11 条 user msg,等最后一条 agent 回复完,`SELECT * FROM store WHERE prefix=ARRAY[<uid>,'threads']` 出现 `thread-X:1`,**闭区间不变式**:`startMessageIndex=0`(latest 不存在 → `-1 + 1`)、`endMessageIndex=6`(`11 - KEEP_RECENT(4) = 7`,inclusive → 末位索引 6)、`messageCount=7`(`endIdx - startIdx + 1 = 7`);继续到 16 条,出现 `thread-X:2`,`startMessageIndex=7`(上一条 `endMessageIndex + 1`)、`endMessageIndex=11`、`messageCount=5`

### Tests(RED)

- [ ] T020 [P] [US2] 在 `tests/backend/node/thread-summarize-node.test.ts` 写失败测试:`userMessageCount <= THRESHOLD` → 空 state(跳过);`latestSummary` 不存在 → `startIdx=0`;`endIdx < startIdx` → 空 state(跳过);正常区间 → LLM invoke structured output `{ name, description }`,写 store,`sequence = max + 1`,**闭区间不变式**:`startMessageIndex = startIdx`、`endMessageIndex = endIdx`(inclusive,不做 `endIdx - 1` 减法,FR-010)、`messageCount = endIdx - startIdx + 1`;KEEP_RECENT env 生效(用 vi.stubEnv 切换);**F3 边界 case 必含**:`startIdx === endIdx`(单条消息,`messageCount === 1`,且 store 的 `endMessageIndex === startMessageIndex`)+ `startIdx + 1 === endIdx`(两条消息,`messageCount === 2`)+ `startIdx === 0 && endIdx === userMessageCount - 1`(整段窗口)+ `endIdx < startIdx`(明确为 skip,不调 store.put)
- [ ] T021 [P] [US2] 在 `tests/lib/memory/queries.test.ts` 补充测试:`writeSummary` 调 `store.put([userId,"threads"], "${threadId}:${sequence}", doc)`,doc 形状符合 `SummaryDocSchema`,`updatedAt` 是 ISO 8601

### Implementation

- [ ] T022 在 `backend/state.ts` 的 `CommonAgentState` 加 `userMessageCount: Annotation<number>`(reducer: append 时 +1,或初始 0);`backend/state.ts` 顶部 import `BaseMessage` from `@langchain/core/messages`
- [ ] T023 在 `backend/node/call-model-node.ts` 的返回里更新 `userMessageCount = state.messages.filter(BaseMessage.isInstance('human')).length`(或在 reducer 里维护,二选一,选 reducer 更省 CPU)
- [ ] T024 创建 `backend/node/thread-summarize-node.ts`:从 `state.threadId` / `state.userMessageCount` / `state.messages` / `state.config.configurable.userId` 取输入 → 阈值检查 → `getAllUserSummaries` 找 latest summary for this thread → 计算 `startIdx` / `endIdx`(**闭区间两端 inclusive**,FR-010)→ 跳过分支用严格不等式 `endIdx < startIdx`(1 条 / 2 条都处理)→ 取区间 messages 用 `messages.filter(isHuman | isAI).slice(startIdx, endIdx + 1)`(`Array.slice` 末位 exclusive → `endIdx + 1` 闭合闭区间)→ 喂 `chatModel.invoke(summarizePrompt, { ...structuredOutput })` → 写 `SummaryDoc` 时**严格**用 `startMessageIndex: startIdx`、`endMessageIndex: endIdx`(不 `endIdx - 1`)、`messageCount: endIdx - startIdx + 1` → `writeSummary(userId, doc)` → 返回 `{}`(纯 side-effect 节点)
- [ ] T025 [P] [US2] 在 `backend/prompt/system.ts` 加 `THREAD_SUMMARIZE_PROMPT`(输入: messages 区间文本;输出结构: `{ name: string ≤80 chars, description: string ≤500 chars }`);导出 `ThreadSummarizeSchema` zod 给 node 用
- [ ] T026 [US2] 修改 `backend/agent.ts` 的 `buildSubgraph()` 和 `buildInlined()`:在 `afterAgent` 之后加 conditional edge → `threadSummarize`(无条件直接走,或 `addEdge("afterAgent", "threadSummarize")`);`threadSummarize` 不挂下游 edge(终点);两个 builder 同步(rule #1,「保持同步」原则)—— **同步的不只是 edge 结构,还有 T024 的 closed-interval 数据流不变式**(`startMessageIndex = startIdx`、`endMessageIndex = endIdx` inclusive、`messageCount = endIdx - startIdx + 1`)
- [ ] T027 [US2] 跑 T020 / T021 测试,全绿

**Checkpoint**: US2 可独立 demo,store 出现 summary doc

---

## Phase 5: User Story 3 - 用户在 settings 看见并删除 memory(P2)

**目标**: 4 个 `withAuth` API 端点 + better-auth-ui Memory tab,Profile / Thread Summaries 两区块可删

**Independent Test**: 登录后访问 `/settings/memory`,看到 Profile 区块 k-v 行(有 "(from account)" / "(saved by you)" 标签)+ Thread Summaries 区块按 threadId 分组;点 Delete 调对应 API,行消失;新 thread 模型不再引用被删字段

### Tests(RED,rule #9 mock 模式)

- [ ] T028 [P] [US3] 在 `tests/api/memory/profile.get.test.ts` 写失败测试:GET 200(自己 user,有 profile + session + socialAccounts)+ GET 401(无 session)+ GET 500(store 抛错)
- [ ] T029 [P] [US3] 在 `tests/api/memory/profile.delete.test.ts` 写失败测试:DELETE 200 + `{ ok, deletedKey }` / 401 / 404(profile 不存在 / key 不在 profile 内)/ 400(key 不在 path regex 内,如 `..` / 空 key / 含 `/` 或 `%2F` 的 percent-encoded slash)/ 500(对应 FR-014 增补的字符集约束 `^[A-Za-z0-9_-]{1,64}$`)
- [ ] T030 [P] [US3] 在 `tests/api/memory/threads.get.test.ts` 写失败测试:GET 200 + `{ threads: [{ threadId, summaries }] }`,按 thread 分组 + `summaries` 按 sequence desc + groups 按 `updatedAt` desc / 401 / 500
- [ ] T031 [P] [US3] 在 `tests/api/memory/threads.delete.test.ts` 写失败测试:DELETE 200 + `{ ok, deletedCount }`,调 `store.batch` 多 delete op / 401 / 404(无 summaries)/ 500
- [ ] T032 [P] [US3] 在 `tests/components/settings/memory-view.test.tsx` 写渲染测试:有 profile + session 时,Profile 区块显示 session 字段(无 Delete 按钮)+ store 字段(有 Delete 按钮)+ 标签文字正确;有 summaries 时,Thread Summaries 区块按 threadId 分组,每 thread 一个 "Delete all" 按钮

### Implementation

- [ ] T033 [US3] 创建 `app/api/memory/profile/route.ts`:`export const GET = withAuth(...)` → `getProfileDoc(user.id)` + `auth.api.getSession({ headers: await headers() })` + `getSocialAccounts(user.id)` → 200 `ProfileResponse`
- [ ] T034 [US3] 创建 `app/api/memory/profile/[key]/route.ts`:`export const DELETE = withAuth<{ key: string }>(...)` → `decodeURIComponent` → key regex 校验 → `deleteProfileField(user.id, key)` → 200 / 404 / 400
- [ ] T035 [US3] 创建 `app/api/memory/threads/route.ts`:`export const GET = withAuth(...)` → `getAllUserSummaries(user.id)` → group + sort → 200 `ThreadsResponse`
- [ ] T036 [US3] 创建 `app/api/memory/threads/[threadId]/route.ts`:`export const DELETE = withAuth<{ threadId: string }>(...)` → `deleteThreadSummaries(user.id, threadId)` → 200 / 404
- [ ] T037 [US3] 跑 T028..T031 测试,全绿
- [ ] T038 [P] [US3] 在 `lib/memory/queries.ts` 补充 `getSocialAccounts(userId)`:drizzle `select({ provider: account.providerId }).from(account).where(eq(account.userId, userId))`,显式 select 避免泄漏其他字段(`research.md` D-004)
- [ ] T039 [US3] 修改 `global.d.ts`:`declare module "@better-auth-ui/core" { interface SettingsViewPaths { memory: string; } }`(`research.md` D-005)
- [ ] T040 [P] [US3] 创建 `components/settings/memory-view.tsx`:两个区块 —— Profile(从 `/api/memory/profile` fetch,k-v 行,Delete 按钮调 `DELETE /api/memory/profile/${encodeURIComponent(key)}`,session 字段标 "(from account)" 无按钮,store 字段标 "(saved by you)" 有按钮)/ Thread Summaries(从 `/api/memory/threads` fetch,按 threadId 分组,每 thread "Delete all" 调 `DELETE /api/memory/threads/${threadId}`)
- [ ] T041 [US3] 修改 `components/auth/auth-provider.tsx`:在 `AuthUIProvider` 的 `authPlugin` 对象(若已存在)或新建插件对象,加 `settingsTabs: [{ view: "memory", label: "Memory", component: MemoryView }]`(或框架要求的注册方式,见 `research.md` D-005 + better-auth-ui `settingsTab` 类型)
- [ ] T042 [US3] 跑 T032 渲染测试,全绿
- [ ] T043 [US3] Chrome DevTools MCP 视觉验证(rule #4):登录 → `/settings/memory` → 截图 Profile + Thread Summaries 两区块 → 点 Delete → 截图行消失 → 截图 thread 区块折叠

**Checkpoint**: US3 可独立 demo,Memory tab 上线

---

## Phase 6: User Story 4 - profile 自动包含 better-auth session + social(P2)

**目标**: middleware 实时拉 session / socialAccounts(已在 Phase 3 T015 / Phase 5 T038 实现),此 phase 只补端到端验证 + 改名测试

**Independent Test**: 用 GitHub 登录(本地 dev 注入 social account),thread 问「我绑了哪些 social 账号」,agent 回复提到 "github";在 better-auth UI 改名后开新 thread 问「我叫什么」,新名生效

### Tests(RED)

- [ ] T044 [P] [US4] 在 `tests/backend/middleware/with-memory-recall-integration.test.ts` 写失败测试:middleware 输出 system message 的 JSON 含 `session.email` / `session.name` / `socialAccounts: [{ provider: "github" }]`;**不含** `accountId` / `accessToken`(敏感字段防御,FR-020 / rule #9 衍生)
- [ ] T044b [P] [US4] 在 `tests/backend/middleware/with-memory-recall-integration.test.ts` 追加"session 实时性"测试:同一 middleware 实例连续 invoke 两次,第一次 mock `auth.api.getSession` 返回 `name="old"`,第二次 mock 返回 `name="new"`;断言两次系统消息里的 `session.name` 分别为 `"old"` / `"new"`(不是首次缓存)。验证 middleware 不缓存 session、session 字段实时从 better-auth 取(US4 Acceptance Scenarios step 3 关键证明)

### Implementation

- [ ] T045 [US4] 跑 T044 测试,确认全绿;若红则修 `getSocialAccounts` 的 select 字段集(确认 `provider: account.providerId`,无其它)
- [ ] T046 [US4] Chrome DevTools MCP 视觉验证(rule #4):用 social account 登录 → thread 问「我绑了哪些 social」→ 截图含 provider → 改名 → 新 thread 问「我叫什么」→ 截图新名

**Checkpoint**: US4 与 US1 / US3 共享实现,此 phase 仅做集成测试 + 视觉验证

---

## Phase 7: Polish & Cross-Cutting Concerns

**目标**: 文档同步(rule #1)、覆盖率核查、整体回归、commit

- [ ] T047 在 `docs/APIS.md` 新增 `## Memory` 章节,4 个 endpoint 每个一段:request shape / response shape / status codes / 错误类型(rule #1 强制,内容来源 `contracts/memory-api.md`)
- [ ] T048 在 `backend/store.ts` 顶部加注释:`store` 表由 `PostgresStore.setup()` 在启动时建,不走 `db/migrations/`(quickstart.md § 失败回滚已说明)
- [ ] T049 跑 `pnpm test` 全量,确认 `lib/memory/queries.ts` + `lib/memory/validators.ts` 覆盖率 ≥ 90%(rule #2),`app/api/memory/**` 全 status code 路径覆盖
- [ ] T050 跑 `pnpm lint && pnpm test`,全绿
- [ ] T051 按 logical unit 切 commit:① foundation(常量 + validators + queries + size guard)/ ② US1(tool + middleware + model + proxy 注入)/ ③ US2(state + node + agent graph + prompt)/ ④ US3(API + memory view + auth-provider 插件 + global.d.ts)/ ⑤ docs + polish。每个 commit 一行 English subject,带 scope,符合 CLAUDE.md commit rules;`git commit` 用 `commit:` slash
- [ ] T052 在 `CLAUDE.md` 的 `<!-- SPECKIT START -->` 与 `<!-- SPECKIT END -->` 之间,更新 plan 引用为 `specs/003-langgraph-store/plan.md`(可由 `speckit-agent-context-update` hook 自动跑;手动执行:读 `CLAUDE.md` 找标记段并替换)
- [ ] T053 整体回归:`pnpm dev` + Chrome DevTools MCP 走 quickstart.md § Scenario 1/2/3/4 四套,全部通过 → 勾选 quickstart.md 验收清单

**Checkpoint**: feature 完成,可开 PR

---

## Dependencies(完成顺序)

```
Phase 1 (Setup)
   └─→ Phase 2 (Foundational)
            ├─→ Phase 3 (US1: 跨 thread 续聊)   ← MVP,优先交付
            ├─→ Phase 4 (US2: Thread 摘要)
            ├─→ Phase 5 (US3: Settings 删除)
            │     └─→ Phase 6 (US4: social + rename 集成)
            └─→ Phase 7 (Polish)
```

Phase 3 / 4 / 5 之间**互相独立**(不阻塞),可按 MVP 节奏选 Phase 3 先交付,后续并行 PR。

---

## Parallel Execution(每 phase 内的 [P] 任务)

**Phase 2 并行组**:

```
并行 A: T003 + T004 + T005(不同测试文件)
并行 B: T006 → 串行 → T007 / T008 / T009(后者 [P])
```

**Phase 3 并行组**:

```
并行 A: T010 + T011 + T012(不同测试文件)
并行 B: T013 → 串行 → T014 → 串行 → T015 + T016 + T017(后三者 [P] 不同文件)
```

**Phase 5 并行组**:

```
并行 A: T028 + T029 + T030 + T031 + T032(不同测试文件,5 个一组)
并行 B: T033 → 串行 → T034 + T035 + T036([P])
并行 C: T038 + T039 + T040 + T042([P],不同文件)
```

## Implementation Strategy

### MVP Scope

仅 Phase 1 + Phase 2 + Phase 3(US1)即满足 spec 核心价值("跨 thread 续聊,agent 记得你说过什么")。US2 / US3 / US4 是 P1 / P2 的扩展价值。

### Incremental Delivery

每个 Phase 完成后跑一次 `pnpm test && pnpm lint`,commit 一次,合并到 feat/003-langgraph-store。三个 P1 / P2 独立可 review,降低单 PR review 负担。

### 不在 scope(spec § Out of Scope)

cross-thread memory / TTL / import-export / version history / cross-user sharing / semantic search / agent opt-out —— 全部砍掉,不在 tasks 里出现。
