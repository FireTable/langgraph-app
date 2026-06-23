# Data Model: 001-user-auth

> Phase 1 输出。本文件描述本期新增/修改的数据表、字段、约束与状态迁移。

## 新增表（Better Auth 自带 schema）

### `user`

| 字段             | 类型        | 约束                   | 说明                      |
| ---------------- | ----------- | ---------------------- | ------------------------- |
| `id`             | text        | PK                     | Better Auth 生成的 cuid   |
| `email`          | text        | NOT NULL UNIQUE        | 主登录标识                |
| `email_verified` | boolean     | NOT NULL DEFAULT false | FR-006 必须 true 才能登录 |
| `name`           | text        | nullable               | spec 假设"name 可选"      |
| `image`          | text        | nullable               | spec 假设"image 可选"     |
| `created_at`     | timestamptz | NOT NULL DEFAULT now() |                           |
| `updated_at`     | timestamptz | NOT NULL DEFAULT now() |                           |

**业务不变量**:

- `email` 全库唯一（包含大小写敏感与否由 Better Auth 默认决定）
- 删除 user 行必须级联删除 session / account / threads（FR-021）

### `session`

| 字段         | 类型        | 约束                                     | 说明               |
| ------------ | ----------- | ---------------------------------------- | ------------------ |
| `id`         | text        | PK                                       |                    |
| `user_id`    | text        | NOT NULL FK → user(id) ON DELETE CASCADE |                    |
| `token`      | text        | NOT NULL UNIQUE                          | 客户端 cookie 持有 |
| `expires_at` | timestamptz | NOT NULL                                 | FR-014：7 天       |
| `ip_address` | text        | nullable                                 | Better Auth 写入   |
| `user_agent` | text        | nullable                                 | Better Auth 写入   |
| `created_at` | timestamptz | NOT NULL DEFAULT now()                   |                    |
| `updated_at` | timestamptz | NOT NULL DEFAULT now()                   |                    |

**生命周期**:

- 创建：登录成功 / OAuth 回调成功
- 失效：登出（FR-015）/ 过期（FR-014 7 天）/ user 删除（CASCADE）

### `account`

| 字段                       | 类型        | 约束                                     | 说明                                          |
| -------------------------- | ----------- | ---------------------------------------- | --------------------------------------------- |
| `id`                       | text        | PK                                       |                                               |
| `user_id`                  | text        | NOT NULL FK → user(id) ON DELETE CASCADE |                                               |
| `account_id`               | text        | NOT NULL                                 | provider 内的用户 id（GitHub/Google user id） |
| `provider_id`              | text        | NOT NULL                                 | "credential" / "github" / "google"            |
| `access_token`             | text        | nullable                                 | OAuth                                         |
| `refresh_token`            | text        | nullable                                 | OAuth                                         |
| `id_token`                 | text        | nullable                                 | OAuth                                         |
| `password`                 | text        | nullable                                 | 仅 email/password 路径（Better Auth 已 hash） |
| `access_token_expires_at`  | timestamptz | nullable                                 | OAuth                                         |
| `refresh_token_expires_at` | timestamptz | nullable                                 | OAuth                                         |
| `scope`                    | text        | nullable                                 | OAuth                                         |
| `created_at`               | timestamptz | NOT NULL DEFAULT now()                   |                                               |
| `updated_at`               | timestamptz | NOT NULL DEFAULT now()                   |                                               |

**索引**: UNIQUE(`provider_id`, `account_id`) — 一个 provider 账号绑定到一个本地 user

**业务不变量**:

- 一个 user 可有多个 account（一个 email/password + 一个 GitHub + 一个 Google），通过相同 email 自动合并（FR-011）
- email/password 路径必须把 hashed password 写入 `account.password` 字段

### `verification`

| 字段         | 类型        | 约束                   | 说明            |
| ------------ | ----------- | ---------------------- | --------------- |
| `id`         | text        | PK                     |                 |
| `identifier` | text        | NOT NULL               | 目标 email      |
| `value`      | text        | NOT NULL               | 一次性 token    |
| `expires_at` | timestamptz | NOT NULL               | FR-005：24 小时 |
| `created_at` | timestamptz | NOT NULL DEFAULT now() |                 |
| `updated_at` | timestamptz | NOT NULL DEFAULT now() |                 |

**业务不变量**:

- `value` 是 base64url 随机串，Better Auth 内部使用；URL 安全
- 重新发送验证邮件（FR-008）必须 upsert 同一 `identifier` 的最新一条记录，旧 token 失效
- 验证成功后此行被 Better Auth 删除

## 修改表

### `threads`（已有，仅修改 user_id 列）

**修改前**:

```sql
user_id text  -- nullable
```

**修改后**:

```sql
user_id text NOT NULL
  REFERENCES "user"(id) ON DELETE CASCADE
```

**新增索引**（保持现有 `threads_status_updated_idx` / `threads_status_last_message_idx` 不变）：

- `threads_user_id_idx` ON (user_id) — FR-018 列表按 user 过滤的性能支撑

**业务不变量**:

- FR-017：无主 thread 不存在
- FR-018：`listThreads()` 改为 `listThreadsForUser(userId)`
- FR-019：getThread / renameThread / archiveThread / deleteThread 都加 userId 检查
- FR-020：createThread() 自动绑定当前 session.userId
- FR-021：删除 user → CASCADE → 删 threads

## 状态迁移

本期为干净起步（spec 假设：丢弃现有 57 条 thread + 重置 DB），无 in-place 状态迁移。

迁移步骤：

1. `pnpm db:reset` — drop database
2. 删除 `db/migrations/0000_*`
3. `pnpm db:generate` — 生成 0000_new.sql（含 user / session / account / verification + 改后 threads）
4. `pnpm db:migrate` — apply

## ER 关系图

```text
┌────────┐
│  user  │
└───┬────┘
    │ 1
    ├─── N ──→ session (ON DELETE CASCADE)
    ├─── N ──→ account (ON DELETE CASCADE)
    └─── N ──→ threads.user_id (ON DELETE CASCADE)

verification 是独立表，无 FK（identifier 是 email 而非 user.id；
未验证前 user 行可能尚未创建）。
```

## 与现有 checkpoints 表的关系

LangGraph 的 `checkpoints` / `checkpoint_blobs` / `checkpoint_writes` 由 `backend/checkpointer.ts` 的 `PostgresSaver.setup()` 创建，与本 feature 无关；dev 模式下被 `langgraphjs dev` 替换为 `InMemorySaver`，详见 CLAUDE.md "State persistence" 节。
