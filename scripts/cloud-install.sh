#!/usr/bin/env bash
# The main call is last so a truncated curl response cannot start an installation.
set -Eeuo pipefail
umask 077
SWITCHYARD_ORIGIN='__SWITCHYARD_ORIGIN__'
NODE_VERSION=24.22.3
STEP=check
STAGE_TITLE=检查环境
ISSUE=unknown
CLAIMED=0
FINISHED=0
LOCKED=0

say() { printf '%s\n' "$*"; }
fail() { ISSUE="$1"; printf '\n未完成：%s\n' "$2" >&2; return 1; }
hash256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$@" | awk '{print $1}';
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$@" | awk '{print $1}';
  else openssl dgst -sha256 "$@" | awk '{print $NF}'; fi
}
# Only structured progress is sent to the cloud. Local command output and logs
# never leave this machine. No credentials appear in curl arguments or logs.
post() {
  local route="$1" body="$2" status
  printf '%s' "$body" > "$INSTALL_DIR/request.json"
  status=$(curl --silent --show-error --connect-timeout 10 --max-time 25 --retry 2 --retry-delay 1 \
    --proto '=https' --tlsv1.2 -H 'Content-Type: application/json' --data-binary "@$INSTALL_DIR/request.json" \
    -o "$INSTALL_DIR/response.json" -w '%{http_code}' "$SWITCHYARD_ORIGIN/hub/$route") || return 1
  [[ "$status" =~ ^2[0-9][0-9]$ ]] || return 1
}
report() {
  [[ "$CLAIMED" == 1 ]] || return 0
  post installations/progress "{\"code\":\"$PAIR_CODE\",\"instance_id\":\"$INSTANCE\",\"step\":\"$STEP\",\"status\":\"$1\",\"issue\":\"${2:-none}\"}" >/dev/null 2>&1 || true
}
checkpoint() {
  printf '%s\t%s\t%s\n' "$STEP" "$1" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$INSTALL_DIR/state.tmp"
  mv "$INSTALL_DIR/state.tmp" "$INSTALL_DIR/state"
}
step() { STEP="$1"; ISSUE="$2"; STAGE_TITLE="$4"; checkpoint running; printf '\n[%s/6] %s\n' "$3" "$4"; report running; }
cleanup() {
  if [[ "$LOCKED" == 1 ]]; then rm -f "$INSTALL_DIR/lock/pid"; rmdir "$INSTALL_DIR/lock" 2>/dev/null || true; fi
}
failed() {
  local status=$?
  trap - ERR
  checkpoint failed; report failed "$ISSUE"
  printf '\n安装停在：%s。已完成的下载和安装会保留。\n' "$STAGE_TITLE"
  say "重试：再次执行网页中的安装命令；安装码过期时，在网页点击「重新生成命令」。"
  say "详细日志：$INSTALL_DIR/install.log"
  exit "$status"
}
paused() { trap - ERR; checkpoint paused; report paused interrupted; printf '\n已暂停。再次执行安装命令即可继续。\n'; exit 130; }
lock_install() {
  if ! mkdir "$INSTALL_DIR/lock" 2>/dev/null; then
    local pid=''
    [[ ! -f "$INSTALL_DIR/lock/pid" ]] || pid=$(cat "$INSTALL_DIR/lock/pid")
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      say '另一个安装过程正在运行，请回到原终端查看进度。' >&2; return 1
    fi
    # A just-created lock may not have its pid yet. Only recover an empty lock
    # after a grace period (e.g. a crash between mkdir and writing its owner).
    if [[ -z "$pid" ]]; then
      local modified
      if [[ "$(uname -s)" == Darwin ]]; then modified=$(stat -f %m "$INSTALL_DIR/lock"); else modified=$(stat -c %Y "$INSTALL_DIR/lock"); fi
      if [[ $(( $(date +%s)-modified )) -lt 30 ]]; then say '另一个安装过程可能正在启动，请半分钟后重试。' >&2; return 1; fi
    fi
    rm -f "$INSTALL_DIR/lock/pid"; rmdir "$INSTALL_DIR/lock"
    mkdir "$INSTALL_DIR/lock"
  fi
  printf '%s\n' "$$" > "$INSTALL_DIR/lock/pid"; LOCKED=1
}
download() {
  local url="$1" target="$2" expected="$3" code=0 http=''
  if [[ -f "$target" ]] && [[ "$(hash256 "$target")" == "$expected" ]]; then say '  ✓ 复用已校验的下载'; return; fi
  if [[ -f "$target.part" ]] && [[ "$(hash256 "$target.part")" == "$expected" ]]; then mv "$target.part" "$target"; say '  ✓ 恢复已下载完成的文件'; return; fi
  # .part survives an interruption; only a verified file is promoted.
  http=$(curl --fail --location --show-error --connect-timeout 15 --max-time 1800 --retry 3 --retry-delay 2 \
    --proto '=https' --proto-redir '=https' --tlsv1.2 -C - -o "$target.part" -w '%{http_code}' "$url") || code=$?
  if [[ "$code" == 33 || "$code" == 36 || "$http" == 416 ]]; then
    say '  下载源不支持续传，将重新下载当前文件。'
    rm -f "$target.part"
    curl --fail --location --show-error --connect-timeout 15 --max-time 1800 --retry 3 --retry-delay 2 \
      --proto '=https' --proto-redir '=https' --tlsv1.2 -o "$target.part" "$url" || return 1
  elif [[ "$code" != 0 ]]; then return "$code"; fi
  if [[ "$(hash256 "$target.part")" != "$expected" ]]; then
    rm -f "$target.part"; fail integrity '下载校验未通过，未执行下载的程序。重新执行安装命令会重新下载。'; return 1
  fi
  mv "$target.part" "$target"
}
node_ok() { command -v node >/dev/null 2>&1 && node -e 'process.exit([22,24].includes(+process.versions.node.split(".")[0])?0:1)' >/dev/null 2>&1 && npm --version >/dev/null 2>&1; }
install_runtime() {
  if node_ok; then say "  ✓ Node.js $(node --version) / npm $(npm --version) 可用"; return; fi
  local platform arch checksum target archive
  case "$OS" in Darwin) platform=darwin;; Linux) platform=linux;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64;; x86_64|amd64) arch=x64;; *) fail unsupported '暂不支持此 CPU 的自动安装。'; return 1;; esac
  case "$platform-$arch" in
    darwin-arm64) checksum=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd;;
    darwin-x64) checksum=977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7;;
    linux-arm64) checksum=261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8;;
    linux-x64) checksum=061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2;;
  esac
  target="$NODE_HOME/runtime/node-v$NODE_VERSION-$platform-$arch"
  if [[ -x "$target/bin/node" ]]; then
    export PATH="$target/bin:$PATH"
    if node_ok; then say '  ✓ 复用本机节点专用 Node.js'; return; fi
  fi
  say "  安装 Node.js $NODE_VERSION 到节点目录，保留你原有的 Node.js 配置。"
  archive="$INSTALL_DIR/cache/node-v$NODE_VERSION-$platform-$arch.tar.gz"
  download "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$platform-$arch.tar.gz" "$archive" "$checksum"
  mkdir -p "$NODE_HOME/runtime"
  tar -xzf "$archive" -C "$NODE_HOME/runtime"
  export PATH="$target/bin:$PATH"
  node_ok || { fail tools 'Node.js 无法运行，请确认系统版本受支持（Linux 需要 glibc）。'; return 1; }
  say "  ✓ Node.js $(node --version) / npm $(npm --version) 验证通过"
}
sudo_ready() {
  [[ "$(id -u)" != 0 ]] || return 0
  command -v sudo >/dev/null 2>&1 || { fail permission '安装系统依赖需要管理员权限，请联系本机管理员。'; return 1; }
  if ! sudo -n true 2>/dev/null; then
    say '  接下来需要安装系统工具，请输入这台电脑的管理员密码（输入时不会显示字符）。'
    report waiting permission
    sudo -v </dev/tty || { fail permission '未获得管理员权限。授权后重新执行安装命令即可继续。'; return 1; }
    report running
  fi
}
as_admin() { if [[ "$(id -u)" == 0 ]]; then "$@"; else sudo -n "$@"; fi; }
clt_ok() { xcode-select -p >/dev/null 2>&1 && xcrun --find clang >/dev/null 2>&1; }
install_mac_tools() {
  if ! clt_ok; then
    say '  需要 Apple 命令行工具。请在系统弹窗里完成安装，本页面会等待；也可 Ctrl-C 暂停后继续。'
    report waiting tools
    xcode-select --install 2>/dev/null || true
    local n=0
    until clt_ok; do
      [[ "$n" -lt 360 ]] || { fail tools 'Apple 命令行工具尚未就绪。完成系统安装后，再执行本命令。'; return 1; }
      sleep 5; n=$((n+1))
    done
    report running
  fi
  local packages=()
  git --version >/dev/null 2>&1 || packages+=(git)
  tmux -V >/dev/null 2>&1 || packages+=(tmux)
  zsh --version >/dev/null 2>&1 || packages+=(zsh)
  python3 --version >/dev/null 2>&1 || packages+=(python)
  if [[ "${#packages[@]}" -gt 0 ]]; then
    if ! command -v brew >/dev/null 2>&1; then
      say '  使用 Homebrew 安装缺失的工具，先安装 Homebrew。'
      sudo_ready
      curl --fail --silent --show-error --location --connect-timeout 15 --max-time 120 --retry 3 \
        --proto '=https' --proto-redir '=https' --tlsv1.2 https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$INSTALL_DIR/homebrew.sh"
      NONINTERACTIVE=1 /bin/bash "$INSTALL_DIR/homebrew.sh"
      export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
      brew --version >/dev/null 2>&1 || { fail tools 'Homebrew 安装未完成，请查看上方提示后重试。'; return 1; }
    fi
    say "  安装缺失项：${packages[*]}"
    HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ENV_HINTS=1 brew install "${packages[@]}"
  fi
}
install_linux_tools() {
  local packages=() manager
  if git --version >/dev/null 2>&1 && tmux -V >/dev/null 2>&1 && zsh --version >/dev/null 2>&1 && python3 --version >/dev/null 2>&1 && make --version >/dev/null 2>&1 && c++ --version >/dev/null 2>&1; then return; fi
  if command -v apt-get >/dev/null 2>&1; then manager=apt;
  elif command -v dnf >/dev/null 2>&1; then manager=dnf;
  else fail unsupported '自动安装目前支持 Debian/Ubuntu、Fedora/RHEL 系列。其他系统请先安装 Git、tmux、zsh、Python 3、make 和 C++ 编译器。'; return 1; fi
  git --version >/dev/null 2>&1 || packages+=(git)
  tmux -V >/dev/null 2>&1 || packages+=(tmux)
  zsh --version >/dev/null 2>&1 || packages+=(zsh)
  python3 --version >/dev/null 2>&1 || packages+=(python3)
  make --version >/dev/null 2>&1 || packages+=(make)
  if ! c++ --version >/dev/null 2>&1; then
    if [[ "$manager" == apt ]]; then packages+=(g++); else packages+=(gcc-c++); fi
  fi
  if [[ "${#packages[@]}" -gt 0 ]]; then
    say "  安装缺失项：${packages[*]}"; sudo_ready
    if [[ "$manager" == apt ]]; then
      as_admin apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 update
      as_admin env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 install -y --no-install-recommends "${packages[@]}"
    else as_admin dnf install -y "${packages[@]}"; fi
  fi
}
verify_tools() {
  git --version && tmux -V && zsh --version && python3 --version && make --version >/dev/null && c++ --version >/dev/null || {
    fail tools '有工具安装后仍无法运行。请查看上方失败项，处理后重新执行安装命令。'; return 1;
  }
  say '  ✓ Git、tmux、zsh 和编译工具均可运行'
}
verify_release() {
  (cd "$1" && node --input-type=module - <<'JS'
import Database from 'better-sqlite3';
import pty from 'node-pty';
const db = new Database(':memory:');
if (db.prepare('SELECT 1 AS ok').get().ok !== 1) process.exit(1);
db.close();
const child = pty.spawn('/bin/sh', ['-c', 'exit 0'], {name:'xterm',cols:80,rows:24,cwd:process.cwd(),env:process.env});
const timer = setTimeout(() => {child.kill(); process.exit(1);}, 5000);
child.onExit(({exitCode}) => {clearTimeout(timer);process.exit(exitCode);});
JS
  )
}
install_release() {
  local expected archive abi work
  curl --fail --silent --show-error --connect-timeout 15 --max-time 60 --retry 3 --proto '=https' --tlsv1.2 \
    "$SWITCHYARD_ORIGIN/downloads/node.sha256" -o "$INSTALL_DIR/checksum"
  expected=$(awk '{print $1}' "$INSTALL_DIR/checksum")
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || { fail integrity '服务器返回了无效的校验文件，请稍后重试。'; return 1; }
  abi=$(node -p process.versions.modules)
  RELEASE="$NODE_HOME/releases/$expected-node$abi"
  if [[ -f "$RELEASE/.installed" ]] && verify_release "$RELEASE" >/dev/null 2>&1; then
    say '  ✓ 已安装版本和本机运行验证通过'; step dependencies dependencies 5 '验证节点组件'; return
  fi
  archive="$INSTALL_DIR/cache/$expected.tar.gz"
  download "$SWITCHYARD_ORIGIN/downloads/bundles/$expected.tar.gz" "$archive" "$expected"
  work="$INSTALL_DIR/build-$expected-node$abi"
  if [[ ! -f "$work/.unpacked" ]]; then
    mkdir -p "$work"; tar -xzf "$archive" -C "$work"; touch "$work/.unpacked"
  fi
  step dependencies dependencies 5 '安装并验证节点组件'
  say '  首次安装可能需要几分钟；下载缓存会保留。'
  (cd "$work" && npm ci --no-fund --no-audit --fetch-timeout=60000 --fetch-retries=2)
  verify_release "$work" || { fail dependencies '组件运行验证未通过，请查看日志后重试。'; return 1; }
  touch "$work/.installed"
  # Never alter the code or native modules of a running release in-place.
  if [[ -e "$RELEASE" ]]; then RELEASE="$RELEASE-repair-$(date +%s)"; fi
  mv "$work" "$RELEASE"
  say '  ✓ 数据库和终端组件运行验证通过'
}
main() {
  PAIR_CODE="${1:-}"
  [[ "$PAIR_CODE" =~ ^[a-f0-9]{24}$ ]] || { say '请从网页「安装本机节点」复制完整命令。' >&2; return 1; }
  OS=$(uname -s)
  case "$OS" in Darwin|Linux) ;; *) say '当前安装器支持 macOS 和 Linux。' >&2; return 1;; esac
  # curl/tar and a SHA-256 implementation are the bootstrap boundary. macOS
  # includes them; a minimal Linux without curl must download this script first.
  for program in curl tar; do command -v "$program" >/dev/null 2>&1 || { say "缺少基础下载工具 $program，请先用系统包管理器安装它。" >&2; return 1; }; done
  command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || command -v openssl >/dev/null 2>&1 || { say '缺少 SHA-256 校验工具，请先安装 openssl。' >&2; return 1; }
  SERVER_ID=$(printf '%s' "$SWITCHYARD_ORIGIN" | hash256 | cut -c 1-16)
  NODE_HOME="${SWITCHYARD_NODE_HOME:-$HOME/.switchyard/cloud/$SERVER_ID}"
  INSTALL_DIR="$NODE_HOME/install"
  mkdir -p "$INSTALL_DIR/cache" "$NODE_HOME/releases" "$NODE_HOME/data"
  chmod 700 "$NODE_HOME" "$INSTALL_DIR"
  lock_install || return 1
  trap cleanup EXIT
  exec > >(tee -a "$INSTALL_DIR/install.log") 2>&1
  trap failed ERR
  trap paused INT TERM
  export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
  if [[ -f "$NODE_HOME/data/controller-id" ]]; then INSTANCE=$(tr -d '\r\n' < "$NODE_HOME/data/controller-id");
  else INSTANCE=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n'); printf '%s\n' "$INSTANCE" > "$NODE_HOME/data/controller-id"; fi
  [[ "$INSTANCE" =~ ^[a-z0-9]{8,64}$ ]] || { fail binding '本机设备标识无效，请保留数据目录并联系维护者。'; return 1; }
  say "Switchyard 本机节点安装 · $(date '+%Y-%m-%d %H:%M:%S')"
  say '自动检测、补装并验证；中断后再次执行同一命令即可继续。'
  ISSUE=binding
  if ! post installations/claim "{\"code\":\"$PAIR_CODE\",\"instance_id\":\"$INSTANCE\"}"; then
    say '无法启动安装：请检查网络，或在网页重新生成命令。已安装内容会保留。' >&2; return 1
  fi
  CLAIMED=1
  step check unsupported 1 '检查系统与安装环境'
  if [[ "$OS" == Linux ]]; then
    systemctl --user show-environment >/dev/null 2>&1 || { fail unsupported '本机没有可用的用户级 systemd 服务。请以日常登录用户打开终端再试；容器或无 systemd 系统暂不支持后台安装。'; return 1; }
  fi
  step runtime network 2 '检测 Node.js 和 npm'
  install_runtime
  step tools tools 3 '检测并安装本机工具'
  if [[ "$OS" == Darwin ]]; then install_mac_tools; else install_linux_tools; fi
  verify_tools
  step download download 4 '下载并校验节点'
  install_release
  step start service 6 '绑定设备，启动并验证云端连接'
  printf '%s' "$PAIR_CODE" | node --import "$RELEASE/node_modules/tsx/dist/loader.mjs" "$RELEASE/server/cloud/install.ts" "$SWITCHYARD_ORIGIN" "$NODE_HOME"
  STEP=complete; checkpoint succeeded; FINISHED=1
  printf '\n✓ 安装完成，设备已在线。回到 %s/ 点击「进入工作台」。\n' "$SWITCHYARD_ORIGIN"
  say "安装日志：$INSTALL_DIR/install.log"
}
if [[ "${BASH_SOURCE[0]:-}" == "$0" || -z "${BASH_SOURCE[0]:-}" ]]; then main "$@"; fi
