# 2026-09-06 P0/P1 工作树验证记录

## 范围

基线为机器审计对应提交 `f4f67da`。本记录验证尚未提交的工作树改动，覆盖版本化迁移闸门、只读历史异常扫描，以及审计 A01–A04、A07；不把 A05/A06、A08–A10 或后续多用户加密、元数据、月度 UI、自动汇率和 AI provider 计划标记为已完成。

## 自动检查

执行 `npm run check`：

- ESLint：通过；
- TypeScript `tsc --noEmit`：通过；
- Vitest：3 个测试文件、21 项测试通过；
- Next.js 16.3.4 production build：通过，动态 API/MCP 路由成功生成。

新增回归覆盖：显式分类下的超额/异币/错误来源退款、已删除原消费、带偏移时间和等价 UTC 查询、非法日期和反向区间、FX 金额重算、改币种后失效、显式换率、错误目标币种、零汇率、统计防御性忽略错误快照，以及负数金额显示。

## 迁移与数据审计 smoke

- 对全新临时 SQLite 执行 `npm run db:migrate`：应用 v1 并写入迁移 checksum；再次执行无变更。
- 对不含迁移账本的旧 v1 临时 SQLite 执行迁移：先创建通过完整性检查的 `pre-migrate-v1-*.db`，再登记 baseline，没有重放初始建表 SQL。
- 对空的合成数据库执行 `npm run db:audit`：五类 findings 均为 0。
- 注入一个 CNY 目标且金额陈旧的合成 FX 快照后再次审计：同时报告 `MISMATCHED_FX_TARGET` 和 `INVALID_OR_STALE_FX_AMOUNT`，退出码为 2；脚本未改写数据。
- `docker compose config --no-interpolate --quiet`：通过。

## 未验证边界

本机 Docker daemon 未运行，因此没有构建或启动 migrator/app 镜像。没有迁移或扫描真实账本文件，没有测试真实 Supabase、Ubuntu、HTTPS、手机、MCP HTTP、外部模型或生产恢复。本记录是工作树工程验证，不是发布或运行环境验收。
