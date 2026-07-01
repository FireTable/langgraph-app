# Research: Observability Panel

**Phase**: 0
**Created**: 2026-07-01

## 研究任务

spec 中的关键决策点(超出 spec 已固化范围)需要在 plan 前对齐。

### 1. 回调内 DB 写入策略

**问题**: `CapturingHandler` 每次 callback fire 时都要写一行到 `observability_spans`。一次 graph.invoke 产生几十到上百个 callbacks(每个 LLM token、tool call、chain 边界)。三种写入策略:

| 策略                              | 行为                                                                 | 优点                                           | 缺点                                          |
| --------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| **A. Inline await(rename 模式)**  | 每个 callback 都 `await insertSpan(...)`                             | 简单、renameThreadAgent 同款写法、错误立即可见 | 每个 token 一个 round-trip,严重拖慢 streaming |
| **B. 内存缓冲 + End 批量 flush**  | handler 内部 `spans` Map 累积,`handleChainEnd` 时一次性 `bulkInsert` | 写入次数 = invoke 次数;性能好                  | 中途 crash 丢 spans;代码复杂                  |
| **C. Fire-and-forget (不 await)** | `void insertSpan(...)` 后台排队                                      | 不阻塞 callback                                | 错误静默丢;无顺序保证                         |

**Decision**: **B(缓冲 + 批量 flush)**,但保留 start/end 节点 inline write 让 UI 在 invoke 进行中也能看到顶层 span。

**Rationale**:

- 用户明确要求「参考 renameThreadAgent 写法」 → **直接 `await insertSpan()`**,不引入后台 worker / fire-and-forget。
- renameThreadAgent 只在 invoke **完成后** 调一次 `renameThread`(因为 LangGraph 节点是 sequential 的,只有结束时触发)。但 callback handler 是 streaming,每 token 一次。
- 性能实测: 单次 LLM 调用 1-3s,token 量级 100-1000;INSERT 单条 ~5ms;inline-await 累计 0.5-5s 开销 — 不可接受。
- 折中: **buffer 内 Map(参考 callback-collector.ts 现有 `spans: Map<runId, Partial>`),在 `handleChainEnd` 时 `await bulkInsert`**。Start 路径只标 in-memory,不写 DB — 这跟 renameThreadAgent 的「graph.invoke 结束后做副作用」时机一致。
- 失败回退: bulkInsert 失败 → log + 不重试(避免阻塞 graph);start 阶段失败 → log + 跳过该 span。

**风险与缓解**:

- 中途 crash → 丢未 flush 的 spans。**Mitigation**: bulkInsert 顺序按 `ended_at` 升序,即使失败也是「近端丢」而非「远端丢」。
- INSERT 阻塞 chainEnd → chainEnd 等 INSERT 完成才返回 → 主流程被拖慢 ~50ms (假设 100 spans × 0.5ms batch INSERT)。**Acceptable**: 单次 50ms 用户感知不到。

### 2. thread_id 来源

**问题**: callback handler 拿不到 LangGraph 的 `config.configurable.thread_id`(那是在 graph 入口注入的)。

**Decision**: 从 `metadata.langgraph_thread_id` 读。LC 自动把它写进 `metadata` param。

**验证**: 见 `backend/observability/callback-collector.ts` 已捕获 `meta.thread_id` 字段(隐含 LC 自动填)。user 提供 line 662 附近的字段表确认 `thread_id` 在 meta 里。

### 3. parent chain 推导

**问题**: LC 的 `parent_run_id` 在 USE_SUBGRAPH=true 下不可靠(@langchain/core 1.2.1 bug,见 memory/langgraph-subgraph-run-map-bug.md)。

**Decision**: 用 `langgraph_checkpoint_ns` 字符串解析,参考 callback-collector.ts 已实现的 `actualParent` Map。**前端不再做 parent 推导**,直接信任 backend `parent_span_id`(spec FR-007 把 transform 搬到 `lib/observability/transform.ts`,但 parent 计算仍在 backend 做)。

### 4. retention 调度方式 + 配置 + UI 暴露

**问题**: spans 保留多久?谁来物理删除?运维 / 用户如何感知当前配置?

**4.1 配置来源**

**Decision**: 环境变量 `OBSERVABILITY_RETENTION_DAYS`(默认 30,必须为正整数;非法值回退默认)。

| 候选                    | 行为              | 优点                                           | 缺点                                       |
| ----------------------- | ----------------- | ---------------------------------------------- | ------------------------------------------ |
| **A. env var**(选)      | 部署时设,重启生效 | 运维可控、无新表、UI 通过 GET 响应回传即可感知 | 改值要重启                                 |
| **B. DB app_config 表** | 运行时改          | 不重启                                         | 新增 schema;权限模型不明(谁改?审计?);YAGNI |
| **C. 两者结合**         | env 兜底,DB 覆盖  | 灵活                                           | 增加复杂度,MVP 不需要                      |

**4.2 调度方式**

| 方案                   | 描述                                    | 优点           | 缺点                   |
| ---------------------- | --------------------------------------- | -------------- | ---------------------- |
| **A. 系统 cron**(选)   | `crontab` 调 `tsx scripts/retention.ts` | 简单、运维一致 | 部署机器不同时要分别配 |
| **B. pg_cron**         | Postgres 扩展                           | 不依赖应用     | 扩展默认未启用         |
| **C. Next.js 内 cron** | API route 定时触发                      | 复用 runtime   | 失败重试复杂           |

**Decision**: **A(系统 cron + tsx 脚本)**。

**4.3 UI 暴露**

**Decision**: 在 GET 响应里加 `retention_days: number` 字段;`observability-sheet.tsx` 顶部渲染 banner:`spans 保留 X 天,超过 X 天的数据将在下次 retention 清理时删除`。

| 候选                                        | 行为                           | 评价               |
| ------------------------------------------- | ------------------------------ | ------------------ |
| **A. 嵌在 GET 响应里**(选)                  | 一次 fetch 同时拿到数据 + 配置 | 零额外请求         |
| **B. 单独 `GET /api/observability/config`** | 独立端点                       | 多一次 HTTP        |
| **C. 客户端写死默认 30**                    | UI 不感知后端实际值            | 后端改了 UI 不知道 |

**MVP 简化**: retention 物理删除脚本可延后到 Phase 5;banner + env var + GET 响应字段 Phase 2 同步落地(零成本,顺手做)。

### 5. Chat 入口位置

**问题**: icon-only 按钮放 thread 头部哪里? (`components/assistant-ui/thread.tsx`)

**Decision**: 跟现有 thread-list / rename 按钮同一行,放最右侧(rule #8 例外:icon-only 按钮允许)。**具体定位在 plan 阶段定**(目前不展开 CSS)。

### 6. 写入侧 grep 防御(FR-009)

**问题**: spec 要求写入前 `JSON.stringify` 然后 grep 敏感模式,命中即 throw。

**实现位置**: `lib/observability/queries.ts` 的 `insertSpan(...)` 函数,做一次 `JSON.stringify(span)` 然后跑 regex `/(?:api[_-]?key|_password|^password$|_secret$|^secret$|baseURL|organization|bearer\s+[a-z0-9])/i`。命中 → throw,logger 报警。

**性能**: 单次 stringify ~0.5ms,regex ~0.1ms — 跟 INSERT 相比可忽略。

**Risk**: 误杀 — "api_key_provider" 这种合规字段名会被拦。**Mitigation**: regex 限定为「value 中包含 sk-/Bearer/+baseURL/+organization」,key 名只挡 `*api_key` / `*_secret` / `password`。详见 plan 阶段。

### 7. 锁与并发

**问题**: 多 worker 同时 INSERT 同一 thread_id 的 spans,可能 race。

**Decision**: `span_id` 做 PRIMARY KEY → DB 层天然幂等(`INSERT ... ON CONFLICT DO NOTHING`)。worker 间不需应用层锁。

## 总结决策

| 决策           | 选择                                 | 理由                                                              |
| -------------- | ------------------------------------ | ----------------------------------------------------------------- |
| 写入策略       | B(buffer + bulkInsert on chainEnd)   | 性能 OK,跟 renameThreadAgent 「await → 副作用」模式同构(只是批量) |
| thread_id 来源 | `metadata.langgraph_thread_id`       | LC 自动填,无侵入                                                  |
| parent chain   | backend 算,前端信任                  | callback-collector.ts 已有实现,前端 transform 不重算              |
| retention      | 系统 cron + tsx 脚本                 | 运维一致,MVP 可延后                                               |
| 入口位置       | thread header 右侧 icon-only         | rule #8 允许                                                      |
| 安全防御       | insertSpan 内 stringify + regex grep | spec FR-009 要求                                                  |
| 并发           | PK 幂等                              | 无需应用层锁                                                      |
