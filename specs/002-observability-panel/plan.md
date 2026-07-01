# Implementation Plan: LangGraph Observability Panel

**Branch**: `002-observability-panel` | **Date**: 2026-07-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-observability-panel/spec.md`

## Summary

把 `backend/observability/callback-collector.ts` 已实现的 `CapturingHandler` 数据,从 `/tmp/captured-spans-*.json` 临时 dump 升级为生产级可观测面板:

- **存储**: 新建 Postgres `observability_spans` 表,`lib/observability/queries.ts` 提供 repository
- **DB 写入**: 借鉴 `renameThreadAgent` 的 `await query(threadId, payload)` 直写模式 — callback handler 内部 buffer spans,`handleChainEnd` 时 `await bulkInsert`(同 `renameThread` 在 graph 节点末尾调用的时机)
- **API**: `GET / DELETE /api/threads/[id]/observability`,`withAuth` + 越权返回 404
- **UI**: thread 头部 icon-only 按钮 + Sheet,fetch 拉到 CapturedSpan[] 后 transform → SpanData[]
- **安全**: 写入前 `JSON.stringify + grep` 敏感模式防御,spec FR-009 固化不存 `llm_kwargs`
- **retention**: 系统 cron + tsx 脚本,7 天物理删除(MVP 可延后)

## Technical Context

**Language/Version**: TypeScript 5.x / Node 22(项目固定)

**Primary Dependencies**:

- `drizzle-orm` + `drizzle-zod`(项目已用,threads/\* 同款)
- `@langchain/core` 1.2.x(已固定)
- `zod` 3.x(已固定)
- `better-auth`(已用,`withAuth` 复用)

**Storage**: PostgreSQL(项目已有 `db/client.ts` + `db/migrations/`)

**Testing**: Vitest(`pnpm test`)

**Target Platform**: Next.js 14 App Router + LangGraph dev server(`pnpm dev`)

**Project Type**: Web application(frontend + backend in monorepo)

**Performance Goals**:

- 单 invoke 写入 100 spans 的 bulkInsert < 100ms
- GET 100 spans < 20ms
- 面板从点击到显示 < 3s(P95)

**Constraints**:

- callback handler 写入不能阻塞 graph.invoke > 50ms
- 敏感字段(api_key / baseURL / Bearer / sk-)在 DB 全文搜索 0 命中
- 跨用户 thread_id 访问必须 404(不暴露存在性)

**Scale/Scope**:

- 单 thread 50-200 spans
- 7 天 retention,峰值 ~100K spans
- 多 worker 支持(spec 已纳入)

## Constitution Check

_GATE: 必须通过才能进入 Phase 0 research。Phase 1 设计后再校验一次。_

| 原则                    | 状态 | 备注                                                                                                    |
| ----------------------- | ---- | ------------------------------------------------------------------------------------------------------- |
| 一、规格/代码/文档同步  | ✅   | spec + plan + contracts + quickstart 全部生成;route handler 落地时同步 `docs/OBSERVABILITY.md`(rule #1) |
| 二、测试先行            | ✅   | FR-011 强制:queries ≥90%,route handlers 100%,callback-collector 全覆盖                                  |
| 三、首选标准方案        | ✅   | Drizzle ORM + Zod + better-auth 全是项目内已有方案,无新依赖                                             |
| 四、UI 改动必须视觉验证 | ✅   | thread header icon button + Sheet 在 plan 阶段标 TODO:`pnpm dev` + Chrome DevTools MCP 验证             |
| 五、注释克制            | ✅   | `ponytail:` 注释仅在 DB 写入策略(retention 上限、bulkInsert 风险)处使用                                 |
| 六、Spec-kit 中文输出   | ✅   | spec/plan/research/data-model/quickstart/contracts 全部中文,代码 / SQL / commit message 保持英文        |

无违规,无需 Complexity Tracking。

## Project Structure

### Documentation (this feature)

```text
specs/002-observability-panel/
├── plan.md              # 本文件
├── research.md          # Phase 0 输出
├── data-model.md        # Phase 1 输出
├── quickstart.md        # Phase 1 输出
├── contracts/
│   └── observability.md # Phase 1 输出
├── spec.md              # spec-kit 早期产出
├── checklists/
│   └── requirements.md  # spec-kit 早期产出
└── tasks.md             # Phase 2 输出(/speckit-tasks)
```

### Source Code (repository root)

新增 / 修改路径:

```text
backend/
├── observability/
│   └── callback-collector.ts          # 已有 — 加 bulkInsert 调用
├── model.ts                          # 加 .withConfig({ callbacks: [getCapturingHandler()] })
└── node/
    └── (无新增 — CapturingHandler 在 model 入口捕获)

lib/
├── observability/
│   ├── schema.ts                     # Drizzle table 定义
│   ├── queries.ts                    # bulkInsertSpans / getSpansByThreadId / markRunningAsFailed / deleteSpansByThreadId
│   ├── validators.ts                 # Zod schemas
│   └── transform.ts                  # CapturedSpan[] → SpanData[] 转换(从 components/assistant-ui/captured-to-span-data.ts 搬过来)
├── threads/
│   └── (已有 — 不动)

app/
├── api/threads/
│   └── [id]/observability/route.ts   # GET / DELETE handler
├── observability-preview/page.tsx    # 删除(Phase 2 末)
└── (无新增 page)

components/
├── assistant-ui/
│   ├── observability-panel.tsx       # 已有,不动
│   ├── observability-button.tsx      # 新 — icon-only 按钮
│   ├── observability-sheet.tsx       # 新 — Sheet 包 ObservabilityPanel,fetch 数据
│   ├── captured-to-span-data.ts      # 删除(搬到 lib/observability/transform.ts)
│   ├── captured-panels.client.tsx    # 删除(只服务 preview)
│   ├── thread.tsx                    # 加 observability-button
│   └── mock-spans.ts                 # 已有,不动

db/
├── client.ts                         # 已有 — lib/observability/queries.ts 复用
├── schema.ts                         # 已有 — 加 observabilitySpans re-export? 不,放到 lib/observability/schema.ts
└── migrations/
    └── NNNN_observability_spans.sql   # 新生成

scripts/
└── retention.ts                      # 新 — 按 OBSERVABILITY_RETENTION_DAYS 物理删除 cron 入口(MVP 可延后)

tests/
├── backend/observability/
│   └── callback-collector.test.ts    # 已有测试 + 加 bulkInsert 路径
├── lib/observability/
│   └── queries.test.ts               # 新 — ≥90% 覆盖率
└── api/threads/
    └── observability.test.ts         # 新 — 200/401/404 各路径

docs/
└── OBSERVABILITY.md                  # 新 — endpoint + 字段 + 安全 + retention
```

**Structure Decision**: 单项目 monorepo(Option 1)。backend + frontend 共用同一 repo,pnpm workspace 管理。

## 实施顺序(Phase 2 → tasks)

1. **Schema + Migration**: `lib/observability/schema.ts` + `pnpm db:generate` → review SQL → `pnpm db:migrate`
2. **Queries + Tests** (TDD): `tests/lib/observability/queries.test.ts` → 红 → `lib/observability/queries.ts` → 绿
3. **Wire CapturingHandler**: `backend/model.ts` `.withConfig({ callbacks: [getCapturingHandler()] })`;`callback-collector.ts` 在 `handleChainEnd` 加 `await bulkInsertSpans(...)`
4. **API + Tests** (TDD): `tests/api/threads/observability.test.ts` → 红 → `app/api/threads/[id]/observability/route.ts` → 绿(响应含 `retention_days`)
5. **Transform 搬迁**: `components/assistant-ui/captured-to-span-data.ts` → `lib/observability/transform.ts`,引用方跟着改
6. **UI**: `components/assistant-ui/observability-button.tsx` + `observability-sheet.tsx`(顶部 banner 显示 retention 信息),thread.tsx 挂按钮
7. **删除 dev-only**: `app/observability-preview/page.tsx` + `components/assistant-ui/captured-panels.client.tsx`
8. **Docs**: `docs/OBSERVABILITY.md`(rule #1 — 端点 / 字段 / 安全 / retention 配置)
9. **Retention 脚本**(MVP 可延后): `scripts/retention.ts` 读 `OBSERVABILITY_RETENTION_DAYS` → DELETE WHERE created_at < now() - N days → 系统 cron

## Complexity Tracking

无 Constitution 违规,无 Complexity Tracking 条目。

## 已固化决策(从 research.md 摘要)

| 决策           | 选择                                                                          |
| -------------- | ----------------------------------------------------------------------------- |
| 写入策略       | buffer + bulkInsert on chainEnd(参考 renameThreadAgent「await → 副作用」时机) |
| thread_id 来源 | `metadata.langgraph_thread_id`(LC 自动填)                                     |
| parent chain   | backend 算,前端信任                                                           |
| retention      | env `OBSERVABILITY_RETENTION_DAYS`(默认 30)+ 系统 cron + tsx(MVP 可延后)      |
| 入口位置       | thread header 右侧 icon-only(rule #8 允许)                                    |
| 安全防御       | insertSpan 内 stringify + regex grep                                          |
| 并发           | PK 幂等(`ON CONFLICT DO NOTHING`)                                             |
