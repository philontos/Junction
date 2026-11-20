# 云端网页与本机节点

云端地址始终是登录、设备管理和选择设备的工作台。每张设备卡片只有一个「开始工作」入口：已确认的本机进入 `http://127.0.0.1:<port>`，同账号其他设备使用远程连接。设备工作区顶部的「工作台」和品牌链接只返回云端设备页，不再提供本机/云端模式切换。

首次在当前浏览器接入这台电脑，安装与在线验证完成后自动进入本机。节点接受一次性登录码后，同一标签页通过短时确认标记回到云端，按账号记住该浏览器对应的设备，再进入本机工作区。这里只保存设备和回环地址的路由偏好，不保存执行凭据。后续点击卡片、设备菜单或旧云端书签，都会在加载任务和终端前选择正确入口。本机连接失败时显示重试或返回工作台，不自动降级成云端中转。

浏览器没有本机记录时，只访问当前账号在线节点上报的回环地址，通过 `/local/identity` 核对设备 ID 和本次随机挑战，兼容已安装节点、新浏览器和清除站点数据的情况；不扫描局域网，不凭名称、IP 或在线状态猜测。本机确认后隐藏「连接这台电脑」，暂时离线仍保留本机身份；解绑后重新显示连接入口。

该识别接口只允许节点配置的云端来源读取，不接受浏览器凭据、不创建会话、不开放任务或终端跨域访问。浏览器可能要求允许本地网络访问；被阻止时显示重试提示，设备入口在识别完成前不加载任务。本机识别与登录独立，实际进入仍需原有的一次性登录码。旧节点未支持 `local-discovery/1` 时可继续使用已有确认流程；浏览器存储受限时只在当前页面记住识别结果。

首次加载、登录跳转和设备跳转共用初始 loading，数据就绪后一次淡入；失败显示重试，不按固定秒数提前露出空页面。页面已有内容时后台更新，未变化的设备卡片保持原节点；Context 再次打开时保留现有结果，仅更新变化的卡片。切换设备不会启动新任务或重放命令。

本机入口只监听回环地址，不开放公网端口。节点通过现有控制连接签发一次有效、60 秒过期的登录码，放在 URL fragment 中，由本机页面立即清除并兑换 HttpOnly、SameSite=Strict 的 24 小时会话。长期节点凭据不进入浏览器。设备换绑或撤销后撤销本机会话（在线时最长 20 秒）；节点重启后从工作台重新进入即可。云端临时断网不终止已登录的本机终端，Context 分享和远程设备功能需要云端恢复。

本机接入命令应在当前浏览器所在电脑执行；其他设备的回环地址不能从这台电脑访问。旧节点仍可远程使用，升级并确认本机后进入本机工作区。

已接入 Junction 的工作台（本机直连、云端中转）不显示旧版 Tailscale 远程设置引导，也不轮询其环境检查。设备安装与连接由云端门户引导；手机可通过同一云端门户远程进入。

设备工作区通过顶部设备菜单切换账号下的在线设备，点击「工作台」返回云端设备页；左侧集中展示任务，不再重复展示机器栏。原节点上的 SSH 连接收进菜单的“高级 · SSH 连接”，选中后明确显示 SSH 目标。直接访问本地 Switchyard 时仍保留原机器栏。

同一标签页按用户和设备分别记住上次任务、SSH 目标和列表位置；返回时仅重新连接仍在运行的任务。切换页面不终止原任务，多个标签页的执行目标相互独立，离线设备不能直接进入。

## 边界

- 云端运行 Switchyard 网关和 Junction，不运行用户的 Agent。
- 节点主动建立 WSS 出站连接，本机只监听回环地址，不需要公网入站端口。
- 每个工作台 URL 固定一台设备，多个浏览器标签不会互相更改执行目标。
- 网关检查用户、设备归属和请求来源；网页登录凭据不传到节点。节点令牌只适用于网关，Junction 的用户令牌留在云端。
- 远程模式下，网关可以看到转发的请求和终端内容；连接采用 TLS。本机直连的终端和任务接口不经过网关。只有主动分享的 Context 由 Junction 持久化，网关不存终端正文。
- 断线显示离线并自动重连，不重放失败的任务创建请求。本机 tmux 任务继续保留。机器关机后，任务执行也会停止。
- 第一版支持 macOS、Linux 节点；macOS 已有实际安装链路。Windows 安装器、自动升级和团队共享设备暂不包含。

## 注册与身份

注册只填账号、密码，成功后自动登录。账号为 3–32 位字母、数字、点、下划线或短横线，以字母或数字开头，大小写不区分；密码为 12–256 个字符。注册和登录均限流，密码只保存加盐 scrypt 哈希。

新账号使用固定 UUID，登录名与内部 ID 分离；旧账号保留原 ID、密码、设备和会话。注册同时通过 Junction 的创建专用内部接口建立同 ID 的用户，账号名用于 Context 作者展示。设备只能由所属用户操作；Context 继续遵循 Junction 已有的公开或授权规则。本机 Agent、SSH 密钥和执行权限不由注册迁移或授予。

Junction 初始化成功前不发放会话；网络中断后使用相同账号和密码重试，会复用已预留的 ID 和凭证。已完成注册但响应丢失时，直接登录即可。用户的 Junction 凭证留在云端，浏览器和节点不会收到它。

公开注册默认关闭。配置 `SWITCHYARD_REGISTRATION_OPEN=true` 和 `SWITCHYARD_JUNCTION_PROVISIONING_TOKEN_FILE=/etc/switchyard-cloud/provisioning.token` 后开启；关闭只影响新注册，现有登录和设备继续使用。Junction 需部署支持身份创建的版本，并配置 `JUNCTION_PROVISIONING_TOKEN_FILE` 指向同一内容的专用凭证文件（32 随机字节的 base64url，共 43 字符）。凭证只供两个云端服务读取，不可使用已有用户令牌代替。内部接口不能轮换、覆盖或接管已有身份，且不通过公网网关代理。

第一版不要求邮箱或手机号。忘记密码由管理员生成一次性设置链接：

```sh
node --import tsx server/cloud/admin.ts reset-password USER /private/output-file
```

仍使用下文的 `/#setup=<设置码>`；密码重设后旧网页登录会话失效，用户 ID、Context 和设备保持不变。

## 本机安装

网页「安装本机节点」生成命令，用户在终端执行一次。安装器自动完成六步：系统检查 → Node.js/npm → Git/tmux/zsh 与编译工具 → 下载校验 → 组件运行验证 → 绑定、启动与云端连接验证。Agent CLI 和认证仍由用户自行选择和安装。

已有节点会在下载前携带本机设备凭证核对账号。同一账号可复用已有配置和安装缓存；不同账号会暂停安装，网页显示原账号、目标账号，并提供“保留原账号”和“切换到当前账号”。换绑需要有效的本机凭证、匹配的安装码和目标账号的明确选择；设备绑定被撤销、凭证或归属已变化、安装码过期时必须重新检测。换绑复用设备 ID、节点凭证和本机任务，不要求卸载；原账号的网页终端会断开，后续请求不再有设备访问权，旧 Context 归属不迁移。离线设备换绑后仍显示等待上线。仅远程操作已有设备无需安装本机节点。

已可用的 Node.js 22/24 与工具会被复用。缺少或不兼容的 Node.js 使用官方 v24.22.3 二进制，按系统/CPU 校验固定 SHA-256，安装在节点自己的 `runtime/` 下，不修改系统 Node.js 或 shell 配置。macOS 通过 Homebrew 补装缺失工具；缺少 Homebrew 时使用其官方安装器。Apple 命令行工具由系统安装弹窗引导，安装器等待并复查。Debian/Ubuntu 使用 apt-get，Fedora/RHEL 系列使用 dnf。需要系统安装权限时提示用户在本机授权，不保存或上传密码。Linux 后台运行需要可用的用户级 systemd。

下载入口需要 curl、tar 及一种 SHA-256 工具（shasum、sha256sum 或 openssl）；macOS 自带这些基础工具。极简 Linux 如果连 curl 都没有，需要先通过系统包管理器安装 curl 和 CA 证书。自动安装覆盖 macOS、使用 glibc 的 Linux x64/arm64；其他系统会明确提示。安装器只补装缺失依赖，不做全系统升级。

安装码须在 10 分钟内开始使用。开始后绑定本机 instance ID，获得固定 24 小时续跑窗口，重复请求不会无限延长。过期后网页生成新命令，复用本地已有结果。安装状态存在网关 schema 2 的 `installations` 表中，只有所属用户可以读取；上报内容限于阶段、状态和错误分类，不上传本机命令输出、环境变量或安装日志。

安装器从同一 HTTPS 服务下载发布包、校验 SHA-256，使用锁定依赖安装；在 `~/.switchyard/cloud/<服务地址哈希>/` 保存独立配置、数据、日志和版本。macOS 使用独立 LaunchAgent，Linux 使用用户级 systemd。不会改动其他 Switchyard 实例。

`install/cache/` 保留已下载文件和可续传的 `.part` 文件，`install/state` 记录最近阶段，`install/install.log` 是本地详细日志。重试始终重新检查工具、文件摘要及组件运行结果，不仅依赖“已完成”标记；组件安装失败会保留源码和 npm 下载缓存。并发安装由本机进程锁阻止。原生组件按发布摘要和 Node ABI 分目录，运行中的旧版本不会原地覆盖。数据库实际查询、PTY 子进程启动、本机 HTTP 服务和云端在线状态均通过后，才显示安装成功。

设备凭证在请求绑定前保存到权限 0600 的临时文件；若服务端已绑定但响应丢失，重试可用同一凭证恢复设备身份。安装成功后清理临时凭证文件。重新安装同一实例保留原设备身份与任务。

新增 Agent 安装在常用 PATH 目录后会被本机发现；自定义 PATH 有调整时，重新运行安装命令更新后台服务环境。凭据、SSH 密钥和 skills 不上传同步。首次选择仓库需要在这个独立节点登记仓库地址。

解除绑定会立即禁止云端访问，保留本机数据和任务。停止后台节点：macOS 使用安装输出的服务名运行 `launchctl bootout gui/$(id -u)/<服务名>`；Linux 使用 `systemctl --user disable --now <服务名>.service`。重新绑定可再次使用网页安装命令。

## 服务部署

模板在 `deploy/cloud/`。推荐独立低权限用户 `switchyard-cloud`，目录：

| 路径 | 用途 |
| --- | --- |
| `/srv/switchyard-cloud/current` | 指向只读发布目录 |
| `/srv/switchyard-cloud/data` | 网关 SQLite，schema 3 |
| `/srv/switchyard-cloud/data/user-credentials` | 自助注册用户的独立 Junction 凭证，0600 |
| `/srv/switchyard-cloud/credentials` | 每个用户的 Junction 令牌，0600 |
| `/srv/switchyard-cloud/downloads/node.tar.gz` | 与 `.sha256` 成对发布的节点安装包 |
| `/srv/switchyard-cloud/downloads/bundles/<sha256>.tar.gz` | 不可变安装包，先上传并校验，再更新当前 `.sha256` 指针 |
| `/srv/switchyard-cloud/acme` | HTTP-01 验证目录 |
| `/etc/switchyard-cloud/gateway.env` | 网关配置，0600 |

`gateway.env`：

```ini
SWITCHYARD_CLOUD_ORIGIN=https://<公网 IP 或域名>
SWITCHYARD_CLOUD_DATA=/srv/switchyard-cloud/data
SWITCHYARD_JUNCTION_PORT=8767
SWITCHYARD_NODE_BUNDLE=/srv/switchyard-cloud/downloads/node.tar.gz
SWITCHYARD_REGISTRATION_OPEN=false
# 开启注册时配置：
# SWITCHYARD_JUNCTION_PROVISIONING_TOKEN_FILE=/etc/switchyard-cloud/provisioning.token
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

`server/cloud/registration.test.ts` 覆盖旧账号迁移、注册身份初始化与重试、跨用户隔离、限流、注册开关和密码重设。

`server/cloud/installer.test.ts` 覆盖 schema 1→2 保留身份数据、安装认领与重试、凭证恢复、断点下载与校验、仅补装缺失工具、安装后复查和并发锁；`web/cloud/install-progress.test.mjs` 验证成功判定与失败恢复提示。安装器会显示真实阶段，进度条表示完成了多少阶段，不估计剩余时间。

实现参考：[Homebrew 官方安装说明](https://docs.brew.sh/Installation)、[Node.js 官方发布文件](https://nodejs.org/dist/v24.22.3/)、[Node.js 二进制校验说明](https://github.com/nodejs/node#verifying-binaries)。
