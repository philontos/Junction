# 云端网页与本机节点

用户打开云端 HTTPS 网页，登录后复制一次安装命令；本机节点上线后，点击设备卡片进入原有 Switchyard 工作台。新建任务、终端、Git/worktree 和 Agent 都在所选设备运行。共享和接续 Context 仍使用 Junction。

## 边界

- 云端运行 Switchyard 网关和 Junction，不运行用户的 Agent。
- 节点主动建立 WSS 出站连接，本机只监听回环地址，不需要公网入站端口。
- 每个工作台 URL 固定一台设备，多个浏览器标签不会互相更改执行目标。
- 网关检查用户、设备归属和请求来源；网页登录凭据不传到节点。节点令牌只适用于网关，Junction 的用户令牌留在云端。
- 网关可以看到转发的请求和终端内容；连接采用 TLS。只有主动分享的 Context 由 Junction 持久化，网关不存终端正文。
- 断线显示离线并自动重连，不重放失败的任务创建请求。本机 tmux 任务继续保留。机器关机后，任务执行也会停止。
- 第一版支持 macOS、Linux 节点；macOS 已有实际安装链路。Windows 安装器、自动升级、公开注册和团队共享设备暂不包含。

## 本机安装

需要 Node.js 22+、npm、Git、tmux、zsh。Agent CLI 和认证自行安装在本机。网页「安装本机节点」产生 10 分钟有效的一次性安装码。

安装器从同一 HTTPS 服务下载发布包、校验 SHA-256，使用锁定依赖安装；在 `~/.switchyard/cloud/<服务地址哈希>/` 保存独立配置、数据、日志和版本。macOS 使用独立 LaunchAgent，Linux 使用用户级 systemd。不会改动其他 Switchyard 实例。

新增 Agent 安装在常用 PATH 目录后会被本机发现；自定义 PATH 有调整时，重新运行安装命令更新后台服务环境。凭据、SSH 密钥和 skills 不上传同步。首次选择仓库需要在这个独立节点登记仓库地址。

解除绑定会立即禁止云端访问，保留本机数据和任务。停止后台节点：macOS 使用安装输出的服务名运行 `launchctl bootout gui/$(id -u)/<服务名>`；Linux 使用 `systemctl --user disable --now <服务名>.service`。重新绑定可再次使用网页安装命令。

## 服务部署

模板在 `deploy/cloud/`。推荐独立低权限用户 `switchyard-cloud`，目录：

| 路径 | 用途 |
| --- | --- |
| `/srv/switchyard-cloud/current` | 指向只读发布目录 |
| `/srv/switchyard-cloud/data` | 网关 SQLite，schema 1 |
| `/srv/switchyard-cloud/credentials` | 每个用户的 Junction 令牌，0600 |
| `/srv/switchyard-cloud/downloads/node.tar.gz` | 与 `.sha256` 成对发布的节点安装包 |
| `/srv/switchyard-cloud/acme` | HTTP-01 验证目录 |
| `/etc/switchyard-cloud/gateway.env` | 网关配置，0600 |

`gateway.env`：

```ini
SWITCHYARD_CLOUD_ORIGIN=https://<公网 IP 或域名>
SWITCHYARD_CLOUD_DATA=/srv/switchyard-cloud/data
SWITCHYARD_JUNCTION_PORT=8767
SWITCHYARD_NODE_BUNDLE=/srv/switchyard-cloud/downloads/node.tar.gz
PORT=8780
```

网关绑定 `127.0.0.1:8780`；Junction 继续绑定 `127.0.0.1:8767`。Nginx 仅开放 TCP 80/443，保留机器已有 UDP/VPN 服务。将 `nginx.conf` 的 `__PUBLIC_HOST__` 替换为公网地址。TLS 证书在启用 HTTPS 配置前申请。IP 证书使用 Certbot 5.4+ 的 webroot 模式、`--ip-address` 和 `--preferred-profile shortlived`；启用续期定时器，每日检查两次。

创建网页登录入口（预先创建对应 Junction 用户和它的专属令牌，不要让不同用户共用同一 Junction 身份）：

```sh
node --import tsx server/cloud/admin.ts activate USER /srv/switchyard-cloud/credentials/USER.token /private/output-file
```

输出文件是一次性设置码，24 小时有效。通过私密渠道交付 `https://<地址>/#setup=<设置码>`；用户设置自己的密码。设置码只存于 URL fragment，页面读取后立即清除，不出现在 HTTP 请求或访问日志里。再次激活会撤销旧网页登录会话，已绑定设备仍保留。

首次部署应验证：网页登录、设备安装、任务创建、终端输入输出、Context 分享/接续、离线重连和解绑。健康检查：`GET /healthz`。网关数据和 Junction 数据分别备份；模板提供每日网关备份，同时保存其用户令牌。备份包含私密凭据，应定期复制到受控的另一台机器并验证恢复。证书短期有效，续期失败需要及时处理。

## 协议与验证

节点协议为 `switchyard-tunnel/1`。控制连接只接收连接请求和心跳；每次 HTTP/终端会话建立独立 WSS 字节流，节点只能转发到本进程固定的回环端口。保留 HTTP/WebSocket 原有消息格式和流控，不引入任务执行 RPC，也不修改 Context 标准。

`server/cloud/cloud.test.ts` 覆盖登录/绑定的单次使用和过期、设备归属、撤销、大请求、流式进度、终端、断线不重放、重连及本机访问限制。前端继续使用现有组件，只给 API 和终端 URL 加设备前缀。
