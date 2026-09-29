#!/usr/bin/env bash
#
# Installs webmux as a systemd service.
#
#   sudo ./install.sh                          # from a checkout
#   curl -fsSL .../install.sh | sudo bash      # straight from GitHub
#
# It runs the service as *you* by default, not as a dedicated account. That is
# the point: the whole value of the thing is that the shell you get in the
# browser is your shell — your home, your dotfiles, your keys, your projects.
# A `webmux` service account would put you in an empty home directory and make
# you grant access to everything separately. Use --user to name a different
# account if you really want one.
#
# What it does, in order: checks the dependencies (installing tmux from the
# distribution's own repository, and Node into this installation's own prefix
# if the system one is too old), resolves the service account, copies the source
# to the prefix, writes the file-root config, builds the client, writes the
# systemd unit and starts it.
#
# It is idempotent: running it again upgrades an existing installation in place
# and restarts the service. `--uninstall` reverses it.
#
# Everything it owns lives under the prefix, so removing that directory removes
# the installation. The one thing outside it is /etc/systemd/system/webmux.service
# and /etc/webmux.env.
#
set -euo pipefail

PREFIX=/opt/webmux
SERVICE_USER=
SERVICE_NAME=webmux
ENV_FILE=/etc/webmux.env
UNIT_FILE=/etc/systemd/system/${SERVICE_NAME}.service
REPO_URL=https://github.com/SmartXiaoMing/webmux.git
NODE_MAJOR_REQUIRED=22

INSTALL_DEPS=1
PORT=
DO_UNINSTALL=0
ROOT_DIRS=()
DATA_DIR=""
ROOT_GIVEN=0

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

step() { printf '\033[36m▸\033[0m %s\n' "$1"; }
ok() { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1" >&2; }
die() {
  printf '\033[31m✗\033[0m %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法: sudo ./install.sh [选项]

  通过管道运行时，参数要跟在 `bash -s --` 后面，否则 bash 会当成自己的参数：
    curl -fsSL <url> | sudo bash -s -- --port 9000

  --prefix <目录>    安装位置（默认 /opt/webmux）
  --user <用户名>    以谁的身份运行服务（默认：调用 sudo 的那个用户）
                     该用户不存在时会创建它
  --root <目录>      文件页的根目录，可重复（默认：该用户的家目录）
  --port <端口>      监听端口（默认 8866）
  --data-dir <目录>  数据目录（默认 ~/.local/share/webmux）
  --no-deps          只检查依赖，不代为安装
  --uninstall        卸载（停止服务、删除单元与安装目录，保留数据目录）
  -h, --help         显示这段帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="${2:?--prefix 需要一个目录}"; shift 2 ;;
    --root) ROOT_DIRS+=("${2:?--root 需要一个目录}"); ROOT_GIVEN=1; shift 2 ;;
    --data-dir) DATA_DIR="${2:?--data-dir 需要一个目录}"; shift 2 ;;
    --user) SERVICE_USER="${2:?--user 需要一个用户名}"; shift 2 ;;
    --port) PORT="${2:?--port 需要一个端口}"; shift 2 ;;
    --no-deps) INSTALL_DEPS=0; shift ;;
    --uninstall) DO_UNINSTALL=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "未知参数: $1（--help 看用法）" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "需要 root 权限：sudo $0"

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

if [ "${DO_UNINSTALL}" -eq 1 ]; then
  step "停止并移除服务"
  systemctl disable --now "${SERVICE_NAME}" 2>/dev/null || true
  rm -f "${UNIT_FILE}"
  systemctl daemon-reload 2>/dev/null || true
  ok "服务已移除"

  # The tmux server is deliberately NOT killed here: it is not ours to kill, and
  # its sessions are the user's running work. Say so rather than silently
  # leaving processes behind.
  if command -v tmux >/dev/null 2>&1; then
    if tmux -L webmux ls >/dev/null 2>&1; then
      warn "tmux 里仍有会话在跑（socket: webmux）。要一并清掉：tmux -L webmux kill-server"
    fi
  fi

  rm -rf "${PREFIX}"
  ok "已删除 ${PREFIX}"
  warn "数据目录（密码哈希、令牌密钥、配置）保留在 ${SERVICE_USER} 的家目录下，需要的话自行删除"
  warn "服务用户 ${SERVICE_USER} 也保留着：userdel -r ${SERVICE_USER}"
  exit 0
fi

# ---------------------------------------------------------------------------
# Where does the source come from?
#
# The script is written to work both from a checkout and from `curl | bash`, so
# it looks for a real checkout next to itself first and falls back to cloning.
# ---------------------------------------------------------------------------

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo '')"
SOURCE_DIR=""
CLONE_DIR=""
CLEANUP_CLONE=0

if [ -n "${SELF_DIR}" ] && [ -f "${SELF_DIR}/package.json" ] && [ -f "${SELF_DIR}/start.sh" ]; then
  SOURCE_DIR="${SELF_DIR}"
  # Running the *installed* copy (`sudo /opt/webmux/install.sh`) must not
  # rsync the prefix onto itself — that would install nothing and report
  # success. It means "upgrade from upstream", so clone like the curl path.
  if [ "${SOURCE_DIR}" = "${PREFIX}" ]; then
    SOURCE_DIR=""
  else
    ok "从当前目录安装：${SOURCE_DIR}"
  fi
fi

if [ -z "${SOURCE_DIR}" ]; then
  step "从 GitHub 拉取源码…"
  command -v git >/dev/null 2>&1 || die "找不到 git（拉取源码需要它）。也可以先 clone 下来，再在目录里跑 ./install.sh"
  CLONE_DIR="$(mktemp -d)"
  CLEANUP_CLONE=1
  git clone --depth 1 "${REPO_URL}" "${CLONE_DIR}/webmux" >/dev/null 2>&1 ||
    die "git clone 失败：${REPO_URL}"
  SOURCE_DIR="${CLONE_DIR}/webmux"
  ok "已拉取到 ${SOURCE_DIR}"
fi

cleanup() {
  [ "${CLEANUP_CLONE}" -eq 1 ] && rm -rf "${CLONE_DIR}"
  return 0
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Dependencies
#
# tmux comes from the distribution's own repository — it is small, universally
# packaged, and there is no portable build of it.
#
# Node is different. Ubuntu 20.04's own nodejs is v10, far too old, and the
# usual fix (the NodeSource repository) means adding a third-party apt source to
# someone's server. Instead the official tarball is unpacked *inside the
# installation's own prefix* when the system Node is too old, so nothing outside
# this directory changes and any system Node is left alone.
# ---------------------------------------------------------------------------

pkg_install_tmux() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq tmux
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q tmux
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q tmux
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm --needed tmux
  elif command -v zypper >/dev/null 2>&1; then
    zypper --quiet install -y tmux
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache tmux
  elif command -v brew >/dev/null 2>&1; then
    brew install tmux
  else
    return 1
  fi
}

if command -v tmux >/dev/null 2>&1; then
  ok "tmux $(tmux -V | awk '{print $2}')"
elif [ "${INSTALL_DEPS}" -eq 1 ]; then
  step "安装 tmux…"
  pkg_install_tmux || die "无法自动安装 tmux，请用你的发行版的方式装好它再重试（或加 --no-deps 跳过）"
  ok "tmux 已安装"
else
  die "缺少 tmux，且指定了 --no-deps。会话持久化完全依赖它"
fi

node_major() {
  command -v node >/dev/null 2>&1 || return 1
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || return 1
}

NODE_BIN_DIR=""
CURRENT_NODE_MAJOR="$(node_major || echo 0)"

if [ "${CURRENT_NODE_MAJOR}" -ge "${NODE_MAJOR_REQUIRED}" ] 2>/dev/null; then
  ok "node $(node -v)（使用系统已装的）"
elif [ "${INSTALL_DEPS}" -eq 0 ]; then
  die "需要 Node.js ${NODE_MAJOR_REQUIRED}+，当前是 $(node -v 2>/dev/null || echo '未安装')，且指定了 --no-deps"
else
  case "$(uname -m)" in
    x86_64 | amd64) NODE_ARCH=linux-x64 ;;
    aarch64 | arm64) NODE_ARCH=linux-arm64 ;;
    *) die "没有为 $(uname -m) 准备的 Node 预编译包，请自行安装 Node ${NODE_MAJOR_REQUIRED}+ 后重试" ;;
  esac
  [ -f /etc/alpine-release ] && die "Alpine 不适用官方 Node 预编译包（musl），请用 apk add nodejs 后重试"

  step "把 Node ${NODE_MAJOR_REQUIRED} 装进 ${PREFIX}/runtime（不动系统里的 node，也不加 apt 源）…"

  command -v curl >/dev/null 2>&1 || die "需要 curl 来下载 Node"
  SHASUMS="$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR_REQUIRED}.x/SHASUMS256.txt")" ||
    die "下载 Node 校验文件失败（服务器能出网吗？）"
  TARBALL="$(printf '%s\n' "${SHASUMS}" | grep -o "node-v[0-9.]*-${NODE_ARCH}\.tar\.xz" | head -1 || true)"
  [ -n "${TARBALL}" ] || die "在官方校验文件里找不到 ${NODE_ARCH} 的包"

  mkdir -p "${PREFIX}/runtime"
  TMP_TARBALL="$(mktemp -d)/${TARBALL}"
  curl -fsSL -o "${TMP_TARBALL}" "https://nodejs.org/dist/latest-v${NODE_MAJOR_REQUIRED}.x/${TARBALL}" ||
    die "下载 Node 失败"

  # Verified against the publisher's own checksum before it is unpacked: this is
  # a tarball from the internet that will be running as a service.
  ( cd "$(dirname "${TMP_TARBALL}")" &&
    printf '%s\n' "${SHASUMS}" | grep " ${TARBALL}\$" | sha256sum -c - >/dev/null ) ||
    die "Node 包的 sha256 与官方校验文件不符，已中止"
  ok "已校验 sha256"

  tar -xJf "${TMP_TARBALL}" -C "${PREFIX}/runtime" --strip-components=1 ||
    die "解压 Node 失败"
  rm -rf "$(dirname "${TMP_TARBALL}")"

  # Discover the binary instead of assuming where it landed. The tarball's
  # internal layout belongs to the publisher, and `--strip-components=1` —
  # which strips the version-bearing top directory, so the path stays stable
  # across upgrades — puts it at runtime/bin/node today. Hard-coding the
  # assumption here is how the first version of this script failed on a real
  # machine with "the install directory may be broken" when nothing was broken.
  # `-print -quit` rather than `| head -1`: a pipeline here can fail on SIGPIPE,
  # and a failing substitution inside an assignment trips `set -e`.
  NODE_BIN="$(find "${PREFIX}/runtime" -maxdepth 3 -type f -name node -perm -u+x -print -quit || true)"
  if [ -z "${NODE_BIN}" ]; then
    warn "解压出来的结构："
    find "${PREFIX}/runtime" -maxdepth 2 | sed 's/^/    /' >&2
    die "在 ${PREFIX}/runtime 里找不到 node 可执行文件"
  fi
  NODE_BIN_DIR="$(dirname "${NODE_BIN}")"

  # Running it is the only check that proves the download is usable, as opposed
  # to merely present.
  NODE_VERSION="$("${NODE_BIN}" -v 2>/dev/null || true)"
  [ -n "${NODE_VERSION}" ] || die "解压出来的 node 跑不起来：${NODE_BIN}"
  ok "node ${NODE_VERSION} 已就位（${NODE_BIN_DIR}）"
fi

# pnpm, into whichever Node we settled on. npm ships with Node, so this needs no
# extra download step of its own.
export PATH="${NODE_BIN_DIR:+${NODE_BIN_DIR}:}${PATH}"
if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm -v)"
elif [ "${INSTALL_DEPS}" -eq 1 ]; then
  step "安装 pnpm…"
  npm install -g --silent pnpm || die "npm install -g pnpm 失败"
  ok "pnpm $(pnpm -v)"
else
  die "缺少 pnpm，且指定了 --no-deps"
fi

# ---------------------------------------------------------------------------
# Service account
#
# Defaults to the human who ran sudo. That is deliberate and load-bearing: the
# shell this opens is meant to be *theirs* — same home, same dotfiles, same SSH
# keys, same projects. A dedicated account would hand them an empty home
# directory and turn every file they care about into something to grant access
# to. `--user` exists for the cases where that IS what you want.
#
# A real home directory matters either way: the data directory defaults to
# ~/.local/share/webmux, and webmux creates it 0700 because it holds the
# password hash and the token-signing secret.
# ---------------------------------------------------------------------------

if [ -z "${SERVICE_USER}" ]; then
  # SUDO_USER is empty when someone is already root, and then there is no
  # "current user" to infer — guessing (root? the tty owner?) would be worse
  # than asking.
  SERVICE_USER="${SUDO_USER:-}"
  [ -n "${SERVICE_USER}" ] ||
    die "无法判断该以谁的身份运行（没有 SUDO_USER）。请显式指定：--user <用户名>"
  ok "以 ${SERVICE_USER} 的身份运行（sudo 的调用者；--user 可以改）"
fi

home_of() {
  # getent is glibc-only; Alpine and others need the passwd-file route.
  # `|| true` on both: an unknown user makes these exit non-zero, and with
  # pipefail inside an assignment that aborts the whole script.
  if command -v getent >/dev/null 2>&1; then
    getent passwd "$1" 2>/dev/null | cut -d: -f6 || true
  else
    awk -F: -v u="$1" '$1 == u { print $6 }' /etc/passwd 2>/dev/null || true
  fi
}

if id "${SERVICE_USER}" >/dev/null 2>&1; then
  ok "服务用户 ${SERVICE_USER} 已存在"
else
  step "创建服务用户 ${SERVICE_USER}…"
  useradd --create-home --shell /bin/bash "${SERVICE_USER}" || die "创建用户失败"
  ok "已创建"
fi

# Read the home directory back in *both* cases. It used to be assigned only on
# the "already exists" path, so a first-time install left it unset and `set -u`
# aborted several steps later, at the build.
SERVICE_HOME="$(home_of "${SERVICE_USER}")"
if [ -z "${SERVICE_HOME}" ] || [ ! -d "${SERVICE_HOME}" ]; then
  die "用户 ${SERVICE_USER} 的家目录不存在（${SERVICE_HOME:-空}）。webmux 的数据目录要建在那里"
fi
# The primary group, not a group of the same name: on plenty of systems the two
# differ, and `User=x` with a nonexistent `Group=x` is a unit that will not start.
SERVICE_GROUP="$(id -gn "${SERVICE_USER}")"
ok "家目录 ${SERVICE_HOME}（组 ${SERVICE_GROUP}）"

# ---------------------------------------------------------------------------
# Copy the source and build
# ---------------------------------------------------------------------------

step "安装到 ${PREFIX}…"
mkdir -p "${PREFIX}"

# `runtime` is excluded so a re-run does not delete the Node we just installed
# into it; node_modules and dist are rebuilt below.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude 'node_modules' --exclude 'dist' --exclude 'runtime' \
    "${SOURCE_DIR}/" "${PREFIX}/" || die "复制源码失败"
else
  # No rsync on a minimal server. Copy over the top, then drop the two
  # directories that must not survive from a previous install.
  cp -a "${SOURCE_DIR}/." "${PREFIX}/" 2>/dev/null || die "复制源码失败"
  rm -rf "${PREFIX}/node_modules" "${PREFIX}/packages/web/dist"
fi
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${PREFIX}"
ok "源码已就位"

# ---------------------------------------------------------------------------
# File roots
#
# Written out explicitly rather than left to the default, because the default is
# only *implicitly* the home directory and "where can the file page go" is not
# something to leave implicit. `--root` overrides it; passing it twice gives two
# roots.
#
# The JSON is generated by node, which the step above has just guaranteed
# exists. Hand-rolled quoting in bash is how a path with a quote or a backslash
# in it turns into a broken config file.
# ---------------------------------------------------------------------------

if [ -z "${DATA_DIR}" ] && [ -f "${ENV_FILE}" ]; then
  # Honour an explicit WEBMUX_DATA_DIR from a previous install, so a re-run
  # writes the config where the service actually looks for it. Guarded on the
  # file existing because on a fresh install it does not — and a failing
  # command substitution inside an assignment trips `set -e`, which would abort
  # the install with no message at all.
  DATA_DIR="$(sed -n 's/^WEBMUX_DATA_DIR=//p' "${ENV_FILE}" 2>/dev/null | tail -1 || true)"
fi
if [ -z "${DATA_DIR}" ]; then
  DATA_DIR="${XDG_DATA_HOME:-${SERVICE_HOME}/.local/share}/webmux"
fi
mkdir -p "${DATA_DIR}"
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${DATA_DIR}"

CONFIG_JSON="${DATA_DIR}/config.json"
if [ "${ROOT_GIVEN}" -eq 1 ] || [ ! -f "${CONFIG_JSON}" ]; then
  [ "${#ROOT_DIRS[@]}" -eq 0 ] && ROOT_DIRS=("${SERVICE_HOME}")
  for d in "${ROOT_DIRS[@]}"; do
    [ -d "${d}" ] || die "--root 指向的目录不存在：${d}"
  done

  step "写入文件根配置…"
  # Paths go in as argv, not as a delimiter-joined string: a directory may
  # contain a comma, a quote or a backslash, and every one of those would need
  # escaping rules that are easy to get subtly wrong.
  node -e '
    const fs = require("fs")
    const path = require("path")
    const [file, home, ...paths] = process.argv.slice(1)
    let cfg = {}
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")) } catch { /* absent: start fresh */ }
    cfg.files = { ...(cfg.files ?? {}), roots: paths.map((p) => ({
      name: p === home ? "home" : path.basename(p) || "root",
      path: p,
    })) }
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n")
  ' "${CONFIG_JSON}" "${SERVICE_HOME}" "${ROOT_DIRS[@]}" || die "写入 ${CONFIG_JSON} 失败"

  chown "${SERVICE_USER}:${SERVICE_GROUP}" "${CONFIG_JSON}"
  ok "文件根已写入 ${CONFIG_JSON}"
fi

step "安装依赖并构建前端（以 ${SERVICE_USER} 身份）…"
BUILD_PATH="${NODE_BIN_DIR:+${NODE_BIN_DIR}:}/usr/local/bin:/usr/bin:/bin"
sudo -u "${SERVICE_USER}" env "PATH=${BUILD_PATH}" HOME="${SERVICE_HOME}" \
  bash -c "cd '${PREFIX}' && pnpm install --silent && pnpm build" >/dev/null ||
  die "依赖安装或前端构建失败。手动看一眼：sudo -u ${SERVICE_USER} bash -c 'cd ${PREFIX} && pnpm install && pnpm build'"
ok "构建完成"

# ---------------------------------------------------------------------------
# systemd unit and environment
# ---------------------------------------------------------------------------

step "写入 systemd 单元与配置…"
[ -f "${PREFIX}/deploy/${SERVICE_NAME}.service" ] || die "找不到 deploy/${SERVICE_NAME}.service"

sed -e "s|^User=.*|User=${SERVICE_USER}|" \
  -e "s|^Group=.*|Group=${SERVICE_GROUP}|" \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=${PREFIX}|" \
  -e "s|^ExecStart=.*|ExecStart=${PREFIX}/start.sh|" \
  "${PREFIX}/deploy/${SERVICE_NAME}.service" >"${UNIT_FILE}"
ok "单元文件 ${UNIT_FILE}"

# Site-specific settings go in the environment file rather than into the unit:
# the unit is replaced on every upgrade, this is not.
if [ ! -f "${ENV_FILE}" ]; then
  : >"${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
fi

set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "${ENV_FILE}" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >>"${ENV_FILE}"
  fi
}

# Only when we installed our own Node: systemd's PATH is minimal and would not
# otherwise find it, and `start.sh` shells out to node and pnpm by name.
if [ -n "${NODE_BIN_DIR}" ]; then
  set_env PATH "${NODE_BIN_DIR}:/usr/local/bin:/usr/bin:/bin"
fi
if [ -n "${PORT}" ]; then
  set_env WEBMUX_PORT "${PORT}"
fi
ok "配置 ${ENV_FILE}"

# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------

step "启动服务…"
systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}" >/dev/null 2>&1 || {
  warn "服务启动失败，最近日志："
  journalctl -u "${SERVICE_NAME}" -n 20 --no-pager >&2 || true
  die "systemctl enable --now ${SERVICE_NAME} 失败"
}

# Give it a moment, then confirm it is actually serving rather than merely
# started — "active" is not the same as "listening".
EFFECTIVE_PORT="${PORT:-8866}"
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${EFFECTIVE_PORT}/api/auth/status" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if curl -fsS "http://127.0.0.1:${EFFECTIVE_PORT}/api/auth/status" >/dev/null 2>&1; then
  ok "webmux 已在 http://127.0.0.1:${EFFECTIVE_PORT} 上运行"
else
  warn "服务已启动，但端口 ${EFFECTIVE_PORT} 还没有响应。看日志：journalctl -u ${SERVICE_NAME} -f"
fi

cat <<EOF

────────────────────────────────────────────────────────────
 下一步
────────────────────────────────────────────────────────────
 1. 打开 http://<这台机器的地址>:${EFFECTIVE_PORT} 设置密码
    （没有默认口令，不设置就无法使用）
    服务以 ${SERVICE_USER} 的身份运行，终端里就是你的 shell：你的家目录、
    dotfiles、SSH 密钥、项目文件。

 1b. 文件页的根目录是 ${CONFIG_JSON} 里的 files.roots
    （默认就是 ${SERVICE_HOME}）。改它，或者重跑时用 --root 指定：
        sudo ${PREFIX}/install.sh --root /srv/data --root ${SERVICE_HOME}

 2. 公网访问请先套一层 TLS 反代。默认监听 0.0.0.0 且不带 TLS，
    启动日志里会有两条相应警告。详见 README 的「部署到服务器」。
    反代与 webmux 在同一台机器上时，建议在 ${ENV_FILE} 里设：
        WEBMUX_HOST=127.0.0.1
        WEBMUX_TRUST_PROXY=true

 3. 常用操作
       systemctl status ${SERVICE_NAME}
       journalctl -u ${SERVICE_NAME} -f       # 实时日志
       systemctl restart ${SERVICE_NAME}      # 重启，会话不受影响

 4. 升级
       sudo ${PREFIX}/install.sh              # 重跑即可，会就地升级
       （配置文件不会被覆盖；要改文件根就显式加 --root）

 5. 卸载
       sudo ${PREFIX}/install.sh --uninstall
────────────────────────────────────────────────────────────
EOF
