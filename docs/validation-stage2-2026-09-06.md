# 阶段 2 验证记录（2026-09-06）

- 白名单单测验证复数配置、邮箱标准化、复数优先、旧单数兼容和空配置 fail closed。
- PAT 回归验证默认 7 天、过去时间、超过 90 天、非法日期、撤销以及禁用 profile。
- MCP 回归验证超过 256 KiB 的声明请求体在认证前被拒绝；成功认证后按 credential 限流。
- 邀请确认通过 `/auth/confirm` exchange token，白名单复核后进入 `/onboarding` 设置至少 12 字符的密码。
- `npm run check` 必须在本阶段提交前通过；真实 Supabase 邀请仍属于目标环境验收。
