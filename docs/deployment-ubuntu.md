# Ubuntu 24 部署检查

## 前置条件

- 域名 A/AAAA 记录指向服务器。
- 防火墙允许 TCP 22、80、443 与 UDP 443；SSH 端口以服务器实际设置为准。
- 安装受支持的 Docker Engine 和 Compose plugin。
- 服务器磁盘具备足够空间，Docker data-root 位于持久磁盘。

## 配置

复制 `.env.example` 为 `.env.production`，至少填写：

```dotenv
APP_ORIGIN=https://ledger.example.com
DATABASE_PATH=/app/data/ledger.db
LOCAL_DEV_AUTH=false
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_replace_me
ALLOWED_AUTH_EMAIL=you@example.com
```

AI 三个变量可留空。另建只供 Compose 插值的 `.env`：

```dotenv
APP_DOMAIN=ledger.example.com
```

## 上线核对

```bash
docker compose config
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 app
curl --fail https://ledger.example.com/api/healthz
```

随后用手机蜂窝网络完成一次登录、创建、刷新、编辑和撤销；用桌面端确认同一流水可见。签发一个短期 MCP PAT，用官方 SDK 示例执行 `initialize`、`tools/list` 和一次允许的调用，再撤销并确认立即返回 401。

## 更新

更新前先在线备份并复制到服务器外。然后拉取明确版本并运行：

```bash
docker compose build --pull
docker compose up -d
curl --fail https://ledger.example.com/api/healthz
```

不要运行两个 app 副本做滚动更新；SQLite 模式采用短暂停机替换单实例。
