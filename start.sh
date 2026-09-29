#!/usr/bin/env bash
#
# Starts webmux: preflight, build the client if it is missing or stale, then
# hand off to the server.
#
# Configuration is entirely environment- and file-based (see the "配置" section
# of README.md), so this script adds no flags of its own — anything you would
# pass to the server, you export or put in config.json.
#
# Usage:  ./start.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

die() {
  printf '\033[31m✗\033[0m %s\n' "$1" >&2
  exit 1
}

ok() {
  printf '\033[32m✓\033[0m %s\n' "$1"
}

step() {
  printf '\033[36m▸\033[0m %s\n' "$1"
}

# ---------------------------------------------------------------------------
# Preflight
#
# Checked here rather than left to fail later, because each of these produces a
# confusing symptom rather than a clear error: a missing tmux makes every
# session creation fail at runtime, and an old Node fails somewhere deep inside
# a dependency.
# ---------------------------------------------------------------------------

command -v node >/dev/null 2>&1 || die "找不到 node，请先安装 Node.js 22 或更高版本"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  die "需要 Node.js 22 或更高版本，当前是 $(node -v)"
fi
ok "node $(node -v)"

if ! command -v tmux >/dev/null 2>&1; then
  die "找不到 tmux —— 会话持久化完全依赖它。Debian/Ubuntu: apt install tmux；macOS: brew install tmux"
fi
ok "tmux $(tmux -V | awk '{print $2}')"

if [ ! -d node_modules ]; then
  die "依赖未安装，请先运行 pnpm install"
fi

# ---------------------------------------------------------------------------
# Client build
#
# The server serves the built SPA from packages/web/dist, and runs its own
# TypeScript directly through tsx — so the client is the only thing that has to
# be compiled. Without the staleness check, editing the frontend and restarting
# would quietly keep serving the previous bundle, which looks like the change
# simply did not work.
# ---------------------------------------------------------------------------

CLIENT_DIST="packages/web/dist/index.html"

needs_build() {
  [ -f "$CLIENT_DIST" ] || return 0
  # Any source newer than the built entrypoint means the bundle is stale.
  [ -n "$(find packages/web/src packages/web/index.html packages/web/vite.config.ts \
    -newer "$CLIENT_DIST" -print -quit 2>/dev/null)" ]
}

if needs_build; then
  step "前端需要构建…"
  command -v pnpm >/dev/null 2>&1 || die "找不到 pnpm，无法构建前端"
  pnpm build || die "前端构建失败"
  ok "前端构建完成"
else
  ok "前端已是最新（跳过构建）"
fi

# ---------------------------------------------------------------------------
# Hand off
#
# `exec` plus a direct `node` invocation rather than `pnpm start`, deliberately:
# pnpm would put a shell and a wrapper process between the supervisor and the
# server, so a `systemctl stop` (SIGTERM to the main process) would not reach
# the server's own graceful-shutdown handler, which detaches the client ptys
# and leaves the tmux sessions running.
# ---------------------------------------------------------------------------

step "启动 webmux…"
cd "$REPO_ROOT/packages/server"
exec node --import tsx src/index.ts
