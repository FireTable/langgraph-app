# Contracts: /api/threads/\* 所有权变更

> Phase 1 输出。本文件描述本期对 `/api/threads/*` 路由的所有权/守卫修改契约。前端按此契约对接。

## 总览

所有 `/api/threads/*` 路由从"无认证"改为"session 守卫 + 所有权强制"。具体路径与签名沿用现有 (`/api/threads`、`/api/threads/[id]`)，仅添加 session 校验与 userId 过滤。

## 通用变更

- **每个请求**: 读 session cookie → 未登录返回 401
- **list / create**: 用 `session.user.id` 作为 userId 过滤/写入
- **get / patch / delete / archive**: 先 `getThread(id)` → 校验 `thread.userId === session.user.id` → 不匹配返回 404（不泄漏存在性，FR-019）

## 1. POST /api/threads

**之前**: 任意调用者创建 thread（userId 默认为 null）

**之后**: 必须已登录；创建时自动绑定 `userId = session.user.id`

**Success 201**:

```json
{
  "id": "uuid",
  "title": "New Chat",
  "status": "regular",
  "userId": "cuid_...", // 必有
  "createdAt": "...",
  "updatedAt": "...",
  "lastMessageAt": "..."
}
```

**Errors**:

- `401` — 未登录

## 2. GET /api/threads

**之前**: 返回所有 thread（按 updatedAt desc）

**之后**: 仅返回当前用户拥有的 thread（FR-018）

**Success 200**:

```json
[
  { "id": "uuid", "title": "...", "userId": "...", ... }
]
```

空 list → `200 []`

**Errors**:

- `401` — 未登录

## 3. GET /api/threads/[id]

**之后**: 校验所有权；非所有者返回 404（FR-019 不泄漏存在性）

**Success 200**:

```json
{ "id": "...", "title": "...", "userId": "...", ... }
```

**Errors**:

- `401` — 未登录
- `404` — thread 不存在 OR 存在但不属于当前用户

## 4. PATCH /api/threads/[id]

**Body**（任一字段）:

```json
{ "title"?: "string", "status"?: "regular"|"archived", "custom"?: {...} }
```

**之后**: 校验所有权后更新

**Success 200**: 更新后的 thread

**Errors**:

- `400` — body schema 校验失败
- `401` — 未登录
- `404` — 不存在或无权

## 5. DELETE /api/threads/[id]

**之后**: 校验所有权后删除

**Success 204**: 空 body

**Errors**:

- `401` — 未登录
- `404` — 不存在或无权

## 错误响应统一

```json
{ "message": "...", "code": "UNAUTHORIZED|NOT_FOUND|..." }
```

错误码:

- `UNAUTHORIZED` — 401
- `NOT_FOUND` — 404
- `BAD_REQUEST` — 400
- `INTERNAL` — 500

## 测试矩阵（必须覆盖）

| 场景                                                   | 期望 |
| ------------------------------------------------------ | ---- |
| 未登录 GET /api/threads                                | 401  |
| 未登录 POST /api/threads                               | 401  |
| 用户 A 创建 thread → userId=A.id                       | ✅   |
| 用户 A GET /api/threads 仅看到自己的                   | ✅   |
| 用户 A GET /api/threads/[B's thread id]                | 404  |
| 用户 A PATCH /api/threads/[B's thread id]              | 404  |
| 用户 A DELETE /api/threads/[B's thread id]             | 404  |
| 用户 B 删除自己账号 → 其 thread 在 DB 中消失（FR-021） | ✅   |
| 登出后任何 /api/threads/\* 返回 401（SC-005）          | ✅   |

## 兼容性

- 现有 `lib/threads/adapter.ts` 调用的 URL 与方法不变；后端 401 会让 assistant-ui 失败 → 需要在 adapter 加 session 刷新逻辑（plan 已要求在 adapter 内部处理）
- 前端在未登录访问 `/` 时被重定向到 `/login`（不在 `/api` 层处理，由 `app/page.tsx` server component 做）
