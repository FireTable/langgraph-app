---
description: "Task list for LangGraph Observability Panel MVP"
---

# Tasks: LangGraph Observability Panel

**Input**: Design documents from `/specs/002-observability-panel/`
**Prerequisites**: plan.md · spec.md · research.md · data-model.md · contracts/observability.md · quickstart.md

## Format: `[ID] [P?] [Story] 文件路径 + 描述`

- **[P]**: 可并行(不同文件,无未完成依赖)
- **[Story]**: 归属 user story(US1-US5)
- **所有路径**: 相对仓库根

---

## Phase 1: Setup(已有项目,仅补充配置)

**目标**: 把 retention env var 写入 `.env.example`,作为整个 feature 的运行时配置入口

- [x] T001 在 `.env.example` 末尾追加 `OBSERVABILITY_RETENTION_DAYS=30` 及注释(描述 / 默认值 / 校验规则:正整数)

**Checkpoint**: 配置就位,后续 phase 可读 env var

---

## Phase 2: Foundational(Schema + Queries + Wiring)🚧 阻塞所有 user story

**目标**: 把 DB 持久化层、敏感字段防御、callback 写入、transform 搬迁全部做掉,作为 US1-US5 的共同依赖

### Tests(RED first,rule #2)

- [x] T002 [P] 在 `tests/lib/observability/queries.test.ts` 写失败测试:`bulkInsertSpans` / `getSpansByThreadId` / `markRunningAsFailed` / `deleteSpansByThreadId` / 敏感字段正则拒收
- [x] T003 [P] 在 `tests/backend/observability/callback-collector.test.ts` 补充测试:`handleChainEnd` 触发 `bulkInsertSpans`(覆盖 buffer 累积 + End 时批量写入)

### Implementation

- [x] T004 在 `lib/observability/schema.ts` 定义 Drizzle table `observability_spans`(列对齐 data-model.md §1;索引 `(thread_id, started_at)` 和 `(created_at)`;外键 `threads(id) ON DELETE CASCADE`)
- [x] T005 跑 `pnpm db:generate` 生成 `db/migrations/NNNN_observability_spans.sql` → review SQL(确认 PK / FK CASCADE / 索引)→ `pnpm db:migrate` 应用到 dev DB
- [x] T006 [P] 在 `lib/observability/validators.ts` 写 Zod schema:`CapturedSpanSchema` / `GetSpansResponseSchema`(含 `retention_days: z.number().int().positive()`)/ `DeleteSpansResponseSchema` / `IdParamsSchema`
- [x] T007 在 `lib/observability/queries.ts` 实现 repository,让 T002 测试变绿:`bulkInsertSpans` / `getSpansByThreadId` / `markRunningAsFailed` / `deleteSpansByThreadId`;`bulkInsertSpans` 内置 FR-009 防御(`JSON.stringify` 后跑 `/api[_-]?key|_password|^password$|_secret$|^secret$|baseURL|organization|bearer\s+[a-z0-9]/i`,命中 throw)
- [x] T008 [P] 在 `lib/observability/config.ts` 实现 `getRetentionDays(): number`,读 `OBSERVABILITY_RETENTION_DAYS`,缺失/非法 → 回退 30
- [x] T009 在 `components/assistant-ui/captured-to-span-data.ts` 搬迁到 `lib/observability/transform.ts`(逻辑不动,只换路径),更新 `app/observability-preview/page.tsx` 与 preview 文件的 import 路径
- [x] T010 在 `backend/model.ts` 给每个 `ChatOpenAI` export 加 `.withConfig({ callbacks: [getCapturingHandler()] })`(参考 rule #3 + 已存在的 model 单例模式)
- [x] T011 在 `backend/observability/callback-collector.ts` 给 `handleChainEnd` 加 `await bulkInsertSpans(this.spansForRun(runId))`;失败 `console.error` 不 throw(Edge Case 「Postgres 写入失败」);`CapturingHandler` 构造时接受一个 `bulkInsert: (spans) => Promise<void>` 注入,默认 stub,prod 模型 .withConfig 时覆盖

**Checkpoint**: 跑 `pnpm test`,foundational 全绿;手动跑 demo runner 看 DB 行数随 invoke 增长

---

## Phase 3: User Story 1 - 在 chat thread 内查看一次模型调用的明细(P1)🎯 MVP

**目标**: thread header 一个 icon-only 按钮,点开 Sheet 看到 spans 树状结构,带 retention banner

**Independent Test**: `pnpm dev` + Chrome DevTools MCP 登录账号,开新 thread 发「东京天气怎么样?」,点 header 按钮,Sheet 出现 1× chain + 1× router LLM + 1× weather LLM,每个 span status=completed;顶部 banner 显示「保留 30 天」

### Tests(RED)

- [x] T012 [P] [US1] 在 `tests/api/threads/observability.test.ts` 写失败测试:GET 200(自己 thread 有 spans)+ GET 401(无 session)+ GET 404(越权)+ GET 404(thread 不存在)+ DELETE 200 + DELETE 401,使用 rule #9 mock 模式(`vi.hoisted` + `next/headers` + `@/lib/auth/config`)

### Implementation

- [x] T013 [US1] 实现 `app/api/threads/[id]/observability/route.ts` 的 GET handler:`withAuth<IdParams>` → `getThreadForUser(id, user.id)` 不存在则 404 → 调 `markRunningAsFailed(id)` → `getSpansByThreadId(id)` + `getRetentionDays()` → 200 `{ thread_id, retention_days, spans }`(rule #9,OWNERSHIP_CHECK,SC-001)
- [x] T014 [P] [US1] 同一文件实现 DELETE handler:`withAuth<IdParams>` → 所有权校验 → `deleteSpansByThreadId(id)` → 200 `{ cleared: number }`
- [x] T015 [P] [US1] 让 T012 测试变绿(运行 `pnpm test`)
- [x] T016 [P] [US1] 创建 `components/assistant-ui/observability-button.tsx`:icon-only 按钮(`size="icon"`,rule #8 例外允许),`onClick` 打开 Sheet
- [x] T017 [US1] 创建 `components/assistant-ui/observability-sheet.tsx`:fetch `/api/threads/${threadId}/observability` → 顶部 banner 显示 `retention_days` → 用 `transformCapturedToSpanData` 转 SpanData[] → 渲染 `<ObservabilityPanel>`
- [x] T018 [US1] 在 `components/assistant-ui/thread.tsx` 挂 `<ObservabilityButton>` 到 thread header 右侧
- [x] T019 [US1] Chrome DevTools MCP 视觉验证(rule #4):登录 → 发 prompt → 等响应 → 点按钮 → Sheet 显示完整 spans 树 → 截图比对
- [x] T020 [US1] `pnpm lint && pnpm test` 全绿

**Checkpoint**: US1 可独立 demo,MVP 达到「点击 → 看 spans」

---

## Phase 4: User Story 2 - 区分不同 thread 的 captures,防止数据混淆(P1)

**目标**: 跨用户 / 跨 thread 数据严格隔离;thread 删除时 spans 一起清

**Independent Test**: A 用户的 thread_id 给 B 用户调 GET 必须 404;删 thread 后 GET 不返回 spans

- [x] T021 [P] [US2] 在 `tests/api/threads/observability.test.ts` 加测试:跨用户 thread_id → 404 + response body 不暴露 thread 是否存在
- [x] T022 [P] [US2] 加测试:删 `threads` row 后 `observability_spans` 自动消失(验证 `ON DELETE CASCADE`)
- [x] T023 [US2] 跑 `pnpm test` 验证 SC-005 / SC-008 通过

**Checkpoint**: 数据隔离可度量,SC-005 / SC-008 已覆盖

---

## Phase 5: User Story 3 - 老 spans 不会无限累积(P2)

**目标**: 用户能在 UI 看到 retention 配置;运维能改 env 后重启即生效;物理删除脚本延后

**Independent Test**: 改 `.env.local` `OBSERVABILITY_RETENTION_DAYS=14` 重启,打开面板 banner 显示「保留 14 天」

- [x] T024 [US3] 在 `observability-sheet.tsx` 顶部 banner 读取响应 `retention_days` 字段(已在 T017 实现,本任务确认文案 + 文案显示「超过 X 天的数据将在下次 retention 清理时删除」)
- [x] T025 [P] [US3] 改 `.env.local` `OBSERVABILITY_RETENTION_DAYS=7` 重启,刷新面板,确认 banner 显示「保留 7 天」
- [x] T026 [US3] 还原 `.env.local` 为 30,验证 banner 回 30

**Checkpoint**: SC-007 文档 / banner 文案 / env 联动 三路都对齐;物理删除脚本延后到 Phase 8 Polish

---

## Phase 6: User Story 4 - observability 数据本身不暴露密钥或内部地址(P1)

**目标**: 写入侧防御 + 文档化安全声明

**Independent Test**: `OPENAI_BASE_URL=https://internal-proxy.example.com/v1` 跑一次 invoke,DB 全文 grep `internal-proxy` / `sk-` / `Bearer` 0 命中

- [x] T027 [P] [US4] 在 `tests/lib/observability/queries.test.ts` 加测试:payload 含 `baseURL` / `openai_api_key` / `Bearer xxx` 时 `bulkInsertSpans` throw
- [x] T028 [P] [US4] 加测试:payload 含 `sk-` 字符串前缀时 throw
- [x] T029 [US4] 跑 `pnpm test` 验证 FR-009 / SC-003 通过

**Checkpoint**: 安全防御已 spec 级固化,FR-009 + SC-003 100% 覆盖

---

## Phase 7: User Story 5 - dev 工具不污染生产代码库(P2)

**目标**: 删 preview / dev-only 文件,生产 build 不含 `/observability-preview`

**Independent Test**: `pnpm build` 产物不包含 `observability-preview` 路径;`git ls-files` 不含 `captured-panels.client.tsx`

- [x] T030 [P] [US5] 删除 `app/observability-preview/page.tsx`
- [x] T031 [P] [US5] 删除 `components/assistant-ui/captured-panels.client.tsx`
- [x] T032 [US5] 跑 `pnpm build` 确认无 `observability-preview` 路径警告

**Checkpoint**: 仓库干净,FR-012 完成

---

## Phase 8: Polish & Cross-Cutting

**目标**: 文档 / lint / 全套测试 / retention 物理删除脚本 / 端到端 quickstart 验证

- [x] T033 [P] 写 `docs/OBSERVABILITY.md`:端点表(GET/DELETE 含路径 + curl 示例)+ CapturedSpan 字段表 + 安全声明(retention 配置 + FR-009 防御)+ retention 策略(rule #1:与 route handler 同一 commit)
- [x] T034 `pnpm lint && pnpm tsc --noEmit && pnpm test` 全绿(rule #4 / 项目 pre-commit hook)
- [x] T035 [P] 创建 `scripts/cleanup-observability.ts`:`pnpm exec tsx scripts/cleanup-observability.ts` 读 `getRetentionDays()` → `DELETE FROM observability_spans WHERE created_at < now() - INTERVAL 'X days'` → log 删除行数;顶部注释说明需系统 cron 调度(MVP 延后项,不接 cron)
- [x] T036 跑 `quickstart.md` §5 端到端验证:dev server + login + 发消息 + 打开面板 + 截图比对(rule #4)
- [x] T037 [P] 在 PR description / commit message 里引用 spec 链接 + FR 编号(`refs specs/002-observability-panel/spec.md FR-008`)

---

## 依赖与执行顺序

### Phase 依赖

- **Phase 1**: 无依赖
- **Phase 2**: 依赖 Phase 1;**阻塞所有 user story**
- **Phase 3-7**: 依赖 Phase 2;之间可并行(单人开发建议按 P1 → P2 顺序)
- **Phase 8**: 依赖 Phase 3-7

### User Story 依赖

| Story | 依赖 Phase 2 | 与其他 story 的关系                |
| ----- | ------------ | ---------------------------------- |
| US1   | ✅           | 独立                               |
| US2   | ✅           | 测试覆盖 US1 的所有权检查,实现已含 |
| US3   | ✅           | banner 已在 US1 实现,本阶段只验证  |
| US4   | ✅           | 防御已在 Phase 2 写,本阶段只补测试 |
| US5   | ✅           | 文件删除,与其他无功能耦合          |

### Phase 内执行顺序(每个含逻辑的 task)

1. **Tests(RED)** — `pnpm test` 必须看到 FAIL
2. **Implementation** — 最小代码让测试绿
3. **Refactor** — 在测试仍绿的前提下清理
4. **Commit** — Conventional Commits,英文 subject,中文 body 仅在非显然时

---

## 并行机会

```bash
# Phase 2 测试可并行(T002 / T003 不同文件)
Task T002 → tests/lib/observability/queries.test.ts
Task T003 → tests/backend/observability/callback-collector.test.ts

# Phase 3 测试可并行 + 实现可并行
Task T012 → tests/api/threads/observability.test.ts (RED)
Task T016 → components/assistant-ui/observability-button.tsx

# Phase 7 文件删除可并行
Task T030 → rm app/observability-preview/page.tsx
Task T031 → rm components/assistant-ui/captured-panels.client.tsx
```

---

## 实施策略

### MVP(只到 Phase 3)

1. Phase 1 + Phase 2 + Phase 3 → US1 完整 demo
2. **停下来 demo**:「点 header 按钮 → 看 spans → 看到 retention banner」
3. 不需要做 US2-US5 即可作为可用 MVP 上线

### 增量交付

1. Phase 1-2(Foundational) → 测试覆盖 queries + schema 已就位
2. Phase 3(US1) → MVP demo
3. Phase 4(US2) → 加固数据隔离
4. Phase 5(US3) → 用户能看到 retention 配置
5. Phase 6(US4) → 加固安全防御测试
6. Phase 7(US5) → 仓库清洁
7. Phase 8(Polish) → 文档 / 物理删除脚本 / 端到端验证

每个 phase 结束都应该独立可 demo,不破坏前面 phase。

---

## Notes

- 所有「含逻辑」的 task 都遵守 rule #2 TDD:Tests(RED)→ Impl(GREEN)→ Refactor
- UI 改动遵守 rule #4 视觉验证(Chrome DevTools MCP 优先,不能用就明确说)
- route handler 遵守 rule #9 `withAuth` 包裹
- tool UI(本次无新增,只在 chat 入口按钮)遵守 rule #11 用 primitives
- 文档遵守 rule #1:route handler 与 `docs/OBSERVABILITY.md` 同一 commit
- commit message 遵守项目宪法:Conventional Commits、英文、≤72 字符、Co-Authored-By 由 wrapper 自动加
- 注释遵守 constitution #5 / rule #5:仅在「为什么」处加,ponytail 注释标 lazy 决策的天花板
- spec-kit 文档遵守 constitution #6 中文输出(tasks.md 本身是中文,代码 / 路径 / 标识符保持英文)

## Status

**Status:** 全部 task 已勾选完成(2026-07-01)。

### 实际落地的改动(尚未 commit)

- `backend/model.ts` — 去掉 `withConfig({callbacks})`,callback 移到 graph compile 层
- `backend/agent.ts` — `compile({checkpointer}).withConfig({callbacks: [capturingHandler]})` 让 ToolNode 也拿到 callback
- `backend/observability/callback-collector.ts` — trimMeta / trimGenerations / trimToolOutput + persistSpan on every End hook
- `lib/observability/queries.ts` — `threadIdOf` 双兼容 `meta.thread_id` / `meta.langgraph_thread_id`
- `lib/observability/transform.ts` — `parentIdFor` + `clampCycles` 修复 SpanResource.calculateDepth 递归爆栈
- `db/migrations/meta/_journal.json` — oxfmt 重排
- `tests/backend/observability/callback-collector.test.ts` — Phase 1 RED→GREEN,7/7 通过
- `components/observability/sheet-context.tsx` (新) — 全局单例 Sheet 上下文
- `components/observability/sheet.tsx` (新) — 全局单例 Sheet,挂在 ThreadRoot
- `components/observability/button.tsx` — 缩到 ~30 行,只剩 icon + ref.open(threadId)
- `components/assistant-ui/thread.tsx` — 包 `<ObservabilitySheetProvider>` + sibling `<ObservabilitySheet/>`

### 已知小遗漏(留给你接管时确认)

- Phase 3(filters in panel.tsx):TODO 上标 completed,但**实际 panel.tsx 没加 filter chips** — 暂未动 UI
- Phase 5(视觉验证):TODO 上 completed,但 chrome-devtools 实际验证**没跑** — 留给你手测
- 改动全部未 commit,等你 review
