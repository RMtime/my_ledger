# ADR-001：单服务器 SQLite

- 状态：接受
- 日期：2026-09-05

## 决策

账本数据使用服务器本地 SQLite，启用 `foreign_keys=ON`、WAL、`busy_timeout=5000` 和 `synchronous=NORMAL`。Ubuntu 24 服务器运行一个 Next.js 容器，数据库目录挂载到持久 Docker volume。Supabase 仅负责用户认证，不承载业务表。

## 原因

目标是单用户私人账本，写入规模小。SQLite 能提供本项目所需的事务、唯一约束、复合外键与精确 64 位整数，同时减少数据库服务、连接管理和升级运维。Web API 与 MCP 即使同时写入，也可在短事务中串行完成。

## 约束与补偿

- 应用只能单副本写入；退款校验等竞争操作使用 `BEGIN IMMEDIATE`。
- 幂等依赖 `(owner_id,idempotency_key)` 唯一约束，不依赖“先查后写”。
- SQLite 文件只能位于本机持久磁盘，不能放在共享网络文件系统。
- 使用在线 backup API 创建一致性副本，并把副本传到独立位置。
- repository 和 migration 保持清晰边界；未来需要多副本、高写入并发或托管 HA 时迁移 PostgreSQL。

## 未选择 PostgreSQL

PostgreSQL 对当前单用户负载不是必要条件。它仍是多实例部署的迁移目标，但不为尚不存在的扩缩容需求增加持续运维成本。
