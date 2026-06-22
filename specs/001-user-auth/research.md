# Research: 001-user-auth

> Phase 0 输出。本文件记录关键技术选型决策，供 plan / tasks 引用。所有决策均与宪法原则三（首选标准方案）一致。

## 决策 1：认证框架 = Better Auth

**Decision**: 使用 `better-auth`（latest stable, 当前 1.x）及其 Drizzle adapter。

**Rationale**:
- 自托管 MIT，无供应商锁定，无月费；满足 spec "公开产品 + 渐进式 Stage 1" 需求
- Drizzle 原生 adapter（`better-auth/adapters/drizzle`），表结构由框架定义、本地用 Drizzle 接管 schema，符合宪法"用 drizzle-kit 管理 migration"
- 内置支持邮箱密码 + 邮箱验证 + OAuth（GitHub/Google）+ session，无需自行实现 cookie/CSRF
- 官方 Next.js handler（`toNextJsHandler()`）可直接挂到 `app/api/auth/[...all]/route.ts`
- TypeScript first，类型推断完整；与本项目 TS 6 栈契合

**Alternatives considered**:
- ❌ Clerk / Auth0 / WorkOS：付费 SaaS，违背"自托管 + 公开产品可持续"
- ❌ Auth.js (NextAuth)：Drizzle 支持较弱，文档分散，且 Better Auth 团队明确以 Drizzle 为一等公民
- ❌ Lucia：需要手写更多 glue code，与"首选标准方案"冲突
- ❌ Supabase Auth：绑定 Supabase 生态，超出本项目栈

**Sources**:
- https://better-auth.com/docs/installation（drizzle-kit 安装指引）
- https://better-auth.com/docs/authentication/email-password（email/password + 验证邮件配置）
- https://better-auth.com/docs/authentication/social-sign-on（GitHub/Google OAuth provider 配置）
- https://better-auth.com/docs/concepts/session（session 过期与 cookie 策略）

## 决策 2：邮件发送 = Resend SDK + react-email 模板

**Decision**: 使用 `resend` 官方 Node SDK + `@react-email/components` + `@react-email/render`。

**Rationale**:
- Resend 免费版（100 封/日）满足 MVP 流量；spec FR-025 已约束超额行为
- react-email 组件库覆盖跨邮件客户端兼容性（Gmail / Outlook / Apple Mail），不需要从零写 HTML table-based layout
- TypeScript 友好（`.tsx` 文件定义邮件内容）；宪法原则三"首选标准方案"
- Better Auth 支持自定义 `sendVerificationEmail` 回调，Resend 可直接接进 `betterAuth({ emailVerification: { sendVerificationEmail } })`

**Alternatives considered**:
- ❌ 自建 SMTP / Nodemailer：spec 阶段已明确不实现自建邮件
- ❌ Maizzle / MJML：另起炉灶的模板库，react-email 生态更广且 TS 友好
- ❌ Cloudflare Email Workers：spec 阶段曾讨论，但 Resend 集成更顺，与 Better Auth 兼容性更好

**Sources**:
- https://resend.com/docs/send-with-nodejs（Node SDK 用法）
- https://react.email/docs（组件库 + render 入口）
- https://better-auth.com/docs/authentication/email-password#send-verification-email（自定义 sendVerificationEmail 钩子）

## 决策 3：Better Auth 表结构与 Drizzle 集成

**Decision**: 用 Better Auth 官方 CLI `npx @better-auth/cli@latest generate` 生成 Drizzle schema 文件，再交给 `drizzle-kit` 管理 migration。

**Rationale**:
- Better Auth 官方推荐流程（[basic-usage 文档](https://better-auth.com/docs/basic-usage)）：CLI 读取 `lib/auth/config.ts`，emit Drizzle schema 到 `--output` 指定的路径
- 避免手写 4 张表的字段与 FK 出错
- 后续 schema 变更时（如新增字段）只需 `generate` 一次，diff 友好
- 复用现有 `db/schema.ts` 的 barrel pattern：`export * from "./auth/schema"`
- `drizzle-kit generate` 仍把 schema 转 SQL 迁移，符合宪法"drizzle-kit 管理 migration"
- 用户明确 OK 选项 B（`createTables: true` 自动建表）作为 fallback，但本期坚持选项 A（CLI + drizzle-kit）以保留 migration 审计链

**执行步骤**:
```bash
# 1. 写好 lib/auth/config.ts（含 email/password + GitHub + Google + emailVerification）
# 2. 让 CLI 从 config 反推 schema
npx @better-auth/cli@latest generate --config ./lib/auth/config.ts --output ./lib/auth/schema.ts -y
# 3. db/schema.ts 加一行：export * from "@/lib/auth/schema";
# 4. pnpm db:generate → pnpm db:migrate
```

**Alternatives considered**:
- ❌ 手写等价表：违反宪法原则三（首选标准方案）+ 升级易 drift
- ❌ `createTables: true`（Better Auth 启动时自动建表）：失去 migration 审计；与宪法"drizzle-kit 管理 migration"冲突
- ❌ 让 Better Auth 完全管 DB（不用 Drizzle）：与现有 `lib/threads` 模块的 Drizzle 模式割裂

**Schema（Better Auth 官方定义，仅供参考，最终以 CLI 生成为准）**:
```ts
// lib/auth/schema.ts
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  name: text("name"),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  password: text("password"),  // null for OAuth-only users
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

**Alternatives considered**:
- ❌ 让 Better Auth 自动建表（`createTables: true`）：违反宪法"drizzle-kit 管理 migration" + 不可审计
- ❌ 手写等价表：违反宪法原则三；Better Auth 升级时容易 drift

## 决策 4：threads.userId 改 NOT NULL + FK + CASCADE

**Decision**: 在同一 migration 中 `ALTER TABLE threads ALTER COLUMN user_id SET NOT NULL` + `ADD CONSTRAINT threads_user_id_fk FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE`。

**Rationale**:
- 当前 schema `userId: text("user_id")` 是 nullable；FR-017 要求"不允许无主会话"
- spec "数据处置" 假设已决定：现有 57 条 thread 全部丢弃，DB 全量重置，所以"加 NOT NULL 不需要 backfill"
- ON DELETE CASCADE 直接对应 FR-021"删除用户时级联删除 thread"

**Migration 顺序**:
1. `pnpm db:reset`（drop database） — 用户已决策
2. 删除 `db/migrations/0000_*`
3. 新 schema（userId NOT NULL）generate → `0000_*.sql`
4. apply

**Alternatives considered**:
- ❌ 保留 nullable + 应用层 enforce：违反宪法"db 单一事实来源"
- ❌ soft-delete user（保留 user 行）：spec 假设"不实现软删除"

## 决策 5：密码哈希 = Better Auth 内置 scrypt

**Decision**: 不引入额外依赖；用 Better Auth 默认 `scrypt`。

**Rationale**:
- Better Auth 默认使用 scrypt，符合 OWASP 推荐
- 无需引入 argon2 / bcrypt
- spec FR-002 只规定"≥8 字符 + 字母 + 数字"，不规定哈希算法；由 Better Auth 决定

**Alternatives considered**:
- ❌ argon2：更好但需引入 native 依赖；scrypt 已够用

## 决策 6：限流 = Better Auth 内置 + 简单内存层

**Decision**: 不在本期实现独立限流中间件；依赖 Better Auth 内置 rate limit（IP + email 维度）；SC-005 登出失效 + FR-022 重复邮箱拒绝已覆盖主要安全场景。

**Rationale**:
- Better Auth 默认包含 rate limiting
- MVP 不需要自定义策略；spec Assumptions 提到"限流策略 deferred to plan"，本期选择 = 用 Better Auth 默认
- 若后续 Stage 2 需要更严的限流，再加 middleware

**Alternatives considered**:
- ❌ 引入 `@upstash/ratelimit`：增加外部依赖 + Redis，超出 MVP 范围
- ❌ 自定义 Next.js middleware：违反宪法"首选标准方案"

## 决策 7：邮件模板 = react-email 官方 components

**Decision**: 使用 `@react-email/components` 的 `<Html>` / `<Container>` / `<Heading>` / `<Text>` / `<Button>` / `<Tailwind>` 等组件，不手写 table-based HTML。

**Rationale**:
- react-email 编译产物自带 Gmail / Outlook / Apple Mail 兼容性测试
- TS-first；与项目风格一致
- 模板作为 `.tsx` 文件存于 `lib/email/`，便于 review

**Alternatives considered**:
- ❌ Maizzle（基于 Tailwind）：需要 build step 单独维护
- ❌ MJML：语法陌生，TS 集成弱
- ❌ 自写 HTML table：跨客户端兼容差

## 决策 8：环境变量加载 = 现有 `@next/env`

**Decision**: 继续用 `loadEnvConfig(process.cwd())`（已在 `drizzle.config.ts` 用过）；Better Auth 通过其内置 `env` 读取。

**Rationale**:
- 宪法原则三 + 现有 `drizzle.config.ts` 模板
- 不引入 `dotenv` / `envalid` 等额外包

**Required env vars（写入 `.env.example`）**:
```env
# Better Auth core
BETTER_AUTH_SECRET=           # openssl rand -hex 32
BETTER_AUTH_URL=http://localhost:3000

# OAuth providers
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Email
RESEND_API_KEY=
RESEND_FROM_EMAIL=onboarding@resend.dev   # dev default; prod: verified domain
```

## 决策 9：测试策略 = Vitest + 真实 Postgres + Better Auth handler

**Decision**: 沿用现有 `pnpm test` + `langgraph_app_test` 数据库；Better Auth 通过 `auth.handler()` 在测试中直接调用，不走 HTTP fetch（更快、更可控）。

**Rationale**:
- `tests/api/` 已有真实 DB 集成测试模式（globalSetup 应用 migration）
- Better Auth handler 是纯函数（`auth.handler(request)`），无需启动 dev server
- 测试覆盖率硬指标 90% 在 lib/auth/queries.ts + validators.ts 强制

**Alternatives considered**:
- ❌ MSW mock：失去真实 DB 集成验证
- ❌ Jest：项目已用 Vitest，宪法"首选标准方案"

## 决策 10：前端 session 读取 = Better Auth React hooks

**Decision**: 使用 `better-auth/react` 的 `useSession()` / `signIn()` / `signOut()`；与 Next.js App Router 的 Server Components 共存（server 端用 `auth.api.getSession({ headers })`）。

**Rationale**:
- Better Auth 一等公民的 React 集成
- 不需要自写 useState + fetch
- Server Components 在 SSR 阶段可直接拿到 session，避免 flash of unauthenticated content

**Alternatives considered**:
- ❌ 自建 fetch wrapper：违反"首选标准方案"
- ❌ 仅 server-side session（无 client hook）：登录/登出交互需要客户端触发

---

## 待办（plan 阶段已无）

无。所有 NEEDS CLARIFICATION 已收敛。