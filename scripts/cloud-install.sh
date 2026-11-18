#!/usr/bin/env bash
set -euo pipefail
umask 077
SWITCHYARD_ORIGIN='__SWITCHYARD_ORIGIN__'
PAIR_CODE="${1:-}"
if [[ ! "$PAIR_CODE" =~ ^[a-f0-9]{24}$ ]]; then
  echo '请从云端网页「安装本机节点」复制完整命令。' >&2; exit 1
fi
for program in node npm git tmux zsh curl tar shasum; do
  if ! command -v "$program" >/dev/null 2>&1; then
    echo "缺少 $program。请先安装 Node.js 22+、Git、tmux 和 zsh，再运行此命令。" >&2
    echo 'macOS 可运行：brew install node git tmux；Linux 请用本机包管理器安装。' >&2
    exit 1
  fi
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("需要 Node.js 22 或更新版本。"); process.exit(1); }'
case "$(uname -s)" in Darwin|Linux) ;; *) echo '当前安装器支持 macOS 和 Linux。' >&2; exit 1;; esac
SERVER_ID=$(printf '%s' "$SWITCHYARD_ORIGIN" | shasum -a 256 | cut -c 1-16)
NODE_HOME="$HOME/.switchyard/cloud/$SERVER_ID"
mkdir -p "$NODE_HOME/releases"
chmod 700 "$NODE_HOME"
INSTALL_TMP=$(mktemp -d "$NODE_HOME/.install.XXXXXX")
trap 'rm -rf "$INSTALL_TMP"' EXIT
echo '[1/4] 下载并校验本机节点…'
curl --fail --silent --show-error --proto '=https' --tlsv1.2 "$SWITCHYARD_ORIGIN/downloads/node.sha256" -o "$INSTALL_TMP/checksum"
EXPECTED=$(awk '{print $1}' "$INSTALL_TMP/checksum")
if [[ ! "$EXPECTED" =~ ^[a-f0-9]{64}$ ]]; then echo '安装包校验文件无效。' >&2; exit 1; fi
RELEASE="$NODE_HOME/releases/$EXPECTED"
if [[ ! -f "$RELEASE/.installed" ]]; then
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 "$SWITCHYARD_ORIGIN/downloads/node.tar.gz" -o "$INSTALL_TMP/node.tar.gz"
  ACTUAL=$(shasum -a 256 "$INSTALL_TMP/node.tar.gz" | awk '{print $1}')
  if [[ "$ACTUAL" != "$EXPECTED" ]]; then echo '安装包校验失败，请重新获取安装命令。' >&2; exit 1; fi
  mkdir "$INSTALL_TMP/release"
  tar -xzf "$INSTALL_TMP/node.tar.gz" -C "$INSTALL_TMP/release"
  echo '[2/4] 安装依赖，首次安装可能需要几分钟…'
  (cd "$INSTALL_TMP/release" && npm ci --no-fund --no-audit)
  touch "$INSTALL_TMP/release/.installed"
  if [[ -e "$RELEASE" ]]; then echo '此版本已被另一个安装进程创建，请重新执行。' >&2; exit 1; fi
  mv "$INSTALL_TMP/release" "$RELEASE"
else
  echo '[2/4] 复用已校验的安装版本。'
fi
echo '[3/4] 绑定设备…'
# Pass the short-lived code through stdin, rather than a child command line.
printf '%s' "$PAIR_CODE" | node --import "$RELEASE/node_modules/tsx/dist/loader.mjs" "$RELEASE/server/cloud/install.ts" "$SWITCHYARD_ORIGIN" "$NODE_HOME"
