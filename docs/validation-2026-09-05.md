# 本地交付验证记录（2026-09-05）

本记录区分“已在开发机验证”和“必须在目标 Ubuntu 24 服务器或真实外部账户验证”。本地账目流程使用 `/private/tmp/personal-ledger-browser.db` 隔离数据库，没有向正式数据文件写入示例账目。

## 已通过

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 依赖 | 通过 | `npm install` 成功；`npm install-scripts ls` 无未审查安装脚本；`npm audit --omit=dev` 为 0 vulnerabilities |
| 静态与构建 | 通过 | ESLint、TypeScript、Vitest、Next.js production build 全部成功 |
| Production standalone | 通过 | 直接运行 `.next/standalone/server.js`，`/api/healthz` 返回 database reachable、schema version 1 |
| 领域规则 | 12 项测试通过 | 精确金额、香港月边界、多币种与 FX 缺口、退款日期/上限、幂等、owner 隔离、乐观锁、退款安全删除、转账不污染统计、PAT 过期/撤销 |
| MCP 内存 transport | 通过 | 官方 SDK 完成 initialize、版本协商、tools/list、get_summary 调用；未注册写工具的调用被拒绝 |
| MCP Streamable HTTP | 通过 | 真实 `/mcp` 完成新增、相同幂等键重试、汇总；撤销 PAT 后下一请求返回 401 |
| 关键手机流程 | 通过 | 390×844 浏览器实际新增 HKD 12.50，刷新后流水仍存在，统计与分类金额一致 |
| 桌面响应式 | 通过 | 1440×900 浏览器实际检查为录入/最近流水双栏布局 |
| AI 缺省状态 | 通过 | 无模型配置时统计页明确显示未配置，手工记账与统计可正常使用 |
| SQLite 备份与隔离恢复 | 通过 | 在线 backup API 生成副本；复制到独立临时数据库后再次检查为 `integrity_check=ok`、1 笔、HKD expense 1250，与备份记录一致 |
| Compose 静态配置 | 通过 | `docker compose config --no-env-resolution --quiet` 成功 |

## 尚未声称通过

- 当前 Mac 上 Docker daemon 未运行，因此没有在本机实际构建/启动 Linux 容器镜像；Next.js standalone production build 已通过。
- 未提供真实 Supabase 项目与允许邮箱，因此真实登录、会话刷新和生产白名单仍需在目标环境验收。
- 未提供模型 endpoint/key/model，因此 AI 候选与报告只完成代码、结构校验和无 key 降级，未调用真实模型。
- 尚未连接目标 Ubuntu 24 服务器、域名或公网，因此 HTTPS、手机蜂窝网络访问、Caddy 自动证书和防火墙未实测。
- 已在本地独立路径验证恢复副本；生产环境仍必须在目标服务器的独立临时 volume 再演练。仓库没有声称已配置每日定时任务。

## 上线完成门槛

按 [deployment-ubuntu.md](deployment-ubuntu.md) 配好真实环境后，至少补做：容器构建与健康检查、真实 Supabase 登录、手机蜂窝网络新增/刷新/编辑/撤销、目标 Agent 的 MCP 配置、真实 AI 一次成功与一次失败降级、独立 volume 恢复核对。
