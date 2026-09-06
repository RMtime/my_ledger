# SQLite 备份与恢复演练

## 备份

应用运行时使用 SQLite backup API，不直接复制活跃的 `.db` 文件：

```bash
docker compose exec app node scripts/backup.mjs /app/backups/ledger-$(date +%F).db
```

脚本会对副本执行 `PRAGMA integrity_check`，并输出账目数量和按币种、类型汇总。记录输出，再把备份加密同步到不同故障域。

`npm run db:migrate`（容器中为 `docker compose run --rm migrate`）会在修改已有 schema 前自动创建 `pre-migrate-v*.db`，并验证副本完整性。迁移备份是额外回滚点，不替代定期在线备份和异地副本。

## 隔离恢复验证

1. 停止一个不承载生产流量的临时 app 容器。
2. 创建独立临时 volume，将备份复制为其中的 `ledger.db`。
3. 仅把临时容器连接到回环端口，不接生产域名和生产凭证。
4. 启动后访问 `/api/healthz`，再次执行 `backup.mjs` 检查完整性、账目数量和各币种汇总。
5. 抽查分类、账户、退款引用和软删除记录；确认结果后删除临时容器与临时 volume。

生产恢复必须先停止 app，保留损坏文件副本，再把已验证备份放入 `ledger-data`。CSV 是便携导出，不包含完整关系和系统状态，不能作为全量备份。
