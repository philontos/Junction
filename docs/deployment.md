# 云端 Junction，本机 Agent

Junction 单实例保存原始 JSONL、标准化 Context、版本与共享关系。每台设备运行自己的 Switchyard、Agent 和 Git；仅在共享、浏览、接续时访问 Junction。模型请求、SSH 密钥和本机执行权限不经过这个服务。

首版是一个协作空间：所有持有效凭证的用户都能读取已共享的标准化 Context，原件仍按现有授权读取。用户可以有多个设备凭证；设备之间不继承本机权限。

## 部署目录

```
/etc/junction/compose.env             运行配置，权限 600
/srv/junction/releases/<commit>/      固定版本的代码和部署文件
/srv/junction/current                 指向当前 release 的软链接
/srv/junction/data/                   SQLite、不可变 raw/；本机磁盘
/srv/junction/backups/                通过校验的完整备份
/srv/junction/credentials/            发放凭证的临时交付目录，权限 700
/srv/junction/proxy/{data,config}/     可选 Caddy 的证书和状态
```

数据目录独立于 release，不放在网络文件系统，也不挂载给其他 Junction 实例同时运行。API 容器以 UID/GID 10001 运行，根文件系统只读；管理 CLI 的临时容器才挂载备份和凭证目录。

## 首次安装

需要 Linux、Docker Engine 和 Compose v2。先检查主机现有服务、磁盘与端口。以下命令只用于新建的 Junction 专属目录；已有同名目录时先确认归属，不递归改变已有目录权限。

```sh
sudo install -d -m 0755 /srv/junction/releases /etc/junction
sudo install -d -m 0700 -o 10001 -g 10001 \
  /srv/junction/data /srv/junction/backups /srv/junction/credentials
sudo install -d -m 0700 /srv/junction/proxy/data /srv/junction/proxy/config
# 将已验证的 release 放到 /srv/junction/releases/<commit>
sudo install -m 0600 deploy/compose.env.example /etc/junction/compose.env
```

编辑环境文件：

- `JUNCTION_IMAGE=junction:<commit>`，每个 release 使用独立标签，保留上一版镜像。
- 默认 `127.0.0.1:8767`。已有 HTTPS 网关时将其反代到这个地址。
- 通过组网访问时，可将 `JUNCTION_BIND_ADDRESS` 改为主机的组网 IP。本机 Switchyard 可连接这个内网 HTTP 地址。
- 新建 HTTPS 入口时：域名解析到这台主机、确认 80/443 空闲，再设 `COMPOSE_PROFILES=https` 和 `JUNCTION_DOMAIN=实际域名`。Caddy 自动申请证书。
- 默认 Python、Caddy 镜像已固定为验证过的 `@sha256:...`；后续 release 显式升级。首次上云仍在目标主机架构上构建和验收。

以下运维命令在有权读取配置和操作 Docker 的部署账号下执行；按上面的 root 文件权限安装时，先进入 `sudo -i` 会话，再到 release 的 `deploy/` 目录：

```sh
./junctionctl build
./junctionctl up
./junctionctl status
./junctionctl check
curl --fail http://127.0.0.1:8767/healthz
```

`up` 等待健康检查，失败返回非零。容器随 Docker 重启，日志轮换保留至多 3 × 10 MiB。服务和默认 Caddy 配置不记录 HTTP 访问日志；复用其他网关时同样避免记录 Authorization、请求正文以及含环境描述的完整查询参数。

## 无 Docker 的主机

已有系统服务的轻量 VPS 可以使用 `deploy/native/` 的 systemd 单元。应用、数据格式和 API 相同；选择一种部署方式，不同时启动两个实例。

安装 Python 3.12 和 pip（AlmaLinux 9：`dnf install python3.12 python3.12-pip`），创建专用系统用户 `junction`，shell 设为 `nologin`。沿用上面的 release、data、backups、credentials 目录；后三者改由此用户拥有，权限 700。代码和虚拟环境由 root 拥有，服务用户不可修改。

在新 release 中安装固定依赖，再将 `current` 指向它：

```sh
python3.12 -m venv .venv
.venv/bin/pip install --constraint requirements.lock .
# 首次安装；升级时仍先用旧 release 的 CLI 完成备份
install -m 0644 deploy/native/junction.service /etc/systemd/system/
install -m 0644 deploy/native/junction-backup.service deploy/junction-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now junction.service junction-backup.timer
curl --fail http://127.0.0.1:8767/healthz
deploy/native/junctionctl check
systemctl start junction-backup.service
```

`junctionctl` 随 release 带有执行权限；若通过未保留文件模式的方式传输，只对该脚本执行 `chmod 755 deploy/native/junctionctl`。

原生服务仅监听 `127.0.0.1:8767`，以低权限用户运行，代码只读，仅数据目录可写。管理命令使用 `deploy/native/junctionctl admin ...`，凭证输出路径为 `/srv/junction/credentials/...`。备份仍通过 SQLite 在线备份 API 完成。

无域名的联调可通过 SSH 本地转发：`ssh -N -L 127.0.0.1:18767:127.0.0.1:8767 USER@HOST`，本机 Switchyard 连接 `http://127.0.0.1:18767`。长期隧道使用专用低权限用户和仅允许访问该端口的密钥，由本机进程管理器保持连接；不保存 root 密码。后续添加 HTTPS 网关时只需切换设备服务地址。隧道是该设备的连接方式，其他设备需建立自己的连接。

参考：[systemd 服务隔离](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)、[OpenSSH 密钥限制](https://man.openbsd.org/sshd#AUTHORIZED_KEYS_FILE_FORMAT)。

## 连接设备

创建用户一次，再为每个本机 Switchyard 的设备 ID 发放独立凭证：

```sh
./junctionctl admin user-add alice --output-token /credentials/alice-owner.token
./junctionctl admin device-add alice 0123abcd --label alice-laptop \
  --output-token /credentials/alice-0123abcd.token
./junctionctl admin device-list alice
```

用户凭证保留离线用于兼容旧客户端，日常设备使用各自的设备凭证。通过现有安全通道交付 `credentials/` 中对应的 token 文件，完成交付后删除该交付文件；云端数据库仅保存 token 的 SHA-256。不要将 token 放进 URL、Git、工单或普通服务日志。

本机 Switchyard → **共享 Context → 连接**：填写服务地址和设备凭证。设备 ID 在同一窗口显示，可复制给管理员。服务返回身份、设备 ID 与本机匹配后，Switchyard 才保存配置，随后加载共享列表。凭证以 600 权限保存在本机，不回传浏览器，也不存入浏览器 localStorage。验证失败保留原配置。

```sh
# 换发只影响这一台设备，输出必须是新文件；旧凭证立即失效
./junctionctl admin device-add alice 0123abcd --rotate \
  --output-token /credentials/alice-0123abcd-v2.token
# 遗失或停用设备
./junctionctl admin device-revoke alice 0123abcd
```

设备 ID 用于识别与避免误用，Bearer token 本身不是硬件绑定凭证。轮换用户凭证不连带撤销设备凭证；需要停用哪些设备就逐个撤销。撤销阻止后续认证，不回收已下载的 Context 或中断已授权的进行中请求。

## 联调验收

1. A、B 使用不同设备凭证，连接同一 Junction；本机 Switchyard 保持在本机或可信组网内。
2. A 在一个未完成的测试任务中点击共享；B 刷新共享列表，看到同一个 Context 版本。
3. B 选择本机仓库与 Agent，接续 Context；验证历史和环境清单被加载、实际 worktree 在 B 本机创建。
4. A 再共享新进展，形成新版本；B 已下载的旧版本不改变。
5. 撤销 B 的测试凭证，确认 B 后续请求被拒绝、A 仍可用。

代码仍通过 Git 取得：两台机器需要可访问同一仓库及对应 commit，未提交文件不会随 Context 搬迁。日志中的绝对路径和环境描述作为来源证据，接收方重新检查本机能力。接续任务发生在打开的 Switchyard 所在节点；本版没有云端远程调度队列。

## 备份、升级与回退

```sh
./junctionctl backup
# 每个完成的备份都包含 BACKUP_COMPLETE.json；命令会执行数据库与原件校验。
```

使用 SQLite 在线备份 API 获取一致数据库，再复制该快照引用的不可变原件。不要只复制运行中的 sqlite3 主文件。复制整个已完成备份到另一台机器或受限对象存储，并至少做一次恢复演练；同盘备份不覆盖磁盘损坏。部署包不默认删除历史备份，按磁盘情况制定保留周期。

启用定时备份前，将 `/srv/junction/current` 指向已部署 release，再安装：

```sh
sudo install -m 0644 junction-backup.service junction-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now junction-backup.timer
sudo systemctl start junction-backup.service
sudo systemctl status junction-backup.service
```

升级顺序：**用旧镜像完成备份 → 构建新固定标签镜像 → 更改运行标签 → up → 健康与读写验收 → 更新 current**。服务启动时进行事务性迁移；v0.3 将数据库从 v5 升为 v6，增加设备凭证表，Context 与原件保持不变。

回退涉及 schema 变化时，旧镜像不能直接读取升级后的数据库。停止 Junction，保留现有数据，将升级前备份复制到新的恢复目录；使用与备份匹配的镜像检查这个副本，再将 `JUNCTION_DATA_DIR` 和 `JUNCTION_IMAGE` 同时切换到恢复目录及旧标签后启动。不要覆盖唯一备份。恢复验证包括健康检查、登录、共享列表、标准化记录与原件校验。

备份包含当时的用户、凭证哈希和授权；恢复旧备份可能恢复后来撤销的凭证，需要重新执行对应撤销。云端上线时确认一次异机备份目的地和容量监测即可，暂不引入集群、Redis、任务队列或独立对象存储。

参考：[Compose 单机生产部署](https://docs.docker.com/compose/how-tos/production/)、[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)、[SQLite WAL 限制](https://sqlite.org/wal.html)、[SQLite 在线备份](https://sqlite.org/backup.html)。
