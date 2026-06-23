# Contracts: /api/auth/\* (Better Auth handler)

> Phase 1 输出。本文件描述 `/api/auth/[...all]/route.ts` 通过 Better Auth 对外暴露的 HTTP 接口契约。前端/外部集成方按此契约对接。

## 路由总览

`app/api/auth/[...all]/route.ts` 透传 Better Auth `auth.handler(request)`，覆盖以下端点（path 前缀 `/api/auth`，由 Better Auth 定义）：

| 方法 | 路径                                | 用途                        | spec FR                |
| ---- | ----------------------------------- | --------------------------- | ---------------------- |
| POST | `/api/auth/sign-up/email`           | 邮箱密码注册                | FR-001, FR-002, FR-003 |
| POST | `/api/auth/sign-in/email`           | 邮箱密码登录                | FR-006                 |
| POST | `/api/auth/sign-out`                | 登出                        | FR-015                 |
| GET  | `/api/auth/get-session`             | 获取当前 session            | FR-014, FR-016         |
| GET  | `/api/auth/verify-email`            | 验证邮件 token 落地         | FR-005                 |
| POST | `/api/auth/send-verification-email` | 重新发送验证邮件            | FR-007, FR-008         |
| GET  | `/api/auth/sign-in/social`          | OAuth 入口（GitHub/Google） | FR-009, FR-010         |
| GET  | `/api/auth/callback/:provider`      | OAuth 回调                  | FR-011, FR-012         |

## 通用约定

- **认证**：除注册/登录/验证邮件/OAuth 入口外的所有路径要求 session cookie 或 `Authorization: Bearer <token>`
- **Content-Type**: `application/json`（除 OAuth 入口/回调）
- **错误响应**: `{ message: string, code?: string }` + 对应 HTTP status（400/401/403/409/422/429/500）
- **CORS**: 沿用现有 `/api/[..._path]/route.ts` 配置（permissive）
- **Rate limit**: Better Auth 内置（IP + email 维度）

## 1. POST /api/auth/sign-up/email

**Request**:

```json
{
  "email": "user@example.com",
  "password": "abc12345",
  "name": "Optional display name"
}
```

**Validation**（FR-002, FR-003）：

- `email`: RFC 5322 合法邮箱
- `password`: ≥ 8 字符 + 至少 1 个字母 + 至少 1 个数字

**Success 200**:

```json
{
  "user": { "id": "cuid_...", "email": "...", "emailVerified": false, ... },
  "session": null
}
```

**副作用**: 触发 `sendVerificationEmail` → Resend

**Errors**:

- `400` — 邮箱格式不合法 / 密码强度不足
- `409` — 邮箱已存在（FR-022，错误消息不泄漏账号是否存在 → 文案统一为"Email already registered"）
- `422` — Resend 返回 429 配额超限（FR-025 → 拒绝，不创建 user 行）
- `500` — 内部错误

## 2. POST /api/auth/sign-in/email

**Request**:

```json
{ "email": "user@example.com", "password": "abc12345" }
```

**Success 200**:

```json
{
  "user": { ... },
  "session": { "token": "...", "expiresAt": "2026-06-29T..." }
}
```

**副作用**: Set-Cookie `better-auth.session_token=...`

**Errors**:

- `400` — 字段缺失
- `401` — 邮箱不存在 / 密码错误（统一文案 "Invalid email or password"）
- `403` — 邮箱未验证（FR-006 → "Please verify your email before signing in"）
- `429` — 登录失败次数过多（Better Auth 内置限流）

## 3. POST /api/auth/sign-out

**Request**: empty body，需 session cookie

**Success 200**:

```json
{ "success": true }
```

**副作用**: session 行被删除；Set-Cookie 清除 cookie

**Errors**:

- `401` — 未登录

## 4. GET /api/auth/get-session

**Request**: 无 body，需 session cookie

**Success 200**:

```json
{
  "user": { "id": "...", "email": "...", "emailVerified": true, ... },
  "session": { "expiresAt": "..." }
}
```

**No session 200**:

```json
{ "user": null, "session": null }
```

（注意：Better Auth 返回 200 + null，不返回 401——客户端需检查 `user === null`）

## 5. GET /api/auth/verify-email?token=...

**Query**: `token=<base64url>`（来自邮件链接）

**Success 302**: 重定向到 `/login?verified=1`

**Errors**:

- `302 → /login?error=invalid_token` — token 不存在
- `302 → /login?error=expired` — token 过期（FR-006）
- `302 → /login?error=already_verified` — 邮箱已验证

## 6. POST /api/auth/send-verification-email

**Request**:

```json
{ "email": "user@example.com" }
```

**Success 200**:

```json
{ "success": true }
```

**副作用**: upsert verification 行（FR-008：旧 token 失效）+ Resend 发送新邮件

**Errors**:

- `429` — Resend 配额超限（FR-025 → "Email service rate limit, please try again later"）

## 7. GET /api/auth/sign-in/social?provider=github|google&callbackURL=/

**Query**: `provider` ∈ {"github", "google"}；`callbackURL` 是回跳 URL（白名单）

**Success 302**: 重定向到 provider 授权页

**Errors**:

- `400` — provider 不支持

## 8. GET /api/auth/callback/:provider

**Query**: provider OAuth 服务返回的 code + state

**Success 302**: 重定向到 `callbackURL`（默认 `/`），Set-Cookie session

**业务逻辑（FR-011）**:

1. 用 code 换 token → 拿 provider 返回的 user info
2. 按 email 在 user 表查找
3. 命中 → 合并第三方身份到该 user（upsert account 行），登录
4. 未命中 → 创建新 user（emailVerified=true，FR-012）+ account 行，登录

**Errors**:

- `302 → /login?error=oauth_failed` — provider 返回错误
- `302 → /login?error=oauth_denied` — 用户拒绝授权

## 错误响应统一格式

```json
{
  "message": "Human-readable error",
  "code": "stable_machine_code",
  "status": 400
}
```

`code` 取值（稳定，可在前端硬编码）:

- `EMAIL_INVALID`, `PASSWORD_TOO_WEAK`
- `EMAIL_TAKEN`, `INVALID_CREDENTIALS`
- `EMAIL_NOT_VERIFIED`, `RATE_LIMITED`
- `EMAIL_QUOTA_EXCEEDED`
- `OAUTH_FAILED`, `OAUTH_DENIED`
- `TOKEN_INVALID`, `TOKEN_EXPIRED`

## 测试矩阵（每个端点必测）

| 端点                    | 200 路径   | 401 路径              | 错误码路径                                           |
| ----------------------- | ---------- | --------------------- | ---------------------------------------------------- |
| sign-up/email           | 正常注册   | —                     | EMAIL_TAKEN, PASSWORD_TOO_WEAK, EMAIL_QUOTA_EXCEEDED |
| sign-in/email           | 正常登录   | —                     | INVALID_CREDENTIALS, EMAIL_NOT_VERIFIED              |
| sign-out                | 正常登出   | 未登录                | —                                                    |
| get-session             | 有 session | (返回 null, 不算错误) | —                                                    |
| verify-email            | 正常验证   | —                     | TOKEN_INVALID, TOKEN_EXPIRED                         |
| send-verification-email | 正常发送   | —                     | EMAIL_QUOTA_EXCEEDED                                 |
| sign-in/social          | 重定向     | —                     | OAUTH_FAILED                                         |
| callback/:provider      | 重定向     | —                     | OAUTH_FAILED, OAUTH_DENIED                           |
