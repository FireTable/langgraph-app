# Implementation Plan: 001-user-auth

**Branch**: `001-user-auth` | **Date**: 2026-06-22 | **Spec**: [spec.md](./spec.md)

**Status**: Completed (merged via `cc1afe8` on 2026-06-23) — see tasks.md "Done When" for验收 checklist

**Input**: Feature specification from `/specs/001-user-auth/spec.md`

## Summary

为 assistant-ui + LangGraph 聊天应用引入用户账号与登录能力：邮箱密码（强制邮箱验证）+ GitHub OAuth + Google OAuth，全部走 Better Auth 自托管；邮件走 Resend 免费版（每日 100 封配额）；会话 7 天持久；聊天 thread 必须归属当前登录用户、级联删除。本期要求：业务逻辑回归到 lib/auth/，HTTP 路由通过 `/api/auth/[...all]`，数据库 schema 由 Better Auth Drizzle adapter 管理；不引入新运行时（继续用 Node.js + edge proxy）。

## Technical Context

**Language/Version**: TypeScript 6（已有）；Node.js 22（langgraphjs CLI 要求）

**Primary Dependencies**（新增）：

- `better-auth` — 自托管 auth 框架，Better Auth 团队官方维护
- `better-auth/adapters/drizzle` — Drizzle ORM 原生 adapter
- `resend` — Resend 官方 Node SDK
- `react-email` — Resend 维护的统一包（v6.x），合并了原 `@react-email/components` + `@react-email/render`；导出 `<Html>` / `<Container>` / `<Button>` / `<Tailwind>` 等组件 + `render` 函数
- 邮件模板 fork 自 `resend/react-email` canary 分支的 `02-Matte/activation.tsx`（MIT 许可）

**Storage**: PostgreSQL 16（已有）；Better Auth 4 张表（user / session / account / verification）由 Drizzle schema 接管；`threads.userId` 改 `NOT NULL` + 外键 + `ON DELETE CASCADE`

**Testing**: Vitest（已有）；新增 `tests/auth/` 覆盖 Better Auth 配置 + 路由 + 数据库约束；`tests/api/threads.test.ts` 增加所有权场景

**Target Platform**: Linux/macOS 本地 dev；生产部署目标沿用现有 Next.js + 同 Postgres 实例

**Project Type**: Web app（Next.js 16 App Router + assistant-ui 前端 + LangGraph 后端，无独立 service）

**Performance Goals**:

- 注册到首条消息端到端 ≤ 2 分钟（SC-001，不计邮件投递延迟）
- OAuth 全流程 ≤ 10 秒（SC-004）
- 受保护请求在未登录时 ≤ 50ms 返回 401（baseline 假设）

**Constraints**:

- Resend 免费版每日 100 封（FR-025）
- Better Auth 在 Next.js 中可跑在 edge runtime（与现有 `/api/[..._path]/route.ts` 保持一致）
- 数据库单实例，无 Redis；session store 必须用 Postgres

**Scale/Scope**（MVP）：< 100 注册用户/日；< 10 并发会话；无弹性伸缩需求

## Constitution Check

_GATE: 必须通过方可进入 Phase 0 research；Phase 1 设计后再次复审。_

### 原则一：规格 / 代码 / 文档同步 ✅

- `docs/APIS.md` 必须随本期新增的 `/api/auth/[...all]` route 更新（同一 commit）
- `docs/AUTH.md` 新建（spec Assumptions 已强制）
- `README.md` 认证章节更新
- `.env.example` 列出全部认证相关变量

### 原则二：测试先行（不可妥协）✅

- `lib/auth/config.ts` / `lib/auth/handler.ts` / `lib/auth/queries.ts` ≥ 90% 覆盖率
- `/api/auth/[...all]/route.ts` 每个分支（注册 / 登录 / OAuth 回调 / 登出 / 验证邮件 / 重新发送）覆盖
- `/api/threads/*` route 每个分支覆盖所有权检查（401 / 404 路径）

### 原则三：首选标准方案 ✅

- 用 Better Auth 官方 Drizzle adapter（不用手写 session 逻辑）
- 用 Resend 官方 SDK（不用 SMTP 协议）
- 用 react-email 官方组件（不用 inline HTML/CSS）
- 用 drizzle-kit 生成/管理 migration（不用自定义脚本）

### 原则四：UI 改动必须视觉验证 ✅

- `/login` 页 + 主页 session guard 通过 Chrome DevTools MCP 截图验证
- 验证邮件 HTML 在 Litmus / Email on Acid 之外，本期通过 Gmail / Outlook Web 手动截图验收（spec 声明）

### 原则五：注释克制、说"为什么" ✅

- 仅在 Better Auth 特殊行为、Next.js edge runtime 限制、Resend 免费版配额等需要解释"为什么"时加注释

### 原则六：Spec-kit 文档中文输出 ✅

- 本 plan.md + research.md + data-model.md + quickstart.md 全中文
- `.env.example` 注释、commit message、代码注释保持英文
- UI 文案英文（spec 澄清决策）

**Phase 1 后复审**：✅ 全部通过；无 violation 需要 justification。

## Project Structure

### Documentation（本 feature）

```text
specs/001-user-auth/
├── plan.md              # 本文件
├── research.md          # Phase 0 输出
├── data-model.md        # Phase 1 输出
├── quickstart.md        # Phase 1 输出
├── contracts/           # Phase 1 输出
│   ├── api-auth.md      # /api/auth/* 路由契约
│   └── api-threads-ownership.md  # /api/threads/* 所有权变更契约
└── tasks.md             # Phase 2 由 /speckit-tasks 生成（当前不在本 plan 范围）
```

### Source Code（仓库根）

```text
lib/
├── auth/                        # 本期新增
│   ├── schema.ts                # Better Auth 4 张表的 Drizzle schema
│   ├── config.ts                # betterAuth() 实例
│   ├── client.ts                # 浏览器端 createAuthClient()
│   ├── queries.ts               # 会话查询助手（getCurrentUser 等）
│   └── validators.ts            # Zod 校验：注册/登录 body
├── threads/
│   ├── schema.ts                # 修改 userId: NOT NULL + FK
│   ├── queries.ts               # 修改：所有方法加 userId 参数
│   ├── adapter.ts               # 修改：调用 Better Auth session 注入 Authorization header
│   └── validators.ts            # 不变
└── email/                       # 本期新增
    ├── theme.ts                 # Tailwind v4 config（fork 自 Matte 模板的 collageTailwindConfig）
    ├── collage-fonts.tsx        # 字体加载组件（fork 自 Matte 模板的 CollageFonts）
    └── verification-template.tsx  # react-email 组件（fork 自 02-Matte/activation.tsx，props: companyName, verificationUrl, userEmail）

public/
└── email/                       # 本期新增（Next.js 静态资源）
    └── collage-image-1.png      # 从 resend/react-email demo 复制（MIT）

app/
├── api/
│   ├── auth/[...all]/route.ts   # 本期新增：Better Auth catch-all
│   └── threads/
│       ├── route.ts             # 修改：session 守卫
│       └── [id]/route.ts        # 修改：session 守卫 + 所有权检查
├── login/
│   └── page.tsx                 # 本期新增：登录页
├── verify-email/
│   └── page.tsx                 # 本期新增：验证邮件落地页（处理 token 跳转）
└── page.tsx                     # 修改：未登录重定向到 /login

components/
└── auth/                        # 本期新增
    ├── email-password-form.tsx  # 注册/登录表单
    └── oauth-buttons.tsx        # GitHub + Google 按钮

db/
├── schema.ts                    # 修改：re-export Better Auth tables
└── migrations/                  # 由 drizzle-kit 生成

tests/
├── auth/                        # 本期新增
│   ├── config.test.ts
│   ├── handler.test.ts
│   └── queries.test.ts
├── api/
│   └── threads.test.ts          # 修改：增加所有权测试
└── threads/
    └── queries.test.ts          # 修改：所有函数签名变化

.env.example                     # 修改
README.md                        # 修改
docs/AUTH.md                     # 新建
docs/APIS.md                     # 修改
```

**Structure Decision**: 单仓库（沿用现有 Next.js 16 + LangGraph 共存架构）。不引入新 package，不拆分 monorepo。Better Auth + Drizzle adapter 集成在现有 `db/schema.ts` 旁。

## Complexity Tracking

无 violation 需要 justification。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --------- | ---------- | ------------------------------------ |
| （无）    | —          | —                                    |
