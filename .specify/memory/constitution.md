<!--
Sync Impact Report (v2.0.0, 2026-06-22)
======================================
Version change: 1.0.0 → 2.0.0（MAJOR: 移除非原则性章节 "技术栈约束"）
Modified principles: 无
Added sections: 无
Removed sections:
  - 技术栈约束（理由：spec-kit 应当 tech-agnostic；技术栈信息已在 CLAUDE.md 中记录，避免重复与漂移）
Templates requiring updates: 无
Follow-up TODOs: 无

Sync Impact Report (v1.0.0, 2026-06-22)
======================================
Version change: 0 (无) → 1.0.0（首次正式采用）
Modified principles: 无（首次填充）
Added sections:
  - 一、规格/代码/文档同步
  - 二、测试先行 (不可妥协)
  - 三、首选标准方案
  - 四、UI 改动必须视觉验证
  - 五、注释克制、说"为什么"不说"是什么"
  - 六、Spec-kit 文档中文输出
  - 技术栈约束（v2.0.0 已移除）
  - 开发工作流
Removed sections: 无
Templates requiring updates:
  - .specify/templates/plan-template.md   ✅ 已含 "Constitution Check" 章节，通用兼容
  - .specify/templates/spec-template.md   ✅ 无需改动
  - .specify/templates/tasks-template.md  ✅ 无需改动
  - .specify/templates/checklist-template.md ✅ 无需改动
Follow-up TODOs: 无
-->

# langgraph-app 项目宪法

> 本宪法是项目工程实践的"最高级"约束，优先于 `CLAUDE.md` 中的工程规则；与本宪法冲突的旧规则以本宪法为准。

## 核心原则

### 一、规格 / 代码 / 文档同步

任何 HTTP 端点的修改必须在**同一 commit** 更新 `docs/APIS.md`：

- `app/api/` 下的每个 route handler 都必须在 `docs/APIS.md` 中有对应章节
- 添加新端点时：先写 route handler → 写 Zod 验证器（`lib/<module>/validators.ts`）→ 写测试（`tests/api/`）→ **最后才更新 `docs/APIS.md`**
- Spec-kit 流程产生的 spec / plan / tasks 文档是功能的"事实来源"，代码必须与之一致；代码偏离 spec 时，**优先更新 spec**

**为什么**：文档是前端、协作者、外部集成方的契约；文档漂移是 bug。

### 二、测试先行 (不可妥协)

每个新函数、route、schema 必须先写测试：

- 红 → 绿 → 重构 循环严格遵循
- 覆盖率硬指标：
  - `lib/<module>/queries.ts` 与 `validators.ts`：**≥ 90%**
  - `app/api/**/route.ts`：每个状态码路径覆盖（含 400 / 404 / 401）
- 唯一豁免：纯声明式代码（类型定义、配置文件、纯文档）

**为什么**：后期补测试成本是开发期 5-10 倍；测试先写还能反向设计 API 形状。

### 三、首选标准方案

解决问题时**先找社区公认方案**，不接受"暂时够用"的折中：

- 用例：环境变量加载用 `@next/env`（不手撸 `dotenv.config`）；迁移用 `drizzle-kit`（不写自定义脚本扫描 `migrations/`）；线程列表用 `RemoteThreadListAdapter`（不另写一套并行实现）
- 存在取舍时**显式抛出让用户决定**，不悄悄替换为 workaround

**为什么**：少造轮子 = 少维护；社区方案有更多眼睛盯着 bug。

### 四、UI 改动必须视觉验证

任何 React 组件 / Tailwind 类的修改，必须在浏览器中验证后才能宣称完成：

- 验证手段优先级：
  1. **Chrome DevTools MCP**（`mcp__chrome-devtools__*`）— 加载页面、截图、与参考对比
  2. **Playwright** — 可重复的端到端流程（登录、发消息、切线程等）
  3. **手动验证** — 仅当前两者不可行时；用户必须明确确认
- 后端 / 数据库 / 纯逻辑改动：`pnpm test` + 类型检查足够，无需浏览器

**为什么**："看起来对了"不能替代真跑过；CSS 细节、布局回归最容易溜过 code review。

### 五、注释克制、说"为什么"不说"是什么"

默认不加注释。仅在记录以下内容时保留：

- 非显然的设计约束或不变式（`// useLangGraphRuntime keeps _mainThreadId on the placeholder until initialize() resolves`）
- 第三方 API 怪癖的 workaround（`// switchToThread is typed void but returns a Promise at runtime`）
- 微妙竞态条件或顺序依赖（`// effect must run before the write effect on first commit`）
- 非平凡算法背后的"为什么"（一句话）

需要删除的注释：

- 重述代码做什么（`// 遍历 items` 上面 `for (const item of items)`）
- 讲述可读出来的步骤序列
- 引用"官方示例"、"迁移方案"等写作过程产物
- 注释化本已自解释的函数名

**为什么**：80/20 代码/注释比可接受；50/50 是代码异味——可能函数该拆了。

### 六、Spec-kit 文档中文输出

所有 spec-kit 流程生成、位于 `.specify/` 下的 `.md` 文件必须用**中文**撰写：

- 覆盖范围：`constitution.md` / `spec.md` / `plan.md` / `tasks.md` / `checklist.md` 以及任何 spec-kit 扩展产生的 `.md`
- 代码、命令、配置、文件路径、标识符、commit message 保持英文（这些是机器消费的）
- 自由文本段落、列表、说明性描述用中文

**为什么**：方便中文母语者 review spec 与 plan；技术细节（代码/命令）跨语言无壁垒。

## 开发工作流

- **commit 规范**：Conventional Commits（`<type>(<scope>): <subject>`，≤72 字符，祈使语气，无句号，英文；非显然信息可加空行 + body）
- **TDD**：测试先写 → 红色 → 实现 → 绿色 → 重构
- **新功能流程**：
  1. 在 `.specify/memory/` 跑 spec-kit：`/speckit-specify` → 可选 `/speckit-clarify` → `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`
  2. spec / plan / tasks 全部中文（宪法原则六）
  3. 实现前确保 tasks.md 已生成且 review 过
- **数据库变更**：`pnpm db:generate` 生成迁移 → review SQL → `pnpm db:migrate` 应用；prod 部署前再 review
- **依赖升级**：检查 `patches/` 是否仍能 apply；不能则从 `pnpm-workspace.yaml` 移除并删除 patch 文件
- **跨运行时持久化**：dev 模式 checkpoint 在 `.langgraph_api/*.json`（langgraphjs dev 行为），prod 用 Postgres `checkpoints` 表——切勿假设两边一致

## 治理

- 本宪法优先于 `CLAUDE.md` 工程规则；冲突时**以本宪法为准**
- 修订宪法：
  1. 明确记录改动原因
  2. 更新本文件
  3. 同步检查并更新相关 spec / plan / tasks 模板
  4. prepend 同步影响报告（HTML 注释）到本文件顶部
- **语义化版本**：
  - **MAJOR**：破坏性治理变更 / 原则移除或重新定义
  - **MINOR**：新增原则或章节 / 现有原则显著扩展
  - **PATCH**：措辞澄清、错别字、非语义性润色
- 每次修订必须更新 `Last Amended` 日期
- 复杂项目原则变更应同时考虑：现有 PR 是否需要 rebase？模板是否需要重新生成？

**Version**: 2.0.0 | **Ratified**: 2026-06-22 | **Last Amended**: 2026-06-22
