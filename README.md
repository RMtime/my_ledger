# 寸金 · 私人账本

面向单用户的移动优先记账应用。Next.js Web、HTTP API 与 MCP 共用同一套账本服务，账目保存在服务器持久化 SQLite 文件中；默认简体中文、`Asia/Hong_Kong`、HKD，并支持 HKD/CNY/USD 原币统计。

## 已实现

- 快速录入、页面内断网待提交、复制新账、流水编辑与软删除
- 精确整数金额、原币分组、手工汇率快照和换算覆盖率
- 退款日期口径、退款上限事务保护、版本乐观锁、幂等创建
- Supabase Auth 单用户白名单；开发环境可显式启用本地身份
- SHA-256 PAT、权限化 MCP tools、撤销/过期检查和审计
- AI 候选确认与基于确定性快照的报告；无 key 时核心功能正常
- JSON/CSV 导出、SQLite 在线备份、Docker Compose + Caddy HTTPS

## 本地运行

要求 Node.js 24 或 26。首次安装：

```bash
npm install
cp .env.example .env.local
npm run db:migrate
npm run db:seed
npm run dev
```

`.env.example` 中的 `LOCAL_DEV_AUTH=true` 只在非生产环境生效。种子命令只创建本地用户、分类和渠道，不创建示例账目。

验证：

```bash
npm run lint
npm run typecheck
npm test
npm run test:mcp
npm run build
```

若要验证真实 Streamable HTTP transport，先启动开发服务器，再在相同 `DATABASE_PATH` 下运行 `npm run test:mcp:http`。本次本地验收记录见 [docs/validation-2026-09-05.md](docs/validation-2026-09-05.md)。

## Ubuntu 24 部署

服务器需要 Docker Engine、Compose plugin、可解析到服务器公网 IP 的域名，以及开放 TCP 80/443 和 UDP 443。部署不依赖开发电脑持续在线。

1. 将仓库复制或 clone 到服务器，创建 `.env.production`，确保 `LOCAL_DEV_AUTH=false`。
2. 在 shell 环境或同目录 `.env` 设置 `APP_DOMAIN=ledger.example.com`；在 `.env.production` 设置 `APP_ORIGIN=https://ledger.example.com`。
3. 配置 Supabase URL、publishable key 和唯一允许邮箱；在 Supabase 控制台关闭公开注册。
4. 启动：

```bash
docker compose build
docker compose up -d
docker compose ps
curl --fail https://ledger.example.com/api/healthz
```

SQLite 位于命名卷 `ledger-data`，不在镜像和容器临时层中。应用必须保持一个副本；不要把数据库文件放到 NFS/SMB，也不要同时启动第二个写入实例。Caddy 自动申请和续期 HTTPS 证书；若服务器已有反向代理，只启动 `app` 并把 HTTPS 流量转发至容器 3000 端口。

## MCP 接入

在“设置 → Agent 凭证”中签发 PAT；token 只显示一次。服务地址为 `https://你的域名/mcp`，私有 PAT 放入 `Authorization: Bearer ...`。这是受控客户端 PAT，不是 MCP OAuth。

```bash
LEDGER_MCP_URL=https://ledger.example.com/mcp \
LEDGER_MCP_TOKEN=plg_replace_me \
npx tsx examples/mcp-client.ts
```

工具由权限决定：只给 `analytics:read` 的 PAT 在 `tools/list` 中只能看到 `get_summary`，实际调用写工具也会被服务端拒绝。`create_transaction` 首版只接受支出和收入。

## 备份

在线一致性备份及完整性、数量、各币种汇总检查：

```bash
docker compose exec app node scripts/backup.mjs /app/backups/ledger-$(date +%F).db
```

把 `ledger-backups` 卷的备份再同步到独立、加密的位置。定时任务和保留周期需要由服务器管理员配置；仓库不会把“提供脚本”冒充“已经自动备份”。恢复演练见 [docs/backup-restore.md](docs/backup-restore.md)。

## 安全边界

- 浏览器只调用应用 API，不直接打开数据库文件或 Supabase Data API。
- 所有 repository 操作携带 `owner_id`，owner 不接受客户端输入；外部引用按 owner 二次校验。
- MCP PAT、Supabase session 和 AI key 相互独立；日志不输出这些秘密。
- 首版是单用户消费记录工具，不接银行、不保存卡号、不进行资金操作，也不宣称复式会计或准确账户余额。

架构决策见 [docs/adr-001-sqlite-single-node.md](docs/adr-001-sqlite-single-node.md)，部署检查见 [docs/deployment-ubuntu.md](docs/deployment-ubuntu.md)。
