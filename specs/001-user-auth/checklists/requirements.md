# Specification Quality Checklist: 用户账号与登录

**Purpose**: 验证 spec 完整性与质量，进入 plan 前的最后一道门。
**Created**: 2026-06-22
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] 不含实现细节（无 Better Auth / Resend SDK / Postgres / Drizzle 等具体技术名词）
- [x] 聚焦用户价值与业务诉求
- [x] 为非技术干系人可读
- [x] 所有强制章节已完成

> Resend 在 Assumptions 章节以"业务决策"形式记录（业务侧选型），不在功能描述中出现，符合规范。

## Requirement Completeness

- [x] 无 `[NEEDS CLARIFICATION]` 残留（所有未明项已用合理默认填入 Assumptions）
- [x] 需求可测试、无歧义（每条 FR 都可写验收脚本）
- [x] 成功标准可衡量
- [x] 成功标准不依赖具体技术栈（SC 全部以用户视角描述）
- [x] 所有验收场景已定义（P1-P3 + 横切 P4 全部覆盖 Given/When/Then）
- [x] 边界情况已识别（10 条 edge cases + FR-025 覆盖配额超限，覆盖重复/OAuth 冲突/密码/邮件/会话/并发/服务不可用/配额超限）
- [x] 范围边界清晰（Assumptions 显式列出"不实现"清单）
- [x] 依赖与假设已记录（Resend 选择 + 数据重置策略）

## Feature Readiness

- [x] 所有 FR 有明确验收路径（每个 FR 可被 P1-P3 + Edge Cases 之一覆盖）
- [x] 用户场景覆盖主要路径（注册、OAuth、跨路径隔离）
- [x] 满足 SC 中定义的可衡量结果
- [x] 无实现细节泄漏到 spec（FR-021 "级联删除"是业务行为，未点名数据库外键策略）

## Notes

- 阶段决策：plan 阶段确定 Better Auth + Drizzle adapter + Resend SDK 的具体选型与 API；spec 仅描述业务行为。
- 进入 `/speckit-clarify` 或 `/speckit-plan` 前无需回头修订 spec。
- 若未来要拆出"忘记密码"为独立 spec，需新建 feature 并 cross-link，本 spec 不预留扩展位。
