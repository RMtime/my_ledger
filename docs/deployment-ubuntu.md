# Ubuntu 24 部署检查

## 前置条件

- 域名 A/AAAA 记录指向服务器。
- 防火墙允许 TCP 22、80、443；SSH 端口以服务器实际设置为准。
- 宿主机上的 nginx 负责终止 TLS 与证书续期（例如 certbot）。应用容器只监听 `127.0.0.1:3000`，不直接对公网暴露。
- 安装受支持的 Docker Engine、Compose plugin 和 Python 3（部署脚本只用它解析 Compose JSON，不接触账本内容）。
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

首次取得部署脚本时，在服务器仓库中先手工快进一次，然后执行脚本：

```bash
git pull --ff-only origin main
./scripts/deploy-update.sh
```

以后每次更新只需在服务器仓库运行：

```bash
./scripts/deploy-update.sh
```

脚本会锁定并发部署、拒绝脏工作树或分叉历史、从 `origin/main` 仅做 fast-forward、使用 SQLite backup API 创建并验证备份、比对容器与宿主机副本的 SHA-256，并在停机前确认新旧 Compose 仍指向同一组持久卷与数据库路径。旧应用会在新镜像构建期间继续服务；随后脚本短暂停止唯一写入实例，依次迁移、审计、启动，并要求容器健康状态及健康端点 JSON 都通过。默认宿主机备份目录是仓库同级的 `my-ledger-deploy-backups`；脚本首次创建它时权限为 `0700`，所有新备份文件权限为 `0600`。可用 `DEPLOY_BACKUP_EXPORT_DIR` 指向另一个专用目录或持久磁盘；若该目录已存在，脚本不会擅自修改权限，但会要求它已禁止 group/other 访问。备份目录不能位于仓库、仓库的子目录、文件系统根目录或仓库的任一祖先目录，并应另行加密同步到不同服务器或对象存储。若要同时验证 nginx/TLS，可将 `DEPLOY_HEALTHCHECK_URL` 设为公网健康端点。

迁移器在 schema 发生变化前还会向 `/app/backups` 写入一份通过 `integrity_check` 的自动备份；这不能代替更新脚本产生的宿主机副本或异地备份。任何 checksum 不一致、未知版本、缺表、外键错误或完整性错误都会终止迁移。脚本不会自动 reset、删除数据或执行可能与新 schema 不兼容的旧版本回滚。不要运行两个 app 副本做滚动更新；SQLite 模式采用短暂停机替换单实例。
