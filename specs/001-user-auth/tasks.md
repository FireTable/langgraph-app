# Tasks: 001-user-auth

**Input**: Design documents from `/specs/001-user-auth/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: TDD mandatory per宪法原则二。每个 user story 都有对应的"红测试"任务，必须先写后实现。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件，无依赖）
- **[Story]**: 归属哪个 user story（US1 / US2 / US3 / US4）
- 描述必须含确切文件路径

---

## Phase 1: Setup（共享基础设施）

**Purpose**: 项目初始化与基础结构

- [x] T001 [P] 安装 Better Auth + Resend + react-email 依赖：`pnpm remove @react-email/components @react-email/render && pnpm add better-auth resend react-email`（`@react-email/components` 已被 npm 标记 deprecated，统一包 `react-email@6.6.3` 取代）
- [x] T002 [P] 重置数据库并清理旧 migrations：`pnpm db:reset && rm -rf db/migrations`
- [x] T003 [P] 更新 `.env.example` 加入 `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` / `GITHUB_CLIENT_ID|SECRET` / `GOOGLE_CLIENT_ID|SECRET` / `RESEND_API_KEY` / `RESEND_FROM_EMAIL` 占位符与说明

---

## Phase 2: Foundational（阻塞前置）

**Purpose**: 所有 user story 必须的前置基础设施

**⚠️ CRITICAL**: 此 phase 完成前不能开始任何 user story

- [ ] T004 编写 Better Auth config 骨架 `lib/auth/config.ts`（含 email/password + GitHub + Google + emailVerification.sendVerificationEmail 占位 + trustedOrigins），使 CLI 可 introspection
- [ ] T005 运行 `npx @better-auth/cli@latest generate --config ./lib/auth/config.ts --output ./lib/auth/schema.ts -y` 生成 Drizzle schema 文件 `lib/auth/schema.ts`
- [ ] T006 在 `db/schema.ts` barrel 加 `export * from "@/lib/auth/schema";`
- [ ] T007 [P] 修改 `lib/threads/schema.ts`：`userId` 改 `text("user_id").notNull()` + `.references(() => user.id, { onDelete: "cascade" })`，加 `threads_user_id_idx`
- [ ] T008 运行 `pnpm db:generate` 生成新 migration（含 4 张 auth 表 + threads.userId NOT NULL FK），再 `pnpm db:migrate` 应用到 dev + test 数据库
- [ ] T009 [P] 创建 Better Auth catch-all route `app/api/auth/[...all]/route.ts`（导出 `GET` + `POST`，透传 `auth.handler`）
- [ ] T010a [P] fork 自 `resend/react-email` canary 分支 `apps/demo/emails/02-Matte/activation.tsx` 的验证邮件模板 `lib/email/verification-template.tsx`：props `verificationUrl` + `userEmail`，保留顶部 `Upstream: github.com/resend/react-email (MIT); Adapted for 001-user-auth` 注释
- [ ] T010b [P] Tailwind v4 config `lib/email/theme.ts`（fork 自 `collageTailwindConfig`，含 `bg-canvas` / `bg-bg` / `bg-brand` / `text-fg` / `text-fg-2` / `font-48` / `font-15` 等 token）
- [ ] T010c [P] 字体加载组件 `lib/email/collage-fonts.tsx`（fork 自 `<CollageFonts />`，通过 `<link>` 注入 Inter / Press Start 2P 等 Google Fonts）
- [ ] T010d [P] 复制静态图片 `public/email/collage-image-1.png`（从 resend/react-email demo `apps/demo/emails/02-Matte/static/` 下载，MIT）；模板里的 `${baseUrl}/static/collage/...` 路径改为 `/email/...` 走 Next.js public/
- [ ] T011 [P] 创建浏览器端 auth client `lib/auth/client.ts`（`createAuthClient` 含 emailPasswordClient + social 客户端）
- [ ] T012 [P] 创建登录页 `app/login/page.tsx`（server component；渲染 OAuthButtons + EmailPasswordForm；处理 `?verified=1` / `?verify=1` / `?error=...` query 参数显示 banner）
- [ ] T013 [P] 创建 OAuth buttons 组件 `components/auth/oauth-buttons.tsx`（GitHub + Google 两个按钮，client component，调用 `authClient.signIn.social({ provider })`）
- [ ] T014 [P] 创建 email-password 表单组件 `components/auth/email-password-form.tsx`（sign-up / sign-in 模式切换，调用 `authClient.signUp.email` / `authClient.signIn.email`，错误码 → 英文文案）
- [ ] T015 [P] 创建 verify-email 落地页 `app/verify-email/page.tsx`（渲染 "Verifying..." spinner + 调用 Better Auth 处理 token）
- [ ] T016 创建 session 查询助手 `lib/auth/queries.ts`：`getSessionFromHeaders(headers)` 调用 `auth.api.getSession({ headers })`
- [ ] T017 修改主页 `app/page.tsx`：server component 顶部检查 session；未登录 `redirect("/login")`；登录后渲染原 Assistant UI
- [ ] T018 在 `lib/auth/config.ts` 的 `betterAuth({ emailAndPassword: { enabled: true, requireEmailVerification: true }, socialProviders: { github, google } })` 完整配置

**Checkpoint**: 基础就绪 — user story 实现可并行开始

---

## Phase 3: User Story 4 — 聊天会话归属与隔离（横切）

**Goal**: 所有 user story 都必须满足的 thread 数据隔离（FR-017 ~ FR-021）

**Independent Test**: 注册 A、B 两个账号；A 创建 thread；B 列表为空；B 直接访问 A 的 thread URL 返回 404；删除 B 后其 thread 在 DB 消失

### Tests for User Story 4 ⚠️ 先写后实现（红 → 绿）

- [ ] T019 [P] [US4] threads 路由所有权 contract 测试 `tests/api/threads.test.ts`：未登录返回 401；跨用户访问返回 404；自己创建/读/改/删返回 200
- [ ] T020 [P] [US4] threads cascade 删除测试 `tests/api/threads-cascade.test.ts`：DB 直接删 user 行 → 该用户所有 thread 在 5 秒内消失（FR-021 / SC-007）

### Implementation for User Story 4

- [ ] T021 [US4] 修改 `lib/threads/queries.ts`：所有方法加 `userId` 参数（`listThreadsForUser(userId)` / `getThreadForUser(id, userId)` / `createThread(userId, title?)` / `updateThread(id, userId, patch)` / `deleteThread(id, userId)`），内部用 `eq(threads.userId, userId)` 过滤
- [ ] T022 [US4] 修改 `app/api/threads/route.ts`：GET 列表调用 `listThreadsForUser(session.user.id)`；POST 创建调用 `createThread(session.user.id)`；无 session 返回 401
- [ ] T023 [US4] 修改 `app/api/threads/[id]/route.ts`：GET/PATCH/DELETE 全部先 `getThreadForUser(id, session.user.id)`；不存在或不属于返回 404
- [ ] T024 [US4] 修改 `lib/threads/adapter.ts`：所有 fetch 调用 `credentials: "include"` 转发 session cookie
- [ ] T025 [US4] 更新 `tests/threads/queries.test.ts`：所有函数签名变化后的契约测试

**Checkpoint**: User Story 4 完整功能与测试

---

## Phase 4: User Story 1 — 邮箱密码注册并使用（优先级 P1 🎯 MVP）

**Goal**: 邮箱密码注册 → 收验证邮件 → 点链接 → 登录 → 聊天

**Independent Test**: 用一个测试邮箱走完"注册 → 收件箱点链接 → 登录 → 发消息 → 退出 → 重新登录 → 看到历史"全流程，无需任何 OAuth 凭据

### Tests for User Story 1 ⚠️ 先写后实现

- [ ] T026 [P] [US1] sign-up 集成测试 `tests/auth/sign-up.test.ts`：happy path（200 + 创建 user + 触发 sendVerificationEmail）；重复邮箱 → `EMAIL_TAKEN`；密码 < 8 字符 → `PASSWORD_TOO_WEAK`；非法邮箱格式 → `EMAIL_INVALID`；Resend 返回 429 → `EMAIL_QUOTA_EXCEEDED` 且不创建 user（FR-009 / FR-022 / FR-023 / FR-025）
- [ ] T027 [P] [US1] sign-in 集成测试 `tests/auth/sign-in.test.ts`：happy path（200 + session cookie）；错误密码 → `INVALID_CREDENTIALS`；未验证邮箱 → `EMAIL_NOT_VERIFIED`（FR-006）
- [ ] T028 [P] [US1] sign-out 集成测试 `tests/auth/sign-out.test.ts`：happy path（删除 session 行 + 清 cookie）；登出后任何受保护请求返回 401（SC-005）
- [ ] T029 [P] [US1] verify-email 集成测试 `tests/auth/verify-email.test.ts`：合法 token 验证成功 + 删除 verification 行；过期 token 返回 `TOKEN_EXPIRED`；重新发送验证邮件使旧 token 失效（FR-005 / FR-006 / FR-008）
- [ ] T030 [P] [US1] 单元测试 `lib/auth/validators.test.ts`：email 格式、password 强度（≥8 + 字母 + 数字）的 Zod 校验

### Implementation for User Story 1

- [ ] T031 [US1] 实现 `sendVerificationEmail` 回调 in `lib/auth/config.ts`：调用 `resend.emails.send({ from, to, subject, html: await render(<VerificationTemplate url={url} userEmail={user.email} />) })`；`render` 从 `react-email` 导入（非 `@react-email/render`）；捕获 429 → 抛出 `EMAIL_QUOTA_EXCEEDED`；捕获其他错误 → 抛出 `INTERNAL`（FR-004 / FR-023 / FR-025）
- [ ] T032 [US1] 实现 Zod 校验 in `lib/auth/validators.ts`：`emailSchema`（RFC 5322）+ `passwordSchema`（≥8 + `/[a-zA-Z]/` + `/[0-9]/`）+ `signUpBodySchema` + `signInBodySchema`
- [ ] T033 [US1] 在 `components/auth/email-password-form.tsx` 接入 `authClient.signUp.email({ email, password, name })` 与 `authClient.signIn.email(...)`；错误码映射到英文文案；成功 → `router.push("/?verify=1")` 或 `"/"`
- [ ] T034 [US1] 在 `app/verify-email/page.tsx` 用 `useEffect` 调用 `authClient.verifyEmail({ query })` 处理 token；成功 → `router.push("/login?verified=1")`；失败 → `router.push("/login?error=expired")`

**Checkpoint**: User Story 1 完整可独立测试 → **MVP 即可演示**

---

## Phase 5: User Story 2 — GitHub 一键登录（优先级 P2）

**Goal**: 点 GitHub 按钮 → 授权 → 登录

**Independent Test**: 配 GitHub OAuth 凭据后，访客走完授权、回到应用并能立即发消息

### Tests for User Story 2 ⚠️ 先写后实现

- [ ] T035 [P] [US2] GitHub OAuth 集成测试 `tests/auth/oauth-github.test.ts`：sign-in/social 入口返回 302 重定向到 github.com；callback 成功创建 user + account 行 + session；callback 失败 → 302 到 `/login?error=oauth_failed`；与已有 email/password 账号合并（FR-011 / FR-012 / FR-013）

### Implementation for User Story 2

- [ ] T036 [US2] 在 `lib/auth/config.ts` 完整配置 GitHub provider：`socialProviders.github = { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET }`
- [ ] T037 [US2] 在 `components/auth/oauth-buttons.tsx` 的 GitHub 按钮 onClick 调用 `authClient.signIn.social({ provider: "github", callbackURL: "/" })`

**Checkpoint**: User Story 2 独立可用

---

## Phase 6: User Story 3 — Google 一键登录（优先级 P3）

**Goal**: 点 Google 按钮 → 授权 → 登录

**Independent Test**: 配 Google OAuth 凭据后，访客走完授权、回到应用并能立即发消息

### Tests for User Story 3 ⚠️ 先写后实现

- [ ] T038 [P] [US3] Google OAuth 集成测试 `tests/auth/oauth-google.test.ts`：与 T035 对称（FR-010）

### Implementation for User Story 3

- [ ] T039 [US3] 在 `lib/auth/config.ts` 完整配置 Google provider：`socialProviders.google = { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }`
- [ ] T040 [US3] 在 `components/auth/oauth-buttons.tsx` 的 Google 按钮 onClick 调用 `authClient.signIn.social({ provider: "google", callbackURL: "/" })`

**Checkpoint**: 全部 user stories 独立可用

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: 影响多个 user story 的最后打磨

- [ ] T041 [P] 更新 `docs/APIS.md`：添加 `/api/auth/sign-up/email`、`/api/auth/sign-in/email`、`/api/auth/sign-out`、`/api/auth/get-session`、`/api/auth/verify-email`、`/api/auth/send-verification-email`、`/api/auth/sign-in/social`、`/api/auth/callback/:provider` 八节；标记 `/api/threads/*` 已加 session 守卫 + 所有权变更（宪法原则一）
- [ ] T042 [P] 新建 `docs/AUTH.md`：完整运维手册（GitHub/Google OAuth App 创建步骤、Resend 域名验证、本地与生产环境变量、常见排错、Stage 2 路线图 — 忘记密码 / MFA / 团队等）
- [ ] T043 [P] 更新 `README.md`：新增 "Authentication" 章节，描述注册、登录、登出、OAuth 配置入口、邮件验证流程
- [ ] T044 运行 `quickstart.md` 的 9 个端到端场景（手动 / Chrome DevTools MCP），全部通过
- [ ] T045 [P] 视觉验证：Chrome DevTools MCP 打开 `/login`（空态 + 错误态 + 验证提示态）和登录后 `/` 截图，确认 UI 正常
- [ ] T046 [P] 视觉验证：将验证邮件发到 Gmail / Outlook Web 截图，确认 HTML 模板跨客户端美观（FR-005 / 宪法原则四）
- [ ] T047 [P] 覆盖率审计：`pnpm test --coverage`；`lib/auth/*` ≥ 90%；`app/api/**/route.ts` 每个分支覆盖；不达标时补测试

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖 — 立刻开始
- **Foundational (Phase 2)**: 依赖 Setup 完成 — **阻塞所有 user story**
- **User Story 4 (Phase 3)**: 依赖 Foundational（需要 auth handler + session helper）
- **User Story 1 (Phase 4)**: 依赖 Foundational；可与 US4 并行
- **User Story 2 (Phase 5)**: 依赖 Foundational；可与 US4 / US1 并行（仅共享 Better Auth config）
- **User Story 3 (Phase 6)**: 依赖 Foundational；可与 US4 / US1 / US2 并行
- **Polish (Phase 7)**: 依赖所有目标 user story 完成

### User Story Dependencies

- **US4 (横切)**: Foundational 之后即可；独立可测
- **US1 (P1)**: Foundational 之后即可；独立可测（不依赖 US4 — 但实际跑通需要 US4 验证 thread 隔离）
- **US2 (P2)**: Foundational 之后即可；独立可测
- **US3 (P3)**: Foundational 之后即可；独立可测

### Within Each User Story

- Tests 必须先写并 FAIL（红），后实现（绿）
- Schema 在 service / route 之前
- Service 在 endpoint 之前
- 核心实现后做集成

### Parallel Opportunities

- Phase 1 三个 T001/T002/T003 可并行
- Phase 2 内 T007/T009/T010/T011/T012/T013/T014/T015 可并行（不同文件）
- Phase 4 完成后，US4 / US1 / US2 / US3 可由不同开发者并行
- 每个 user story 内所有 [P] 测试可并行

---

## Parallel Examples

```bash
# Phase 1 并行
Task: "T001 安装 better-auth + resend + react-email 依赖"
Task: "T002 重置数据库并清理旧 migrations"
Task: "T003 更新 .env.example"

# Phase 3 (US4) 内并行测试
Task: "T019 [P] [US4] threads 路由所有权 contract 测试"
Task: "T020 [P] [US4] threads cascade 删除测试"

# Phase 4 (US1) 内并行测试
Task: "T026 [P] [US1] sign-up 集成测试"
Task: "T027 [P] [US1] sign-in 集成测试"
Task: "T028 [P] [US1] sign-out 集成测试"
Task: "T029 [P] [US1] verify-email 集成测试"
Task: "T030 [P] [US1] 单元测试 validators"

# 多用户故事并行（团队）
Dev A: "T019..T025 [US4] thread 所有权"
Dev B: "T026..T034 [US1] 邮箱密码"
Dev C: "T035..T037 [US2] GitHub OAuth"
Dev D: "T038..T040 [US3] Google OAuth"
```

---

## Implementation Strategy

### MVP First（仅 US4 + US1）

1. ✅ Phase 1: Setup（3 任务）
2. ✅ Phase 2: Foundational（14 任务）
3. ✅ Phase 3: US4 thread 所有权（7 任务）
4. ✅ Phase 4: US1 邮箱密码（9 任务）
5. **STOP & VALIDATE**: 用 `quickstart.md` 场景 1-4 + 7 验证：邮箱注册 → 验证 → 登录 → 跨用户隔离
6. **Demo / Deploy**

US1 完成时已具备：
- 公开注册
- 邮箱验证
- 登录 / 登出
- Thread 数据隔离
- 文档基础

US2 / US3 是 OAuth 增量，不阻塞核心使用。

### Incremental Delivery

1. Setup + Foundational → 基础就绪
2. + US4 → 数据隔离（用户注册后无法看到他人 thread）
3. + US1 → 邮箱密码 MVP（最小可用产品）
4. + US2 → GitHub OAuth
5. + US3 → Google OAuth
6. + Polish → 文档 + 视觉验证

### Solo Developer Strategy

单线程顺序执行，跳过并行。任务粒度已按单次 commit 设计：每个 task 或 logical group 提交一次。

---

## Notes

- 所有 [P] 任务并行要求"不同文件，无依赖"
- [Story] 标签保证可追溯到 spec.md 的 user story
- 每个 user story 必须独立可完成 / 可测试
- 每个 commit 前确认测试通过（红 → 绿循环）
- Phase 2 完成时停下来跑一次 `pnpm test`，确保基础不会让后续 story 失败
- Phase 7 完成后跑完整 quickstart.md 9 个场景

---

## Done When

- [ ] 所有 47 个 task 标记为 `[x]`
- [ ] `pnpm test` 全绿
- [ ] `pnpm lint` 全绿
- [ ] `quickstart.md` 9 个场景手动验证全过
- [ ] `docs/APIS.md` / `docs/AUTH.md` / `README.md` 全部更新
- [ ] 宪法原则四（UI 视觉验证）已通过 Chrome DevTools MCP 完成