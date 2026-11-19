# Switchyard × Junction 本机联调

Switchyard 继续管理机器、仓库、worktree 和 Agent 终端。Junction 独立保存 JSONL 原件、标准化会话、版本和共享列表。浏览器通过 Switchyard 服务端访问 Junction；连接时输入的凭证仅保存在服务端私有文件中，后续不会返回给浏览器。

## 连接云端服务

打开 **共享 Context → 连接**，填写 Junction 服务地址和当前设备凭证。未配置的节点首次打开共享库会显示连接表单。公网地址使用 HTTPS，本机和可信组网 IP 可用 HTTP。

同一窗口显示设备 ID；Junction 管理员用 `device-add USER DEVICE_ID` 发放凭证。连接验证超时为 10 秒，凭证无效、设备不匹配或服务不可达时保留原配置。成功后写入默认 `DATA_DIR/junction.json`，或 `SWITCHYARD_JUNCTION_CONFIG` 指定的位置，无需重启服务。

新凭证单独保存为权限 600 的文件。旧配置备份在配置目录的 `.junction-credentials/*.previous.json`；旧令牌文件保留，供进行中的请求和手动回退使用。换服务时不会把旧服务的其他账号令牌发给新服务。确认无需回退后可清理旧文件。

每台节点独立安装 Switchyard，不复制另一台设备的整个数据目录或 `controller-id`。设备只是凭证身份与执行位置，一个用户可以有多台设备。云端部署、设备撤销和备份操作见 Junction 仓库的 `docs/deployment.md`。

## 运行

Junction 仓库中：

```sh
.venv/bin/junction serve --data-dir .local/data --hosts 127.0.0.1,10.10.0.3 --port 8767
```

先用 Junction 的 `user-add` 为本机生成令牌文件。Switchyard 端创建一个仅本机可读的配置文件：

```json
{
  "url": "http://127.0.0.1:8767",
  "default_account": "local",
  "accounts": [
    {"id": "local", "label": "本机", "token_file": "/private/path/local.token"}
  ]
}
```

`accounts[].id` 是本机配置别名，Web 使用默认账号。各台机器配置自己的凭证并连接同一个 Junction，即可读取共享列表；界面无需选择接收人或切换账号。设备访问权限仍由 Switchyard 所在环境决定。

Switchyard 中执行：

```sh
npm ci
TASK_DISPATCHER_DATA_DIR=/private/path/switchyard-junction-data \
SWITCHYARD_JUNCTION_CONFIG=/private/path/junction.json \
HOSTS=127.0.0.1,10.10.0.3 PORT=4502 npm start
```

数据目录独立于现有 Switchyard，完整保留原有功能，但不会复制原实例的任务、设备或登录授权。机器必须拥有配置的绑定地址；默认不要监听公网。Junction 令牌仅从服务端文件读取，支持服务配置变更后按请求重新读取。

## 完整链路

1. 在当前任务终端点击 **共享**，直接开始处理，无需填表或再次确认。系统自动定位 JSONL、固定快照并记录工作信息与环境清单，上传后生成标题、描述和缺失标记。界面只显示一条整体进度条和成功／失败结果，保留当前终端，不打开共享库。进度依据快照、落库和完成回执推进。
2. 分享成功即进入同一 Junction 的共享列表。其他接入该服务的用户可以读取，无须逐个授权。分享只开放这份固定版本的标准化历史，原始 JSONL 保留作底稿。
3. 打开 **共享 Context**，先展示当前用户可见的 Context 卡片列表；当前所有已共享记录均可见，不自动展开任何一份。点击卡片或历史版本，在独立的 **新建任务** 弹窗中选择 Agent 和当前设备上的工作目录，然后点击 **创建任务**。无需添加仓库；需要代码隔离时，再选择仓库与起始分支，创建新 Worktree。来源 Context 和版本固定，标题自动填写，可补充本次要求。取消或关闭弹窗后，列表位置不变。
4. Switchyard 下载完整固定版本，放入前情和查询工具，在所选目录或新 Worktree 中启动 Agent，读取记录、核对当前环境后继续工作。创建时显示进行状态并防止重复提交；失败保留表单，成功进入任务终端。模型在“更多设置”中，历史记录和导出收在“查看 Context 详情”中。

同一节点、同一任务反复共享归到一个 Context 卡片。卡片展示最新版本的短标题、两行摘要、仓库、分支、Agent 和共享者；共享者优先显示 Junction 的 `owner_name`，旧记录回退到 `owner_id`。时间、轮数和版本记录收进弹窗详情。卡片和版本列表已包含完整版本信息，点击后直接呈现完整弹窗，历史记录按需读取；接续和导出时仍由服务端核验权限。版本记录支持内部滚动和分页，选择旧版本后，预览、下载与接续都固定在该版本。打开详情不改变卡片排列。接续产生的新任务有自己的 Context，保留 `derived_from` 来源关系。

Junction v0.2 的快照还包含原生记录索引（行号、字节位置、校验值、消息关联）。Switchyard 下载时保留完整索引，离线查询器支持 `records` 分页和 `record r1` 查询；原始行字节不随普通共享下载，仍使用 Junction 的原件权限。旧快照没有索引时继续按原格式接续，索引并不代表已恢复原 Agent 的完整状态。

发布请求附带稳定的 `source_key=switchyard:<node_id>:task:<task_id>`，由 Junction 在所有者范围内原子绑定。JSONL、解析器及工作信息完全相同时复用已有版本；只有工作信息变化时产生新版本，但引用同一份 SHA-256 原件。实际 JSONL 改变则保留新原件，旧原件不覆盖。共享列表与版本列表都只显示已共享记录。

标题优先使用有意义的任务名称；“测试”等占位名会从有效需求中生成短标题。摘要由 Junction 本地提取首次有效需求和最近补充，跳过寒暄、环境注入与 skill 正文，最多 160 字符；缺失时标明暂无摘要。摘要及描述保留消息 ID 和原始行号，不推断任务完成度。旧记录可用 Junction 的 `refresh-overviews` 命令补齐，只更新派生说明。历史记录、导出和进入原任务放在折叠详情中。共享列表顶部仅保留刷新与关闭，分享从任务终端发起；手动 JSONL 导入保留 CLI/API 能力。用户分组与定向分享留待后续细化。

原生 Agent 首次进入新目录可能要求信任目录、登录或确认工具权限。终端保留这些交互，不自动继承历史权限。

## 工作区边界

发布任务时附带 `extensions["switchyard.workspace/1"]`：来源节点与任务 ID、无凭据仓库地址、分支、完整 commit、dirty 状态，以及可选 `derived_from`。Junction 将其作为不可执行的附加数据保存，核心协议不依赖 Switchyard。工作目录已移除或 Git 信息不可读，但日志仍可定位时，使用 `switchyard.capture/1` 保存可用字段及缺失说明，不阻断会话归档。

接续只使用接收方已经登记的仓库，不依据历史 URL 自动克隆或执行命令。有工作区元数据时必须匹配仓库，并从固定 commit 创建 worktree；缺少该提交时尝试从目标仓库已有 origin 获取，失败则明确提示先同步提交。JSONL 单独导入没有工作区信息时，由接收方指定仓库与分支。

未提交代码、未跟踪文件、附件内容、工具安装、skill 路径和凭据不随 Context 迁移。接续界面会说明未提交代码及解析缺口，点击继续后从已提交代码开始。原始工具调用不重放，也不伪造 Codex/Claude 的原生 session 文件。工作区查询文件不依赖在线令牌，后续 Junction 离线仍能读取已下载快照。

第一版新增的发布与创建接续任务在当前 Switchyard 节点执行；远程节点现有功能保留。自动把 Context 调度到任意远程节点尚未接入。

## 环境清单

共享时自动附带 `junction.environment/1`，Junction 随版本保存。记录系统、运行时、依赖文件校验值，以及日志中明确出现的工具、skills 和服务引用。缺失项和采集边界显式标记；不复制凭据。旧版本保持原样，重新共享后才有清单。Web 在“查看 Context 详情 → 来源环境”中按类别折叠查看。

接续工作区包含 `environment.json` 原快照与离线检查工具。Agent 的交接 skill 先读取概要，再按任务需要使用：

```sh
node .tdsp/context/read.mjs environment
node .tdsp/context/read.mjs environment skills
node .tdsp/context/read.mjs check-environment system,runtimes,dependencies
```

检查默认比较系统平台/架构、Node/Python 版本、依赖文件校验值；参数可缩小范围。其他类别明确返回需人工或 Agent 核对，不自动联网、安装或登录。结果写入独立的 `environment-check.json`，绑定来源版本和接收工作区，原快照不修改。事实差异不等于不兼容；历史权限不继承。采集器范围、时限和协议语义见 [Context 环境清单](context-environment.md)。

## 新增 Web 服务接口

路径前缀 `/api/junction`，可选请求头 `X-Junction-Account` 选择服务端预配置别名。它不是用户认证头，也不出现在 Web 主流程中；整套 Switchyard Web 应只开放给可信设备。旧的 grants 代理接口保留兼容。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/status` | 连接状态，无令牌 |
| GET | `/connection` | 本机设备 ID、服务地址和是否已配置；不返回令牌 |
| POST | `/connection` | 接收 `{url,token}`，验证服务身份后保存本机连接 |
| GET | `/contexts` | 分页列出共享记录，固定最新已分享版本 |
| GET | `/contexts/:cid/revisions` | 分页列出可见版本 |
| GET | `/contexts/:cid/revisions/:rid` | 固定版本详情 |
| GET | 上述版本路径 + `/messages`、`/turns`、`/diagnostics` | 分页查询 |
| GET | 上述版本路径 + `/messages/:mid/content` | 完整内容分块 |
| GET | 上述版本路径 + `/export` | 下载完整标准化 JSON |
| GET / PUT / DELETE | 上述版本路径 + `/grants` 或 `/grants/:user` | 查看、授予、撤销版本权限 |
| GET | `/tasks/:id/preview` | 预览本机任务的归档范围和代码状态 |
| POST | `/publish` | 按任务 ID 自动整理并分享；`?stream=1` 返回 NDJSON 处理日志及完成回执 |
| POST | `/import?provider=claude&name=...&title=...` | 上传并分享 JSONL，最多 32 MiB |
| POST | `/continue` | 固定版本、仓库、Agent 创建接续任务 |

共享流的事件为 `progress`、`complete`、`error`。只有 `complete` 表示 Junction 已完成归档与分享；HTTP 200 或连接结束均不能代替完成回执。中断可重试，重复内容复用已有版本。普通 JSON 响应保留兼容。

`/continue` 请求示例：

```json
{
  "context_id": "UUID",
  "revision_id": "UUID",
  "repo_id": 1,
  "agent": "codex",
  "title": "接续任务",
  "prompt": "本次补充要求",
  "acknowledge": false
}
```

无环境元数据时可传 `base_branch`；可选 `agent_model`，Claude 可选当前节点 `provider_id`。来源信息保存在工作区和节点的任务目录中。

## 验证

```sh
npm test
npx tsc --noEmit --allowImportingTsExtensions
```

Junction 仓库独立执行 `pytest` 和 `ruff check src tests`。本地验收数据、令牌、启动脚本、截图和样例仓库放在 Git 忽略的 `.local/`，不提交真实日志。

## 普通目录任务

机器标题旁的 **＋任务** 默认使用工作目录模式：选择 Agent，输入已有目录（`~` 表示当前执行设备的用户目录），即可创建。任务标题可留空。选择已注册仓库时，沿用原有分支、Worktree 和参考仓库流程。Shells 仍提供单独的裸终端。

- `POST /api/tasks`：不提供 `repo_id` 时接受 `agent`、`cwd`、可选 `title` / `prompt` / `agent_model` / `provider_id`；提供仓库时保留原接口。
- `POST /api/junction/continue`：同样支持 `cwd`，加载固定 `context_id` / `revision_id`。目录模式不会检出或恢复来源代码；Agent 先核对本机文件。
- `GET /api/tasks/options`：报告目录任务支持情况。云端网页比本地节点新时，引导更新本地节点，不把目录任务误当仓库任务提交。
- 目录任务记录为 `kind=directory`，`cwd` 指向用户目录，`worktree_path` 为空。归档仅停止会话，删除仅移除任务记录和节点元数据，不删除工作目录。
- 每个任务的 Context、Claude hooks、Kimi Agent 文件保存在节点的 `tasks/<id>/` 中，不写入用户目录。Claude 绑定独立 session ID；Codex/Kimi 从原生指令记录匹配任务标记，恢复时使用精确 session ID。不能确认归属就拒绝恢复或共享，不回退到同目录最新会话。
- 共享仍支持 Claude Code、Codex 原生 JSONL。Kimi 可启动并读取导入的 Context，其原生记录上传尚未支持。
