#!/usr/bin/env bash
# my_ledger 本地环境配置脚本
#
# 用法（切换到可用网络后手动执行）：
#   bash scripts/setup-env.sh                 # 标准安装 + 迁移 + 种子 + 快速校验
#   bash scripts/setup-env.sh --mirror        # 走 npmmirror 镜像（境内网络推荐）
#   bash scripts/setup-env.sh --registry URL  # 指定任意 registry
#   bash scripts/setup-env.sh --clean         # 先删掉 node_modules 再装
#   bash scripts/setup-env.sh --skip-verify   # 只装环境，不跑 lint/typecheck/test
#   bash scripts/setup-env.sh --full-verify   # 额外跑 next build（较慢）
#   bash scripts/setup-env.sh --no-seed       # 不写入种子数据
#
# 可重复执行：已存在的 .env.local 和 data/ledger.db 不会被覆盖或删除。

set -euo pipefail

REGISTRY=""
CLEAN=0
SKIP_VERIFY=0
FULL_VERIFY=0
RUN_SEED=1
INSTALL_ATTEMPTS=3

MIRROR_URL="https://registry.npmmirror.com"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

step()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()    { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '    \033[33m!\033[0m %s\n' "$*"; }
fail()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --mirror)      REGISTRY="$MIRROR_URL" ;;
    --registry)    shift; [ $# -gt 0 ] || fail "--registry 后面需要跟一个 URL"; REGISTRY="$1" ;;
    --registry=*)  REGISTRY="${1#*=}" ;;
    --clean)       CLEAN=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    --full-verify) FULL_VERIFY=1 ;;
    --no-seed)     RUN_SEED=0 ;;
    -h|--help)     sed -n '2,13p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)             fail "未知参数：$1（用 --help 查看用法）" ;;
  esac
  shift
done

cd "$ROOT"

# ---------------------------------------------------------------- 1. 前置检查
step "1/7 前置检查"

command -v node >/dev/null 2>&1 || fail "未找到 node。本项目要求 Node.js 24 或 26。"
command -v npm  >/dev/null 2>&1 || fail "未找到 npm。"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ] || [ "$NODE_MAJOR" -ge 27 ]; then
  fail "Node 版本为 $(node -v)，package.json 要求 >=24 <27。请先切换 Node 版本。"
fi
ok "Node $(node -v) / npm $(npm -v)"

[ -f package-lock.json ] || fail "缺少 package-lock.json，无法使用 npm ci。"

# npm 会把进程标题设成 "npm ci" / "npm install"，用 ^ 锚定可避免误伤
# 命令行里恰好提到这几个字的无关 shell。
RUNNING_NPM="$(pgrep -a -f '^npm (ci|install)' 2>/dev/null | grep -v "^$$ " || true)"
if [ -n "$RUNNING_NPM" ]; then
  warn "检测到已有 npm 安装进程仍在运行："
  printf '      %s\n' "$RUNNING_NPM"
  warn "先结束它再重跑本脚本： pkill -f '^npm (ci|install)'"
  fail "已中止，避免两个安装进程互相破坏 node_modules。"
fi

if [ -n "$REGISTRY" ]; then
  ok "使用 registry：$REGISTRY"
else
  REGISTRY="$(npm config get registry 2>/dev/null || echo https://registry.npmjs.org/)"
  ok "使用当前 registry：$REGISTRY"
fi

step "2/7 网络连通性"
if command -v curl >/dev/null 2>&1; then
  if curl -sfI --max-time 20 -o /dev/null "${REGISTRY%/}/"; then
    ok "registry 可达"
  else
    warn "无法在 20 秒内访问 ${REGISTRY%/}/"
    warn "如果当前网络较慢，可改用镜像重跑： bash scripts/setup-env.sh --mirror"
    fail "网络检查未通过，已中止（不会留下半装状态）。"
  fi
else
  warn "未安装 curl，跳过连通性检查。"
fi

# ---------------------------------------------------------------- 3. 安装依赖
step "3/7 安装依赖"

if [ "$CLEAN" -eq 1 ]; then
  rm -rf node_modules
  ok "已按 --clean 删除 node_modules"
elif [ -d node_modules ] && [ ! -x node_modules/.bin/vitest ]; then
  warn "检测到半成品 node_modules（缺少可执行文件），自动清理。"
  rm -rf node_modules
fi

if [ -x node_modules/.bin/vitest ] && [ -x node_modules/.bin/next ]; then
  ok "依赖已完整安装，跳过 npm ci（需要强制重装请加 --clean）"
else
  # 针对弱网络放宽超时与重试；仅对本次命令生效，不改全局 npm 配置。
  export npm_config_registry="$REGISTRY"
  export npm_config_fetch_retries=5
  export npm_config_fetch_retry_mintimeout=20000
  export npm_config_fetch_retry_maxtimeout=180000
  export npm_config_fetch_timeout=1200000

  attempt=1
  until npm ci --no-audit --no-fund; do
    if [ "$attempt" -ge "$INSTALL_ATTEMPTS" ]; then
      warn "npm ci 连续 $INSTALL_ATTEMPTS 次失败。"
      warn "换网络后重跑，或改用镜像： bash scripts/setup-env.sh --clean --mirror"
      fail "依赖安装失败。"
    fi
    attempt=$((attempt + 1))
    warn "第 $((attempt - 1)) 次失败，5 秒后重试（第 $attempt 次）…"
    sleep 5
  done
  ok "依赖安装完成"
fi

step "4/7 校验原生模块"
if node --input-type=commonjs -e "require('better-sqlite3')" >/dev/null 2>&1; then
  ok "better-sqlite3 原生绑定可加载"
else
  warn "better-sqlite3 无法加载，尝试重新编译…"
  npm rebuild better-sqlite3 || fail "better-sqlite3 编译失败。Ubuntu 上通常需要： sudo apt install -y build-essential python3"
  node --input-type=commonjs -e "require('better-sqlite3')" >/dev/null 2>&1 || fail "重新编译后仍无法加载 better-sqlite3。"
  ok "重新编译成功"
fi

# ---------------------------------------------------------------- 5. 环境变量
step "5/7 环境变量与数据目录"

ENV_CREATED=0
if [ -f .env.local ]; then
  ok ".env.local 已存在，保持不变"
else
  cp .env.example .env.local
  ENV_CREATED=1
  ok "已从 .env.example 生成 .env.local"
fi

mkdir -p data backups
ok "data/ 与 backups/ 已就绪"

# ---------------------------------------------------------------- 6. 数据库
step "6/7 数据库迁移"
# db:* 是独立的 node 脚本，不会像 next 那样自动加载 .env.local，
# 它们只读 shell 环境变量，缺省值与 .env.example 一致。
ok "本次使用 DATABASE_PATH=${DATABASE_PATH:-./data/ledger.db}"
npm run db:migrate
ok "迁移完成"

npm run db:audit
ok "数据审计通过"

if [ "$RUN_SEED" -eq 1 ]; then
  npm run db:seed
  ok "种子数据写入完成（只创建本地用户、分类和渠道，不创建示例账目）"
else
  warn "已按 --no-seed 跳过种子数据"
fi

# ---------------------------------------------------------------- 7. 校验
step "7/7 校验"
if [ "$SKIP_VERIFY" -eq 1 ]; then
  warn "已按 --skip-verify 跳过 lint / typecheck / test"
else
  npm run lint;      ok "lint 通过"
  npm run typecheck; ok "typecheck 通过"
  npm test;          ok "单元与集成测试通过"
  npm run test:mcp;  ok "MCP 内存 transport 往返通过"
  if [ "$FULL_VERIFY" -eq 1 ]; then
    npm run build;   ok "production build 通过"
  else
    warn "未跑 next build（较慢）。需要时加 --full-verify。"
  fi
fi

# ---------------------------------------------------------------- 收尾
printf '\n\033[1;32m环境配置完成。\033[0m\n\n'
echo "下一步："
echo "  npm run dev        # http://localhost:3000"
echo
if [ "$ENV_CREATED" -eq 1 ]; then
  echo "注意：.env.local 是从模板复制的，以下几项仍是占位值，联调真实登录前必须填写："
  echo "  NEXT_PUBLIC_SUPABASE_URL"
  echo "  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
  echo "  ALLOWED_AUTH_EMAILS      # 逗号分隔的受邀邮箱白名单"
  echo
  echo "当前 LOCAL_DEV_AUTH=true，仅在非生产环境生效，可先不配 Supabase 直接本地开发。"
  echo "AI 功能默认关闭；需要时再填 DEEPSEEK_API_KEY 或 MINIMAX_API_KEY 并在设置页显式开启。"
  echo
fi
echo "真实 Streamable HTTP MCP 验证需要另开一个终端："
echo "  npm run dev                      # 终端 A"
echo "  npm run test:mcp:http            # 终端 B，需与终端 A 使用同一个 DATABASE_PATH"
