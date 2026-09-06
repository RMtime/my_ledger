# Ubuntu 24 部署检查

## 前置条件

- 域名 A/AAAA 记录指向服务器。
- 防火墙允许 TCP 22、80、443；SSH 端口以服务器实际设置为准。
- 宿主机上的 nginx 负责终止 TLS 与证书续期（例如 certbot）。应用容器只监听 `127.0.0.1:3000`，不直接对公网暴露。
- 安装受支持的 Docker Engine 和 Compose plugin。
- 服务器磁盘具备足够空间，Docker data-root 位于持久磁盘。

## 配置

复制 `.env.example` 为 `.env.production`，至少填写：

```dotenv
APP_ORIGIN=https://ledger.example.com
DATABASE_PATH=/app/data/ledger.db
MIGRATION_BACKUP_DIR=/app/backups
LOCAL_DEV_AUTH=false
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_replace_me
ALLOWED_AUTH_EMAILS=you@example.com,partner@example.com
```

AI 相关变量可留空。`APP_ORIGIN` 必须与用户浏览器实际访问的地址完全一致——写请求会用它做同源校验，MCP 会用它校验 Host。

## nginx 站点配置

应用容器只发布到 `127.0.0.1:3000`，由 nginx 反代：

```nginx
server {
    listen 443 ssl http2;
    server_name ledger.example.com;

    ssl_certificate     /etc/letsencrypt/live/ledger.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ledger.example.com/privkey.pem;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Host 必须透传真实域名。应用用它校验 MCP 请求来源，
        # 若这里变成 127.0.0.1:3000，网页仍可用但 MCP 会返回 403。
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
    }

    # MCP 走 Streamable HTTP，需要关闭缓冲并放宽读超时，
    # 否则长响应会被 nginx 攒着不发。
    location /mcp {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header Connection        "";
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}

server {
    listen 80;
    server_name ledger.example.com;
    return 301 https://$host$request_uri;
}
```

HSTS、`X-Content-Type-Options` 与 `Referrer-Policy` 由应用自身发出（见 `next.config.ts`），nginx 不需要重复设置。

## 上线核对

```bash
docker compose config --quiet
docker compose build
docker compose run --rm migrate
docker compose run --rm migrate npm run db:audit
docker compose up -d
docker compose ps
docker compose logs --tail=100 app
curl --fail https://ledger.example.com/api/healthz
```

随后用手机蜂窝网络完成一次登录、创建、刷新、编辑和撤销；用桌面端确认同一流水可见。签发一个短期 MCP PAT，用官方 SDK 示例执行 `initialize`、`tools/list` 和一次允许的调用，再撤销并确认立即返回 401。

MCP 那一步同时验证 nginx 的 Host 透传：如果返回 403「Host 不在允许列表」，说明 `proxy_set_header Host $host` 缺失或写错。

## 更新

更新前先在线备份并复制到服务器外。然后拉取明确版本，停止唯一写入实例，显式运行迁移，再启动新版本：

```bash
docker compose stop app
docker compose build --pull
docker compose run --rm migrate
docker compose run --rm migrate npm run db:audit
docker compose up -d
curl --fail https://ledger.example.com/api/healthz
```

迁移器在 schema 发生变化前还会向 `/app/backups` 写入一份通过 `integrity_check` 的自动备份；这不能代替更新前复制到服务器外的备份。任何 checksum 不一致、未知版本、缺表、外键错误或完整性错误都会终止迁移。不要运行两个 app 副本做滚动更新；SQLite 模式采用短暂停机替换单实例。
