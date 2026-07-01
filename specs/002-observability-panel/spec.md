# Feature Specification: LangGraph Observability Panel

**Feature Branch**: `002-observability-panel`

**Created**: 2026-07-01

**Status**: Draft

**Input**: User description: "按照已有的上下文, 总结这个 spec, 包含写文档/代码实现/测试"

> 已有上下文摘要(用于本次 spec 起草):
>
> - 后端 `backend/observability/callback-collector.ts` 已经实现 `CapturingHandler`(覆盖 LLM/Chat/Tool/Chain/Retriever 五种 callback,4 种 LC message 形态 unwrap,从 `langgraph_checkpoint_ns` 推导 parent chain)
> - 前端 `components/assistant-ui/observability-panel.tsx`、`captured-to-span-data.ts`、`mock-spans.ts` 已经实现 panel 渲染和从 CapturedSpan → SpanData 的转换
> - Preview 页面 `app/observability-preview/` 仅从 `/tmp/captured-spans-*.json` 读盘,未挂进生产链路
> - 上一轮 5-phase 计划已在前文给出: wire + 单例、API、chat 入口、LRU + 测试、文档
> - 已确认 `llm_kwargs` 不再 capture(baseURL / api_key 泄漏,commit 211d133)
> - Turn 边界(同 thread 多 turn 划分)暂列为 MVP+1

## Clarifications

### Session 2026-07-01

- Q: 观测数据存哪里? → A: PostgreSQL,新建 `observability_spans` 表(覆盖原来的内存桶设计)
- Q: 接口路径如何组织? → A: 嵌套在 thread 之下,形式为 `/api/threads/[id]/observability`(`:id` 即 thread_id)

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 在 chat thread 内查看一次模型调用的明细 (Priority: P1)

作为开发者/调试者,我在 chat 界面发了一条 prompt 触发了 router + 模型 + (可选)工具调用,我希望在 thread 内的某个入口点开面板,看到这次对话生成了哪些 span、它们的耗时、嵌套关系、token 用量、每条 LLM 消息的 unwrap 后内容。

**Why this priority**: 这是整个 observability 功能的核心交付物——把已经能跑的 `CapturingHandler` 数据真正送到用户眼前。P1 是因为没有这一条,前面 6 个 commit 写的回调采集器对用户完全不可见,价值归零。

**Independent Test**: 启动 dev server(`pnpm dev`),登录账号,开一个新 thread,发一条会触发 router 的 prompt(如 "东京天气怎么样"),等待模型回复完成,在 thread 头部点 observability 入口图标,Sheet 打开后能看到至少: 1 个 chain span(`graph.invoke`)、1 个 router 的 LLM span、1 个 weatherAgent 的 LLM span(如果命中 weather 子图)。每个 span 显示 status(completed)、duration、模型名。

**Acceptance Scenarios**:

1. **Given** 用户已登录且在 thread 中发过至少一条 prompt, **When** 点击 thread 头部的 observability 入口按钮, **Then** Sheet 打开,显示与该 thread_id 关联的所有 CapturedSpan,按 step 顺序排列,每条 status 为 completed(非 running)
2. **Given** 面板已打开且显示了 spans, **When** 展开某个 LLM span 的详情, **Then** 能看到 model 名、token 用量、prompt 文本、assistant 回复文本
3. **Given** LLM span 的 `meta.langgraph_checkpoint_ns` 是嵌套结构, **When** 前端做 parent 推导, **Then** 同 thread 内的多 sub-flow 节点能正确形成树状父子关系(而非平铺),USE_SUBGRAPH=true / false 两种拓扑都成立
4. **Given** 用户打开面板时 invoke 仍在进行(尚未 complete), **When** 看到状态为 running 的 span, **Then** 面板在用户停留期间每 N 秒拉取一次更新,或显示明确的 "in-flight" 提示(不会无限显示 running)

---

### User Story 2 - 区分不同 thread 的 captures,防止数据混淆 (Priority: P1)

作为多任务开发者,我同时开着 3 个 thread 分别调试不同 prompt,每个 thread 内的 observability 面板必须只展示本 thread 的 spans,不能串台。

**Why this priority**: 数据归属错乱是不可接受的 bug,跟「根本看不到」是同等优先级的事故。P1。

**Independent Test**: 开 2 个 thread,A thread 发 "北京天气",B thread 发 "BTC 价格";两个 thread 都各自打开 observability 面板;A 面板里只看到 weather 相关的 spans,B 面板里只看到 crypto 相关的 spans。

**Acceptance Scenarios**:

1. **Given** 用户开了两个 thread A 和 B 并各自触发了不同 agent, **When** 在 A 的面板里查看 spans, **Then** 看不到任何来自 B 的 span(无 cross-contamination,spans 通过 `thread_id` 列分区存储在 Postgres `observability_spans` 表)
2. **Given** 用户的某个 thread 被删除或关闭, **When** retention 触发淘汰(或用户显式 `DELETE /api/threads/:id/observability`), **Then** 被淘汰的 spans 从 DB 消失,不会通过 API 被重新拉到

---

### User Story 3 - 老 spans 不会无限累积 (Priority: P2)

作为长时间挂着 dev server 调试的开发者,跑了十几轮不同 thread 后,DB 里的 spans 应该按 retention 规则自动清理,不会无限增长。

**Why this priority**: 不是首版必须,但是工程上的基本卫生。P2 是因为 MVP 第一版上线如果只跑 1-2 个 thread 不会触发,但跑半天就触发,排查起来很痛苦。

**Independent Test**: 连续创建 25 个不同 thread_id 并各触发一次 graph.invoke,确认老 thread 的 spans 在 retention 触发后从 DB 消失(不依赖人工 DELETE)。改 `OBSERVABILITY_RETENTION_DAYS` 后,新保留期生效;面板 UI 显示当前 retention 与预计下次清理时间。

**Acceptance Scenarios**:

1. **Given** DB 里已有超过保留期(默认 30 天,可由 `OBSERVABILITY_RETENTION_DAYS` 环境变量覆盖)的 spans, **When** retention 任务跑一次, **Then** 这些 spans 被物理删除,后续 GET 不再返回
2. **Given** 用户打开任意 thread 的 observability 面板, **When** Sheet 顶部展示 retention 信息, **Then** 显示「spans 保留 X 天,超过 X 天的数据将在下次 retention 清理时删除」+ 当前保留天数 X
3. **Given** 运维修改 `OBSERVABILITY_RETENTION_DAYS=14` 并重启服务, **When** 用户刷新面板, **Then** 顶部显示「保留 14 天」

---

### User Story 4 - observability 数据本身不暴露密钥或内部地址 (Priority: P1)

作为部署者,我必须保证 panel 拉到的数据里看不到 api_key、baseURL(尤其指向内网代理)、organization id 等敏感字段,即使 model 调用时这些字段流过了回调。

**Why this priority**: 安全问题直接定 P1。已经把 `llm_kwargs` 整块摘掉(commit 211d133),但需要在 spec 层面把这条约束固化下来,防止后续回归。

**Independent Test**: 发起一次真实的 LLM 调用,在 captures 里 grep `api_key` / `baseURL` / `organization` / `sk-` / `Bearer` 等敏感模式,0 命中;同时 `serialized_llm` / `ls_model_name` 等模型标识字段仍然在。

**Acceptance Scenarios**:

1. **Given** ChatOpenAI 在 `OPENAI_BASE_URL=https://internal-proxy.example.com/v1` 下运行, **When** 这次调用的 spans 被捕获, **Then** 任何字段(顶层 / `meta.*` / `input` / `output`)都不包含 `internal-proxy.example.com` 字面量
2. **Given** 用户的 `OPENAI_API_KEY=sk-...` 配置存在, **When** LLM 调用产生 spans, **Then** spans 里没有 `sk-` 前缀的字符串出现

---

### User Story 5 - dev 工具不污染生产代码库 (Priority: P2)

作为项目维护者,临时 dev-only 工具(临时 dump 目录、preview 页面)不应该留在仓库里——preview 页面读完 `/tmp/captured-spans-*.json` 是开发期验证 transform 用的脚手架,生产路径走 `/api/threads/:id/observability` 后这个脚手架就失去价值了。

**Why this priority**: 不是用户面对的功能,但是仓库卫生。P2 是因为不影响功能正确性,只是清洁度。

**Independent Test**: 仓库里 `git ls-files` 不包含 `.observability-screenshots/`(已删)、preview 页面要么已经删掉、要么明确标为 dev-only。

**Acceptance Scenarios**:

1. **Given** 实时 captures API 已上线, **When** 用户/开发者查看仓库, **Then** `app/observability-preview/page.tsx` 不存在,或显式标为 dev-only 且不在 build 路径上

---

### Edge Cases

- **多次发问产生的累积 spans**: 同 thread 内多个 user turn,langgraph_step 单调递增,没有 turn 边界信号——MVP 内不切分,UI 显示「all spans for this thread」一个列表(turn 划分是 MVP+1)
- **interrupt 流被打断**: LangGraph interrupt(等用户输入)会让 graph.invoke 长时间不返回,spans 一直处于 `running` 状态——GET 时调用 `markRunningAsFailed(thread_id)` 把未结束 span 标记为 failed,UI 显示「incomplete」
- **跨用户越权访问**: A 用户用 B 用户的 thread_id 调 `GET /api/threads/:id/observability` 必须 404(查 `threads.user_id` 不匹配即拒绝,不暴露 thread 是否存在)
- **Postgres 写入失败**: callback handler 内 INSERT 失败不能阻塞 graph.invoke 主流程——失败仅 log,不 throw;UI 在 GET 时发现 spans 缺失显示 warning
- **多 worker 并发写**: 两个 Next.js worker 同时写同一 thread 的 spans,DB unique constraint(span_id PRIMARY KEY)+ ON CONFLICT DO NOTHING 保证幂等
- **dev vs prod checkpointer 差异**: LangGraph dev server 用 InMemorySaver,prod 用 PostgresSaver;checkpointer 切换不影响 callback 捕获——callback handler 与 checkpointer 解耦
- **AbortController 提前取消**: invoke 被 abort 时 `handleChainEnd` 不触发,spans 永远 running——同 interrupt 路径,markRunningAsFailed 兜底

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: System MUST 在每次 LLM / ChatModel / Tool / Chain / Retriever 调用产生 span 时,通过 `CapturingHandler` 收集结构化数据(spans 字段、meta 字段、父子关系)
- **FR-002**: System MUST 将 CapturedSpan 持久化到 Postgres `observability_spans` 表(按 `thread_id` 分区存储),通过 `lib/observability/queries.ts` 提供按 thread_id 查询/插入/清除的 repository 函数
- **FR-003**: System MUST 提供 `GET /api/threads/[id]/observability` HTTP 端点,带 `withAuth` 鉴权(rule #9),且必须校验 `threads.user_id == session.user.id`(越权返回 404,不暴露 thread 存在性);返回该 thread 的 CapturedSpan 数组,按 `started_at` 升序
- **FR-004**: System MUST 提供 `DELETE /api/threads/[id]/observability` HTTP 端点,鉴权同 FR-003,清空指定 thread 的 spans
- **FR-005**: System MUST 在 `GET` 时对未结束(running)的 spans 调用 `markRunningAsFailed(thread_id)`(UPDATE 状态),确保 UI 拉到的数据是终态
- **FR-006**: System MUST 在 thread 头部提供一个 icon-only 入口按钮(rule #8 例外),点击打开 ObservabilityPanel Sheet,fetch 当前 thread_id 的 spans
- **FR-007**: System MUST 在前端把 CapturedSpan[] 转换为 SpanData[](`captured-to-span-data.ts` 逻辑搬到 `lib/observability/transform.ts`,两边共用)
- **FR-008**: System MUST 提供 retention 机制: spans 保留周期可通过环境变量 `OBSERVABILITY_RETENTION_DAYS` 配置,默认 30 天;由后台 cron / tsx 脚本物理删除过期行(具体调度方式在 plan 阶段决定)
- **FR-009**: System MUST NOT 在任何 span 字段(顶层、`meta.*`、`input`、`output`、DB row)中包含 `*api_key`、`*_secret`、`password`、`baseURL`、`organization`、Bearer token 等敏感模式——禁止回归到 `llm_kwargs` capture;写入侧加白名单防御(`JSON.stringify` 后 grep 敏感模式,命中即 throw 拒绝写入)
- **FR-010**: System MUST 在 `docs/OBSERVABILITY.md` 文档化: 端点表(含 `/api/threads/:id/observability`)、字段表、thread_id 关联规则、安全声明(不存密钥 / 内部地址)、retention 策略
- **FR-011**: System MUST 包含测试覆盖:
  - `tests/backend/observability/callback-collector.test.ts`: 4 种 LC message 形态 unwrap(live instance / V1 envelope / V2 envelope / flat)、parent chain 推导、TTFT 计算
  - `tests/lib/observability/queries.test.ts`: insert / getByThreadId / markRunningAsFailed / deleteByThreadId 各路径,≥90% 覆盖率
  - `tests/api/threads/observability.test.ts`: GET 200/401/404(越权)/404(thread 不存在) / DELETE 200/401/404 各路径
  - 覆盖率: route handlers 100%, queries ≥90%(rule #2)
- **FR-012**: System MUST 把 `app/observability-preview/page.tsx` 和 `components/assistant-ui/captured-panels.client.tsx` 删除(API 上线后失去价值);`captured-to-span-data.ts` 迁移到 `lib/observability/transform.ts`
- **FR-013**: System MUST 在 `lib/observability/schema.ts` 提供 Drizzle table 定义,字段对齐 CapturedSpan;提供 `db/migrations/NNNN_observability_spans.sql` 迁移

### Key Entities

- **CapturedSpan**: 一次回调触发的可观测数据单元
  - 字段: `span_id`, `parent_span_id`, `name`, `kind` (llm/tool/chain/retriever/unknown), `status` (running/completed/failed), `started_at`, `ended_at`, `input`, `output`, `usage`, `error`, `meta`
  - meta 内携带 LangChain 自动填的 `langgraph_node` / `langgraph_step` / `langgraph_checkpoint_ns` / `thread_id` / `ls_model_name` 等
  - **不允许**包含: `llm_kwargs`、`openai_api_key`、`baseURL` 等
- **ObservabilitySpanRow**(`observability_spans` 表的一行)
  - 列: `span_id text PRIMARY KEY`, `thread_id text NOT NULL REFERENCES threads(id) ON DELETE CASCADE`, `parent_span_id text NULL`, `name text NOT NULL`, `kind text NOT NULL`, `status text NOT NULL`, `started_at bigint NOT NULL`, `ended_at bigint NULL`, `input jsonb NULL`, `output jsonb NULL`, `usage jsonb NULL`, `error text NULL`, `meta jsonb NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`
  - 索引: `(thread_id, started_at)` 用于按 thread 查询;`created_at` 上建索引用于 retention
  - 外键 `thread_id → threads(id) ON DELETE CASCADE`: thread 删除时 spans 一起删,无需单独清理
- **ObservabilityEndpoint**: HTTP 端点契约
  - GET `/api/threads/{id}/observability` → `{thread_id, spans: CapturedSpan[], retention_days: number}`(`{id}` 即 thread_id)
  - DELETE `/api/threads/{id}/observability` → `{cleared: number}`
- **RetentionConfig**(env var 派生的运行时只读对象)
  - 来源: `process.env.OBSERVABILITY_RETENTION_DAYS`(必须为正整数;缺失/非法值 → 默认 30)
  - 用途: retention 脚本读取决定删除阈值;GET 响应里回传给前端展示
  - 修改时机: 仅运维通过 env 改 + 重启服务生效(不在运行时动态配置)

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 用户在 thread 内点击 observability 入口按钮后,3 秒内面板打开并显示本次对话的 spans(P95)
- **SC-002**: 面板显示的 span 数量与 `observability_spans` 表中该 thread_id 的行数一致(无丢失、无重复)
- **SC-003**: 任何敏感字段(api_key / baseURL / Bearer / sk- 前缀)在 `observability_spans` 全文检索 0 命中
- **SC-004**: DB 中按当前 retention 周期(`OBSERVABILITY_RETENTION_DAYS`,默认 30 天)累积的 `observability_spans` 行不超过 N 行(在 plan 阶段定 N,默认按 retention + 真实流量估算)
- **SC-005**: 多 thread 并发时(2 个 thread 各自跑 5 轮 invoke),每个 thread 的面板只显示本 thread 的 spans,无 cross-contamination
- **SC-006**: 单元测试套件 `pnpm test` 全绿,observability 模块测试覆盖率: collectors ≥ 85%, queries ≥ 90%, route handlers ≥ 90%
- **SC-007**: `docs/OBSERVABILITY.md` 存在并包含: 至少 2 个端点的 curl 示例 + 完整字段表 + 安全声明
- **SC-008**: A 用户用 B 用户的 thread_id 调 GET 接口返回 404,DB 不返回任何 spans;重复调 N 次(并发或顺序)结果一致

## Assumptions

- LangGraph dev server(`langgraphjs dev`)继续作为唯一运行时,不切到 LangSmith Deployment(部署后另有 captured spans 接入策略,不在本 spec 范围)
- 现有 `langchain-core` 1.2.x 的 callback 行为不破坏:`handleChatModelStart` / `handleLLMStart` / `handleChainStart` / `handleToolStart` 等签名保持兼容
- 同 thread 多个 user turn 产生的 spans 在 MVP 内不划分 turn 边界,UI 展示为「all spans for this thread」单列表(turn 划分属于 MVP+1,通过 `meta.langgraph_path` 含 `__start__` 识别 turn 起点,留作未来扩展)
- `ObservabilityPanel` 渲染能力已存在(`components/assistant-ui/observability-panel.tsx`),spec 关注的是数据流而不是组件重写
- Postgres 是观测数据的唯一存储位置,retention 通过 `ON DELETE CASCADE`(thread 删除时级联)+ 后台 cron 物理删除过期 spans 两路兜底;retention 周期通过 `OBSERVABILITY_RETENTION_DAYS` 环境变量配置,默认 30 天,必须为正整数
- 多 worker 部署现已支持(`observability_spans` 是 Postgres 表,worker 间通过 DB 共享);callback 写入失败不能阻塞 graph.invoke
- SSE/实时推送不在 MVP 范围(MVP 走「点开拉一次」足够,后续可加)
- LangSmith export 不在 MVP 范围(已有 LangSmith trace 服务端记录,前端不需要再 export)
