# Quickstart: 001-user-auth

> Phase 1 输出。本文件是可执行的"端到端验证手册"。读完后应能：本地拉起 dev、跑通注册 → 验证 → 登录 → 发消息 → 切换账号隔离的全流程。

## 前置条件

- Node.js 22
- pnpm 9+
- PostgreSQL 16 在 `localhost:5432` 监听
- `langgraph_app` + `langgraph_app_test` 两个 database 已创建
- 一个 Resend 账号（免费版）+ 申请一个发件域名（dev 阶段可用 Resend 默认 `onboarding@resend.dev`）
- （可选）一个 GitHub OAuth App + 一个 Google OAuth Client，用于跑 OAuth 场景

## 环境变量

复制 `.env.example` 到 `.env.local`，**必须**补充以下字段：

```env
# Better Auth（必填）
BETTER_AUTH_SECRET=<openssl rand -hex 32 输出>
BETTER_AUTH_URL=http://localhost:3000

# OAuth Providers（dev 可以先只填一个，先验证邮箱密码路径）
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Email（必填，否则注册会被 Resend 拒绝）
RESEND_API_KEY=
RESEND_FROM_EMAIL=onboarding@resend.dev   # dev 默认；prod 用已验证域名
```

`RESEND_API_KEY` 在 https://resend.com/api-keys 申请；dev 测试时 Resend 默认 `onboarding@resend.dev` 可发送至注册时使用的邮箱（受限）。

## 安装依赖

```bash
pnpm install
```

新增：
- `better-auth`
- `resend`
- `@react-email/components`
- `@react-email/render`

## DB 准备

```bash
# 1. 重置（drop database，删除旧 57 条 thread）
pnpm db:reset

# 2. 删除旧 migrations 目录
rm -rf db/migrations

# 3. 重新生成（含 Better Auth 4 张表 + threads.userId NOT NULL）
pnpm db:generate

# 4. 应用
pnpm db:migrate
```

## 启动 dev

```bash
pnpm dev
```

打开 http://localhost:3000 — 应该重定向到 `/login`。

## 验证场景

### 场景 1：邮箱密码注册（FR-001 ~ FR-008）

1. 打开 `/login`
2. 切换到 "Sign up" 标签，输入：
   - email: `test+001@yourdomain.com`
   - password: `abc12345`（满足 ≥8 + 字母 + 数字）
   - name: `Test User`
3. 提交
4. **期望**:
   - 跳转到 `/login?verify=1` 提示 "Check your email"
   - DB 中 `user` 表有 1 行，`email_verified=false`
   - DB 中 `verification` 表有 1 行（identifier = email）
   - 收件箱收到验证邮件（HTML 格式、含 "Verify your email" 按钮）

5. 点击邮件中的链接
6. **期望**:
   - 浏览器跳转到 `/login?verified=1`
   - DB 中 `user.email_verified=true`，`verification` 行被删
   - 自动登录，session cookie 已设置

7. 访问 `/`（主页）
8. **期望**: 看到空 thread 列表 + "New Chat" 按钮

### 场景 2：邮箱密码登录 + 重复邮箱拒绝（FR-006, FR-022）

1. 登出
2. 打开 `/login` → "Sign in"
3. 输入刚才的 email + password
4. **期望**: 登录成功，进入主页

5. 登出 → 重新打开 `/login` → "Sign up"
6. 用同一 email + 不同 password 提交
7. **期望**: 错误 `EMAIL_TAKEN` / 文案 "Email already registered"

### 场景 3：未验证邮箱不能登录（FR-006）

1. 注册新账号 `test+002@yourdomain.com` / `pass1234`
2. 不点验证邮件
3. 登出后尝试登录
4. **期望**: 错误 `EMAIL_NOT_VERIFIED` / 文案 "Please verify your email"

### 场景 4：重新发送验证邮件（FR-007, FR-008）

1. 接着场景 3，点登录页 "Resend verification email"
2. **期望**:
   - 收件箱收到新邮件
   - 旧 token 链接点击返回 `TOKEN_EXPIRED` 或 `TOKEN_INVALID`
   - 新 token 点击成功验证

### 场景 5：OAuth 登录（FR-009 ~ FR-012）

1. 在 GitHub 创建 OAuth App：
   - Homepage URL: `http://localhost:3000`
   - Authorization callback URL: `http://localhost:3000/api/auth/callback/github`
2. 把 Client ID/Secret 填入 `.env.local`
3. 重启 `pnpm dev`
4. 打开 `/login` → 点 "Continue with GitHub"
5. **期望**:
   - 跳转 GitHub 授权页
   - 授权后跳回 `http://localhost:3000/`（已登录）
   - DB 中 `user` 表 + `account` 表各有 1 行（provider_id='github'）

6. 同样方法验证 Google（控制台 `console.cloud.google.com` 配 OAuth Client，回调 `http://localhost:3000/api/auth/callback/google`）

### 场景 6：OAuth 邮箱与已有账号合并（FR-011）

1. 用 email/password 注册 `test+003@yourdomain.com` 并验证
2. 在 GitHub 上把这个 email 加到 account 的 verified emails
3. 登出 → 用 GitHub 登录（同 email）
4. **期望**: 登录到已有账号（不是创建新 user）；`account` 表新增一行

### 场景 7：Thread 隔离（FR-018 ~ FR-021）

1. 浏览器 A 登录用户 `test+001` → 创建 thread "Hello A" → 发一条消息
2. 浏览器 B（隐身）登录用户 `test+002` → 创建 thread "Hello B" → 发一条消息
3. **期望**:
   - 浏览器 A 侧边栏只见 "Hello A"
   - 浏览器 B 侧边栏只见 "Hello B"
   - 浏览器 A 直接访问 `/api/threads/<B's thread id>` → 返回 404
   - 浏览器 B 直接访问 `/api/threads/<A's thread id>` → 返回 404

4. 浏览器 A 登出
5. **期望**:
   - `/` 重定向到 `/login`
   - 任何 `/api/threads/*` 返回 401（SC-005）

### 场景 8：删除用户级联（FR-021）

1. 在 DB 直接 `DELETE FROM "user" WHERE email='test+003@yourdomain.com'`
2. **期望**: `SELECT * FROM threads WHERE user_id=<test+003 的 user id>;` 返回 0 行（CASCADE）

### 场景 9：Resend 配额超限（FR-025）

1. 临时改 `RESEND_API_KEY` 为无效 key 或触发实际 429（dev 阶段可在 Resend dashboard 手动发到上限）
2. 注册新账号
3. **期望**:
   - 返回 `EMAIL_QUOTA_EXCEEDED` / "Email service rate limit, please try again later"
   - DB `user` 表**无新行**（无孤儿账号，FR-009）

## 自动化验证

```bash
pnpm test
```

应覆盖：
- `tests/auth/config.test.ts`：Better Auth 实例配置正确（providers / secret / trustedOrigins）
- `tests/auth/handler.test.ts`：每个端点 happy path + error code
- `tests/auth/queries.test.ts`：getCurrentUser 等 server-side helpers
- `tests/api/threads.test.ts`：所有权场景（隔离、404、401、CASCADE）
- `tests/threads/queries.test.ts`：所有函数签名变化后的契约

覆盖率硬指标：
- `lib/auth/*` ≥ 90%
- `app/api/auth/[...all]/route.ts` 每个分支覆盖
- `app/api/threads/*/route.ts` 每个分支覆盖（含 401/404）

## 视觉验证（宪法原则四）

- 用 Chrome DevTools MCP 打开 http://localhost:3000/login
- 截图：登录页（三个按钮 + 表单）、注册模式切换、验证邮件提示、主页（登录后）
- 验证邮件 HTML：发到 Gmail / Outlook Web 截图，确认按钮居中、字号合理、移动端响应式

## 排错

| 现象 | 原因 | 解决 |
|---|---|---|
| 登录页空白 | `BETTER_AUTH_SECRET` 未设 | 生成 32 字节 hex |
| 注册成功但收不到邮件 | `RESEND_API_KEY` 错或 `RESEND_FROM_EMAIL` 未验证 | Resend dashboard 检查域名 |
| OAuth 回调 404 | callback URL 不匹配 | 检查 `.env` 中 provider 配置 vs GitHub/Google 控制台 |
| OAuth 后用户看到 401 | session cookie 未设置 | 检查 `BETTER_AUTH_URL` 与浏览器 host 一致 |
| 主页死循环重定向 | server component 拿不到 session | 检查 `auth.api.getSession({ headers })` 调用 |
| 测试 DB 报 relation does not exist | 没跑 migration | `pnpm db:migrate`（test env 用 `DATABASE_URL_TEST`） |