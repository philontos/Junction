# 构建与部署

在仓库根目录执行 `npm run setup`，完成相关模块的局部检查后执行 `npm run build`。正式部署使用干净提交；`dist/release.json` 记录源提交、工作区是否有修改及两个归档的 SHA-256。打包只收录 Git 已跟踪的文件，新源码需要先加入 Git。

| 产物 | 运行位置 | 内容 |
| --- | --- | --- |
| `node.tar.gz` | 用户设备、云端网关 | 工作台、节点、网关、Node 适配器和锁定依赖 |
| `junction.tar.gz` | 云主机 | Context 服务、Python 适配器、锁定依赖和部署文件 |

节点包在解压目录执行 `npm ci`，保留 `server` 兼容链接供已有安装器和 systemd 使用。工作台依赖同一发布包中的适配器和传输模块，不能仅复制 `apps/workbench`。用户在云端网页生成安装命令，由 [node/install.sh](node/install.sh) 安装本机节点；已有设备继续使用原数据与凭据。

Context 包在解压目录创建虚拟环境，并安装两个 Python 项目：

```sh
python3.12 -m venv .venv
.venv/bin/pip install -c requirements.lock ./agent-adapters .
.venv/bin/pip check
```

云端分别运行网关（默认 `127.0.0.1:8780`）和 Context 服务（默认 `127.0.0.1:8767`），由 HTTPS 代理提供公网入口。Agent 仍在用户设备执行，本机工作台的终端走回环连接；远程设备操作走网关中转。

首次部署按[云端网关指南](../apps/workbench/docs/cloud-workspace.md#服务部署)配置账号、HTTPS 和节点下载入口，按 [Context 部署指南](../services/junction/docs/deployment.md)配置数据、凭据和备份。除非特别注明，这两份服务指南中的相对路径均指**对应发布包的解压目录**。

现有安装沿用 `/srv/switchyard-cloud`、`/srv/junction` 和 systemd 服务名。这些是模板的目录约定，不依赖特定 IP 或云厂商；更换目录时同步调整服务配置。升级时创建新发布目录 → 安装与检查 → 备份数据 → 原子切换 `current` → 重启对应服务。保留旧版本和安装包用于回滚；仓库合并不要求迁移数据库或重绑设备。

在源码根目录构建 Context Docker 镜像：`docker build -f services/junction/Dockerfile .`。Compose 文件位于 `deploy/junction`，启动时显式指定部署机器上的环境文件。

## 配置与敏感信息

仓库只保存模板和示例。部署地址通过 `SWITCHYARD_CLOUD_ORIGIN` 等配置提供；Nginx 使用 `__PUBLIC_HOST__` 占位符。代码和构建不需要某台 VPS 的 IP、SSH 账号或密码。

| 信息 | 保存位置 |
| --- | --- |
| 网关实际地址和参数 | 云主机 `/etc/switchyard-cloud/gateway.env`，权限 `0600` |
| 用户、设备、注册令牌 | 云主机私有凭据目录或令牌文件，权限 `0600` |
| 节点凭据、配置、任务数据 | 用户设备 `~/.switchyard/cloud/<服务地址哈希>/` |
| TLS 私钥、SSH 密钥 | 系统证书目录或设备自己的密钥目录 |
| 数据库、原始 JSONL、备份 | 服务数据目录；不进入源码、安装包或公共下载目录 |

开发数据放在 `.local/`。Git 默认忽略本地环境文件、常见密钥/令牌文件和 SQLite 数据库，环境示例仍可提交。Git 忽略规则不能移除已提交的内容，也不代替检查：分享 Context 前同样应注意原始日志可能含有敏感信息，仓库检查不会替用户清洗历史会话。
