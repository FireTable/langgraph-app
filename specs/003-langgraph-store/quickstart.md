# Quickstart: LangGraph Long-Term Memory

**Branch**: `feat/003-langgraph-store` | **Date**: 2026-07-02 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

**Goal**: 端到端验证三大 user story —— 跨 thread 续聊、thread 长时摘要、settings 删除。每个 scenario 给出运行命令与预期观察。

---

## 前置

### 环境

- `pnpm install` 已执行
- Postgres 在 `localhost:5432`,数据库 `langgraph_app_dev`(沿用 `db/` 现有 schema)
- `.env.local` 已配 `OPENAI_API_KEY` / `DATABASE_URL`(`backend/store.ts` 启动时读)
- `langgraphjs dev` 起在 `:2024`,`next dev` 起在 `:3000`(可用 `pnpm dev` 一起)

### 触发 store

启动 backend 时 `backend/store.ts` 顶部 `await store.setup()` 自动建 `store` / `vector_store` 两表。`SELECT * FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'store%'` 应见 `store`、`vector_store`。

### 浏览器检查(Chrome DevTools MCP)

```text
打开:  http://localhost:3000/login → 用 dev 账号登录
跳到:  http://localhost:3000/chat
```

---

## Scenario 1: 跨 thread 续聊(US1)

**目标**: 验证 US1 —— 关掉 thread A,开 thread B,新 thread 的 agent 记得 A 里说过的事实。

### 步骤

1. 在当前 thread(代号 thread-A)中跟 agent 说:

   ```
   我叫 XXX,做 LangGraph 的 demo 项目,前端工程师,以后回答别太长,3 句话内。
   ```

   **预期**: 模型可能调用 `save_memory` 工具。打开 Chrome DevTools Network tab,过滤 `tools/calls` —— 看到 `save_memory` 调用,patches 形如 `[{op:"add", path:"/name", value:"XXX"}]` 等。

2. 在 DB 里查 profile doc:

   ```sql
   SELECT value FROM store WHERE prefix = ARRAY['<your-user-id>', 'profile'] AND key = 'main';
   ```

   **预期**: JSON 含 `name`、`current_project`、`role`、`prefers_brief` 等字段。字节数 < 8192。

3. 关闭当前 thread,开新 thread(thread-B):

   ```
   我上次跟你说过我在做什么项目?
   ```

   **预期**: 模型回复提到 "LangGraph demo"(不读 thread 历史,纯靠 memoryRecall 中间件注入的 profile)。Network tab 抓 `/threads/<B>/runs/stream`,在 SSE 事件最开头应看到 system message 含 `<memory>{...}</memory>` 块(从 chrome devtools event payload 看不到,可以用 `?debug=true` 或后端 `console.log` 临时打 log 验证)。

4. 再问 thread-B:

   ```
   我叫什么? 我是前端还是后端?
   ```

   **预期**: 模型正确回答,数据全部来自 profile doc,不来自 thread-B 自身消息。

### 失败排查

| 现象                              | 检查                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| 模型不调用 `save_memory`          | 看 Network 抓的工具列表,确认 `save_memory` 在 `ALL_TOOLS` 里(`backend/tool/index.ts`) |
| 模型调用了但 store 没写           | `console.log` `saveMemoryTool` 出口,看 `bytes` / `keyCount` 返回                      |
| thread-B 模型不"记得"             | `withMemoryRecall` 是否真的 prepend 了 system message(proxy 注入 userId 后)           |
| System message 中无 `<memory>` 块 | middleware 早 throw 或 userId 没注入(proxy 是否带 `config.configurable.userId`)       |

---

## Scenario 2: Thread 长时摘要(US2)

**目标**: 验证 US2 —— thread 聊到 user msg > 10,触发 `threadSummarize` node,store 出现 summary doc。

### 前置

```bash
# 确认 env(可写 .env.local / 临时 export)
export MEMORY_THREAD_SUMMARY_THRESHOLD=10
export MEMORY_THREAD_SUMMARY_KEEP_RECENT=4
```

### 步骤

1. 单一 thread(thread-Long),连续发 11 条 user message(任意主题,例:

   ```
   1. 聊 React vs Vue
   2. ...
   11. 收尾讨论
   ```

   每发一条后,等 agent 回复完(turn 完整结束)。

2. 第 11 条发完,等 agent 回复:

   **预期**: `afterAgent` 后跑 `threadSummarize` node,store 出现一条 doc:

   ```sql
   SELECT key, value FROM store WHERE prefix = ARRAY['<user-id>', 'threads'];
   ```

   ```text
   key:  thread-Long:1
   value: {
     "threadId": "thread-Long",
     "sequence": 1,
     "name": "<LLM 生成的标题>",
     "description": "<1-2 句描述>",
     "startMessageIndex": 0,
     "endMessageIndex": 6,          -- 11 - 4 = 7 → endMessageIndex = 7-1 = 6
     "messageCount": 7,
     "updatedAt": "2026-07-02T..."
   }
   ```

3. 继续聊到 16 条 user message(再增 5 条),触发第二次摘要:

   **预期**: 出现 `thread-Long:2`,`startMessageIndex: 7`,`endMessageIndex: 11`,`messageCount: 5`。

### 跳过分支验证

设 `MEMORY_THREAD_SUMMARY_THRESHOLD=100`(极高),聊 11 条:

**预期**: store 中无 summary doc(threadSummarize 跳过)

### 失败排查

| 现象                          | 检查                                                              |
| ----------------------------- | ----------------------------------------------------------------- | ----------------------- |
| summary doc 缺失              | `state.userMessageCount` 是否被 reducer 正确维护(`state.ts`)      |
| endMessageIndex 不正确        | 公式 `(userMessageCount - KEEP_RECENT) - 1`,确认 KEEP_RECENT 是 4 |
| 同一 thread 多次写同 sequence | `getThreadSummaries` 取最大 sequence 后 +1(避免 race)             |
| 摘要里没 assistant message    | node 取 `messages.filter(isHuman                                  | isAI)` 区间切片(FR-012) |

---

## Scenario 3: Settings 删除(US3)

**目标**: 验证 US3 —— Memory tab 可见、可删。

### 前置

- 完成 Scenario 1,profile 有内容
- 完成 Scenario 2,threads 有 1+ summary

### 步骤

1. 浏览器访问 `/settings/memory`(首次需在 better-auth-ui 注入 settings 路由后):

   **预期**: 看到 "Memory" tab 与现有 "Account" / "Security" tab 并列。两块:

   ```
   ## Profile
   name    XXX   (from account)         ← 无删除按钮
   email   xxx@example.com  (from account)  ← 无删除按钮
   github  (from account: social)   ← 无删除按钮
   current_project   LangGraph demo   (saved by you)   [Delete]
   role    frontend  (saved by you)   [Delete]
   prefers_brief  true  (saved by you)   [Delete]

   ## Thread Summaries
   Thread: thread-Long        [Delete all]
     • sequence 2: <name2>  <desc2>   <updatedAt>
     • sequence 1: <name1>  <desc1>   <updatedAt>
   ```

2. 点 profile 行 `current_project` 的 Delete 按钮:

   **预期**: 行消失。Network 看到 `DELETE /api/memory/profile/current_project` 返回 200 + `{ ok: true, deletedKey: "current_project" }`。

3. 在新 thread 问:

   ```
   我在做什么项目?
   ```

   **预期**: 模型**不能**回答 LangGraph demo(该字段已删),profile 中只剩其它字段。

4. 点 thread `thread-Long` 的 "Delete all" 按钮:

   **预期**: 整个 thread 区块折叠消失。Network 看到 `DELETE /api/memory/threads/thread-Long` 返回 200 + `{ ok: true, deletedCount: 2 }`。

### 失败排查

| 现象                     | 检查                                                              |
| ------------------------ | ----------------------------------------------------------------- |
| Memory tab 不显示        | `declare module "@better-auth-ui/core"` 是否在 `global.d.ts` 加了 |
| DELETE 401               | handler 是否真的包了 `withAuth`(rule #9)                          |
| DELETE 404 但行明明存在  | `key` URL 解码 / path regex 检查是否拒绝了合法 key                |
| Threads 删除后 UI 仍显示 | SWR / fetch revalidation;`useSWR` 的 `mutate` 是否触发            |
| 删除返回 500             | 看 server log;最常见是 `store.batch` 接受 delete op 形式不对      |

---

## Scenario 4: 越权防护(等价类覆盖)

### 4a. 未登录访问 API

浏览器登出后(或 `curl` 不带 cookie):

```bash
curl -sS -i http://localhost:3000/api/memory/profile
```

**预期**: `401 Unauthorized`(rule #9)。

### 4b. 删除不存在的 key

```bash
curl -sS -i -X DELETE http://localhost:3000/api/memory/profile/totally-fake-key \
  --cookie "session=<valid session>"
```

**预期**: `404 Not Found`(`memory.api.md § Endpoint 2`)。

### 4c. 删除 thread 无 summaries

```bash
curl -sS -i -X DELETE http://localhost:3000/api/memory/threads/no-such-thread \
  --cookie "session=<valid session>"
```

**预期**: `404 Not Found`。

---

## 验收清单(对照 spec US)

| US  | Scenario                     | 验收条件                                                          | 状态 |
| --- | ---------------------------- | ----------------------------------------------------------------- | ---- |
| US1 | Scenario 1                   | 跨 thread 模型正确引用 profile 字段                               | ☐    |
| US2 | Scenario 2                   | 阈值 / keep_recent 触发,summaries 写入 `[userId, "threads"]` 正确 | ☐    |
| US3 | Scenario 3                   | Memory tab 显示 + 删除按钮工作;新 thread 不再引用已删字段         | ☐    |
| US4 | Scenario 1 step 4 + 2 step 3 | session / socialAccounts 实时反映,改名后新 thread 用新名          | ☐    |

---

## 失败回滚

若 store 写入测试过程产生脏数据:

```sql
-- 清掉当前 user 的全部 memory
DELETE FROM store WHERE prefix = ARRAY['<your-user-id>', 'profile'];
DELETE FROM store WHERE prefix = ARRAY['<your-user-id>', 'threads'];
```

`backend/store.ts` 的表 schema 由 `store.setup()` 维护,**不**通过 `db/migrations/` 管(避免和 better-auth 的 drizzle 混在一起)。

## Open Questions

None。
