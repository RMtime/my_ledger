#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly DEPLOY_REMOTE="${DEPLOY_REMOTE:-origin}"
readonly DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
readonly DEPLOY_HEALTHCHECK_URL="${DEPLOY_HEALTHCHECK_URL:-http://127.0.0.1:3000/api/healthz}"
readonly DEPLOY_HEALTH_ATTEMPTS="${DEPLOY_HEALTH_ATTEMPTS:-30}"
readonly DEPLOY_HEALTH_INTERVAL_SECONDS="${DEPLOY_HEALTH_INTERVAL_SECONDS:-2}"

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly DEPLOY_BACKUP_EXPORT_DIR_INPUT="${DEPLOY_BACKUP_EXPORT_DIR:-$(dirname -- "${REPO_DIR}")/my-ledger-deploy-backups}"
readonly DEPLOY_LOCK_FILE="${REPO_DIR}/.git/deploy-update.lock"

phase="preflight"
old_revision="unknown"
target_revision="unknown"
backup_path="not-created"
app_stopped=false
migration_started=false
new_app_started=false

log() { printf '[deploy] %s\n' "$*"; }

report_failure() {
  local exit_code="${1:-1}"
  trap - ERR
  printf '[deploy] FAILED during %s (exit %s).\n' "${phase}" "${exit_code}" >&2
  printf '[deploy] Old revision: %s; target revision: %s; backup: %s\n' "${old_revision}" "${target_revision}" "${backup_path}" >&2
  if [[ "${migration_started}" == "true" ]]; then
    if [[ "${new_app_started}" == "true" ]]; then
      printf '[deploy] The database may already use the new schema, and the new app did not become healthy.\n' >&2
    else
      printf '[deploy] The app is intentionally left stopped; the database migration may have started.\n' >&2
    fi
    printf '[deploy] Do not start the old image or restore automatically. Inspect migration/audit output and the verified backup first.\n' >&2
  elif [[ "${app_stopped}" == "true" ]]; then
    printf '[deploy] The app is stopped, but migration did not start. Inspect container state before restarting it.\n' >&2
  elif [[ "${phase}" == "stop" ]]; then
    printf '[deploy] The stop command failed; app state is uncertain. Inspect docker compose ps before continuing.\n' >&2
  else
    printf '[deploy] The script did not intentionally stop or migrate the existing app.\n' >&2
  fi
  exit "${exit_code}"
}

fail() {
  printf '[deploy] ERROR: %s\n' "$*" >&2
  report_failure 1
}

on_error() { local exit_code=$?; report_failure "${exit_code}"; }
trap on_error ERR

usage() {
  cat <<'EOF'
Usage: scripts/deploy-update.sh

Safely fast-forwards origin/main, creates a verified SQLite backup outside the
Docker volume, builds while the old app is still running, then briefly stops the
single app replica for migration, audit, replacement, and health verification.

Optional environment variables:
  DEPLOY_REMOTE                    Git remote (default: origin)
  DEPLOY_BRANCH                    Git branch (default: main)
  DEPLOY_BACKUP_EXPORT_DIR         Host backup directory outside the repository
  DEPLOY_HEALTHCHECK_URL           Health endpoint (default: local port 3000)
  DEPLOY_HEALTH_ATTEMPTS           Number of health attempts (default: 30)
  DEPLOY_HEALTH_INTERVAL_SECONDS   Seconds between attempts (default: 2)
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then usage; exit 0; fi
[[ $# -eq 0 ]] || fail "不支持的参数。使用 --help 查看说明。"

for command in curl docker flock git python3 sha256sum; do
  command -v "${command}" >/dev/null 2>&1 || fail "缺少命令：${command}"
done
[[ "${DEPLOY_HEALTH_ATTEMPTS}" =~ ^[1-9][0-9]*$ ]] || fail "DEPLOY_HEALTH_ATTEMPTS 必须是正整数"
[[ "${DEPLOY_HEALTH_INTERVAL_SECONDS}" =~ ^[1-9][0-9]*$ ]] || fail "DEPLOY_HEALTH_INTERVAL_SECONDS 必须是正整数"

cd -- "${REPO_DIR}"
[[ ! -L "${DEPLOY_BACKUP_EXPORT_DIR_INPUT}" ]] || fail "宿主机备份目录不能是符号链接"
DEPLOY_BACKUP_EXPORT_DIR="$(python3 -c '
import os
import sys

backup = os.path.realpath(sys.argv[1])
repository = os.path.realpath(sys.argv[2])
common = os.path.commonpath((backup, repository))
if backup == os.path.sep or common in (backup, repository):
    raise SystemExit("backup directory must be separate from the repository and its ancestors")
print(backup)
' "${DEPLOY_BACKUP_EXPORT_DIR_INPUT}" "${REPO_DIR}")" || fail "宿主机备份目录必须独立于仓库及其祖先目录"
readonly DEPLOY_BACKUP_EXPORT_DIR
exec 9>"${DEPLOY_LOCK_FILE}"
flock -n 9 || fail "已有另一个部署正在运行"

[[ -f .env.production ]] || fail "缺少 .env.production"
[[ "$(git branch --show-current)" == "${DEPLOY_BRANCH}" ]] || fail "必须在 ${DEPLOY_BRANCH} 分支运行"
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || fail "工作树不干净；拒绝覆盖服务器本地改动"

readonly remote_url="$(git remote get-url "${DEPLOY_REMOTE}")"
case "${remote_url}" in
  https://github.com/RMtime/my_ledger.git|git@github.com:RMtime/my_ledger.git|ssh://git@github.com/RMtime/my_ledger.git) ;;
  *) fail "${DEPLOY_REMOTE} 未指向预期仓库 RMtime/my_ledger；为避免泄露凭据，不回显 remote URL" ;;
esac

docker info >/dev/null
docker compose version >/dev/null
docker compose config --quiet
mapfile -t app_container_ids < <(docker compose ps -q app)
[[ "${#app_container_ids[@]}" -eq 1 ]] || fail "必须且只能存在一个 app 容器"
app_container_id="${app_container_ids[0]}"
[[ "$(docker inspect -f '{{.State.Running}}' "${app_container_id}")" == "true" ]] || fail "app 容器未运行；首次部署请按 docs/deployment-ubuntu.md 执行"

actual_data_volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}{{end}}' "${app_container_id}")"
actual_backup_volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/backups"}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}{{end}}' "${app_container_id}")"
[[ -n "${actual_data_volume}" && -n "${actual_backup_volume}" ]] || fail "app 的数据与备份目录必须各自使用一个 Docker named volume"
[[ "${actual_data_volume}" != "${actual_backup_volume}" ]] || fail "数据卷与备份卷不能是同一个 Docker volume"

docker compose exec -T app sh -c 'test "$DATABASE_PATH" = /app/data/ledger.db && test -w /app/data && test -w /app/backups' || fail "当前 app 的数据库路径不正确，或 app 用户不能写入数据卷/备份卷"
docker compose exec -T app node -e '
const Database = require("better-sqlite3");
const database = new Database(process.env.DATABASE_PATH || "/app/data/ledger.db", { fileMustExist: true });
try {
  database.pragma("busy_timeout=5000");
  database.exec("BEGIN IMMEDIATE; ROLLBACK");
} finally {
  database.close();
}
' || fail "当前 app 用户无法取得 SQLite 写事务；部署未开始"

old_revision="$(git rev-parse HEAD)"
phase="fetch"
log "Fetching ${DEPLOY_REMOTE}/${DEPLOY_BRANCH}..."
git fetch --prune "${DEPLOY_REMOTE}" "${DEPLOY_BRANCH}"
target_revision="$(git rev-parse 'FETCH_HEAD^{commit}')"
git merge-base --is-ancestor "${old_revision}" "${target_revision}" || fail "本地提交与远端已分叉；拒绝自动合并或重置"

phase="backup"
if [[ -e "${DEPLOY_BACKUP_EXPORT_DIR}" ]]; then
  [[ -d "${DEPLOY_BACKUP_EXPORT_DIR}" && ! -L "${DEPLOY_BACKUP_EXPORT_DIR}" ]] || fail "宿主机备份目标不是普通目录：${DEPLOY_BACKUP_EXPORT_DIR}"
  python3 -c '
import os
import stat
import sys

mode = stat.S_IMODE(os.stat(sys.argv[1]).st_mode)
raise SystemExit(0 if mode & 0o077 == 0 else 1)
' "${DEPLOY_BACKUP_EXPORT_DIR}" || fail "现有备份目录允许 group/other 访问；请由管理员先收紧权限"
else
  mkdir -p -- "${DEPLOY_BACKUP_EXPORT_DIR}"
  chmod 700 -- "${DEPLOY_BACKUP_EXPORT_DIR}"
fi
readonly timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly backup_name="ledger-pre-deploy-${old_revision:0:12}-${timestamp}.db"
readonly container_backup="/app/backups/${backup_name}"
backup_path="${DEPLOY_BACKUP_EXPORT_DIR}/${backup_name}"
[[ ! -e "${backup_path}" ]] || fail "备份目标已存在，拒绝覆盖：${backup_path}"
log "Creating and validating online backup..."
docker compose exec -T app sh -c 'umask 077; exec node scripts/backup.mjs "$1"' sh "${container_backup}"
container_checksum_line="$(docker compose exec -T app sha256sum -- "${container_backup}")"
container_checksum="${container_checksum_line%% *}"
docker compose cp "app:${container_backup}" "${backup_path}"
[[ -s "${backup_path}" ]] || fail "宿主机备份不存在或为空：${backup_path}"
chmod 600 "${backup_path}"
host_checksum_line="$(sha256sum -- "${backup_path}")"
host_checksum="${host_checksum_line%% *}"
[[ "${container_checksum}" =~ ^[0-9a-fA-F]{64}$ && "${host_checksum}" == "${container_checksum}" ]] || fail "容器与宿主机备份的 SHA-256 不一致"
log "Verified backup SHA-256: ${host_checksum}"

phase="fast-forward"
if [[ "${old_revision}" == "${target_revision}" ]]; then
  log "Repository is already at ${target_revision:0:12}; redeploying the current revision."
else
  log "Fast-forwarding ${old_revision:0:12} -> ${target_revision:0:12}..."
  git merge --ff-only "${target_revision}"
fi
[[ "$(git rev-parse HEAD)" == "${target_revision}" ]] || fail "HEAD 未到达目标提交"

phase="compose-validation"
docker compose config --quiet
[[ "$(docker compose ps -q app)" == "${app_container_id}" ]] || fail "Compose project/service identity 已变化；需要人工迁移"
planned_volumes_output="$(docker compose config --format json | python3 -c '
import json
import sys

config = json.load(sys.stdin)

for service in ("app", "migrate"):
    database_path = config.get("services", {}).get(service, {}).get("environment", {}).get("DATABASE_PATH")
    if database_path != "/app/data/ledger.db":
        raise SystemExit(f"{service} DATABASE_PATH must remain /app/data/ledger.db")
if config.get("services", {}).get("migrate", {}).get("environment", {}).get("MIGRATION_BACKUP_DIR") != "/app/backups":
    raise SystemExit("migrate MIGRATION_BACKUP_DIR must remain /app/backups")

def resolved(service, target):
    service_config = config.get("services", {}).get(service, {})
    matches = [
        volume for volume in service_config.get("volumes", [])
        if volume.get("type") == "volume" and volume.get("target") == target
    ]
    if len(matches) != 1:
        raise SystemExit(f"{service}:{target} must have exactly one named volume")
    source = matches[0].get("source")
    name = config.get("volumes", {}).get(source, {}).get("name")
    if not isinstance(name, str) or not name:
        raise SystemExit(f"cannot resolve volume name for {service}:{target}")
    return name

for item in (
    resolved("app", "/app/data"),
    resolved("migrate", "/app/data"),
    resolved("app", "/app/backups"),
    resolved("migrate", "/app/backups"),
):
    print(item)
')" || fail "无法解析更新后的 Compose 持久卷"
mapfile -t planned_volumes <<< "${planned_volumes_output}"
[[ "${#planned_volumes[@]}" -eq 4 ]] || fail "更新后的 Compose 持久卷数量不符合预期"
[[ "${planned_volumes[0]}" == "${actual_data_volume}" && "${planned_volumes[1]}" == "${actual_data_volume}" ]] || fail "app/migrate 的数据卷不再指向现有账本卷"
[[ "${planned_volumes[2]}" == "${actual_backup_volume}" && "${planned_volumes[3]}" == "${actual_backup_volume}" ]] || fail "app/migrate 的备份卷不再指向现有备份卷"

phase="build"
log "Building new app and migrator images while the old app remains online..."
docker compose build --pull app migrate

phase="stop"
log "Stopping the single writer..."
docker compose stop app
app_stopped=true

phase="migrate"
migration_started=true
docker compose run --rm --no-deps migrate

phase="audit"
docker compose run --rm --no-deps migrate npm run db:audit

phase="start"
docker compose up -d --no-deps app
new_app_started=true

phase="healthcheck"
for ((attempt=1; attempt<=DEPLOY_HEALTH_ATTEMPTS; attempt+=1)); do
  mapfile -t active_app_ids < <(docker compose ps -q app)
  container_state=""
  container_health=""
  if [[ "${#active_app_ids[@]}" -eq 1 ]]; then
    container_state="$(docker inspect -f '{{.State.Status}}' "${active_app_ids[0]}")" || container_state=""
    container_health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${active_app_ids[0]}")" || container_health=""
  fi
  health_body=""
  if [[ "${container_state}" == "running" && "${container_health}" == "healthy" ]] \
    && health_body="$(curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "${DEPLOY_HEALTHCHECK_URL}")" \
    && python3 -c 'import json,sys; payload=json.load(sys.stdin); raise SystemExit(0 if payload.get("status") == "ok" and payload.get("database") == "reachable" else 1)' <<< "${health_body}" 2>/dev/null; then
    printf '\n'
    phase="complete"
    app_stopped=false
    log "Deployment complete at ${target_revision}."
    log "Verified backup: ${backup_path}"
    docker compose ps app || true
    exit 0
  fi
  if (( attempt < DEPLOY_HEALTH_ATTEMPTS )); then sleep "${DEPLOY_HEALTH_INTERVAL_SECONDS}"; fi
done

docker compose logs --tail=200 app >&2 || true
fail "健康检查在 ${DEPLOY_HEALTH_ATTEMPTS} 次尝试后仍失败：${DEPLOY_HEALTHCHECK_URL}"
