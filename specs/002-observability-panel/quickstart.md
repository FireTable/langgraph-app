# Quickstart: Observability Panel MVP

**Phase**: 1
**Created**: 2026-07-01

## 前置条件

- Node 22(`pnpm-workspace.yaml` 已固定)
- pnpm ≥ 9
- Postgres 已启动(DATABASE_URL 指向 `langgraph_app_dev` 或 `langgraph_app_test`)
- `.env.local` 已配齐 `OPENAI_API_KEY` / `DATABASE_URL`(参考 `.env.example`)

## 步骤

### 1. 安装依赖

```bash
pnpm install
```

### 2. 数据库迁移

```bash
pnpm db:generate    # 生成新迁移(NNNN_observability_spans.sql)
pnpm db:migrate     # 应用到 dev DB
```

期望输出:`Migrating NNNN_observability_spans.sql` + 表 `observability_spans` 出现在 DB。

### 3. 启动 dev

```bash
pnpm dev
```

期望:

- `localhost:3000` Next.js
- `localhost:2024` LangGraph dev server

### 4. 跑测试

```bash
pnpm test
```

期望:

- 全部 `tests/api/threads/observability.test.ts` 通过
- 全部 `tests/lib/observability/queries.test.ts` 通过
- 全部 `tests/backend/observability/callback-collector.test.ts` 通过
- 全套 vitest 报告 100% pass(rule #2)

### 5. 端到端验证(浏览器)

#### 5.1 登录 + 发消息

1. 浏览器打开 `http://localhost:3000`
2. 登录(用 dev 账号)
3. 开新 thread,发:`今天东京天气怎么样?`
4. 等待模型回复完成

#### 5.2 打开面板

1. 点击 thread 头部的 observability icon-only 按钮
2. Sheet 打开,显示 spans:
   - 1× `chain`(`graph.invoke`)
   - 1× `llm`(routerAgent)
   - 1× `llm`(weatherAgent)
   - 可能 1× `tool`(如果 weather sub-agent 调了搜索)
3. 每个 span 显示 status=completed、duration、model name
4. 展开 LLM span 看到 model、prompt、reply

#### 5.3 验证跨用户隔离(手动)

```bash
# Terminal A: 用户 U1 登录,创建 thread T1,发消息,记录 T1 id
# Terminal B: 用户 U2 登录,curl:
curl -i http://localhost:3000/api/threads/<T1_id>/observability \
  -H "Cookie: better-auth.session_token=<U2_session>"

# 期望: 404
```

### 6. 验证敏感字段防御

```bash
# 发消息时,确保 OPENAI_BASE_URL 指向内网代理
OPENAI_BASE_URL=https://internal-proxy.example.com/v1 pnpm dev

# 发任意消息,打开面板,在 browser devtools network 里看 GET 响应
# 期望: JSON 全文搜 "internal-proxy" 0 命中
```

### 7. 验证 retention(可选,MVP 后)

```bash
# 手动跑 retention 脚本(若已实现)
pnpm tsx scripts/retention.ts

# 期望: 7 天前的 spans 被物理删除
```

## 验证失败排查

| 症状                                | 排查                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| 面板打开后 spans 为空               | 检查 `metadata.langgraph_thread_id` 是否被 callback 捕获 → 看 `pnpm dev` console log  |
| 所有 span status=running            | `markRunningAsFailed` 没跑 → 检查 GET handler                                         |
| GET 返回 404 但 thread 存在         | 越权校验失败 → 检查 `getThreadForUser(id, user.id)` 是否有 user.id                    |
| INSERT 失败                         | DB 字段类型不匹配 → 检查 `lib/observability/schema.ts` 与 callback-collector 类型对齐 |
| 写入报「forbidden sensitive field」 | 误杀 → 检查 `FORBIDDEN` regex 是否过严                                                |

## 性能预期

- 单次 invoke 写入 ~100 spans → bulkInsert 耗时 ~50ms
- GET 100 spans → ~10ms(单条 query)
- 面板从点击到显示 < 1s(SC-001: 3s P95)

## 下一步

`/speckit-tasks` 把 plan 拆成可执行 task 列表。
