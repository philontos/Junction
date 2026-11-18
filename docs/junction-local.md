# Switchyard × Junction 本机联调

Switchyard 继续管理机器、仓库、worktree 和 Agent 终端。Junction 独立保存 JSONL 原件、标准化会话、版本和共享列表。浏览器通过 Switchyard 服务端访问 Junction，不持有 Junction 令牌。

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

1. 在当前任务终端点击 **共享**，直接开始处理，无需填表或再次确认。系统自动定位 JSONL、固定快照并记录工作信息，上传后生成标题、描述和缺失标记。界面只显示一条整体进度条和成功／失败结果，保留当前终端，不打开共享库。进度依据快照、落库和完成回执推进。
2. 分享成功即进入同一 Junction 的共享列表。其他接入该服务的用户可以读取，无须逐个授权。分享只开放这份固定版本的标准化历史，原始 JSONL 保留作底稿。
3. 打开 **共享 Context**，先展示当前用户可见的 Context 卡片列表；当前所有已共享记录均可见，不自动展开任何一份。点击卡片或历史版本，在独立的 **新建任务** 弹窗中选择 Claude Code 或 Codex，然后点击 **创建任务**。来源 Context 和版本固定，仓库自动匹配、标题自动填写，可补充本次要求。取消或关闭弹窗后，列表位置不变。
4. Switchyard 下载完整固定版本，新建独立 worktree，放入前情和查询工具，启动 Agent 读取记录、核对当前代码后继续工作。创建时显示进行状态并防止重复提交；失败保留表单，成功进入任务终端。模型在“更多设置”中，历史记录和导出收在“查看 Context 详情”中。

同一节点、同一任务反复共享归到一个 Context 卡片。卡片展示最新版本的短标题、两行摘要、仓库、分支、Agent 和共享者；共享者取 Junction 的 `owner_id`，表示上传账号，目前尚无昵称和个人资料。时间、轮数和版本记录收进弹窗详情。卡片和版本列表已包含完整版本信息，点击后直接呈现完整弹窗，历史记录按需读取；接续和导出时仍由服务端核验权限。版本记录支持内部滚动和分页，选择旧版本后，预览、下载与接续都固定在该版本。打开详情不改变卡片排列。接续产生的新任务有自己的 Context，保留 `derived_from` 来源关系。

Junction v0.2 的快照还包含原生记录索引（行号、字节位置、校验值、消息关联）。Switchyard 下载时保留完整索引，离线查询器支持 `records` 分页和 `record r1` 查询；原始行字节不随普通共享下载，仍使用 Junction 的原件权限。旧快照没有索引时继续按原格式接续，索引并不代表已恢复原 Agent 的完整状态。

发布请求附带稳定的 `source_key=switchyard:<node_id>:task:<task_id>`，由 Junction 在所有者范围内原子绑定。JSONL、解析器及工作信息完全相同时复用已有版本；只有工作信息变化时产生新版本，但引用同一份 SHA-256 原件。实际 JSONL 改变则保留新原件，旧原件不覆盖。共享列表与版本列表都只显示已共享记录。

标题优先使用有意义的任务名称；“测试”等占位名会从有效需求中生成短标题。摘要由 Junction 本地提取首次有效需求和最近补充，跳过寒暄、环境注入与 skill 正文，最多 160 字符；缺失时标明暂无摘要。摘要及描述保留消息 ID 和原始行号，不推断任务完成度。旧记录可用 Junction 的 `refresh-overviews` 命令补齐，只更新派生说明。历史记录、导出和进入原任务放在折叠详情中。共享列表顶部仅保留刷新与关闭，分享从任务终端发起；手动 JSONL 导入保留 CLI/API 能力。用户分组与定向分享留待后续细化。

原生 Agent 首次进入新目录可能要求信任目录、登录或确认工具权限。终端保留这些交互，不自动继承历史权限。

## 工作区边界

发布任务时附带 `extensions["switchyard.workspace/1"]`：来源节点与任务 ID、无凭据仓库地址、分支、完整 commit、dirty 状态，以及可选 `derived_from`。Junction 将其作为不可执行的附加数据保存，核心协议不依赖 Switchyard。工作目录已移除或 Git 信息不可读，但日志仍可定位时，使用 `switchyard.capture/1` 保存可用字段及缺失说明，不阻断会话归档。

接续只使用接收方已经登记的仓库，不依据历史 URL 自动克隆或执行命令。有工作区元数据时必须匹配仓库，并从固定 commit 创建 worktree；缺少该提交时尝试从目标仓库已有 origin 获取，失败则明确提示先同步提交。JSONL 单独导入没有工作区信息时，由接收方指定仓库与分支。

未提交代码、未跟踪文件、附件内容、工具安装、skill 路径和凭据不随 Context 迁移。接续界面会说明未提交代码及解析缺口，点击继续后从已提交代码开始。原始工具调用不重放，也不伪造 Codex/Claude 的原生 session 文件。工作区查询文件不依赖在线令牌，后续 Junction 离线仍能读取已下载快照。

第一版新增的发布与创建接续任务在当前 Switchyard 节点执行；远程节点现有功能保留。自动把 Context 调度到任意远程节点尚未接入。

后续环境清单的范围、空值语义与接收方检查方式见 [Context 环境清单设计](context-environment.md)。该文档是设计草案；系统、依赖、skills、服务与权限清单的自动采集尚未实现。

## 新增 Web 服务接口

路径前缀 `/api/junction`，可选请求头 `X-Junction-Account` 选择服务端预配置别名。它不是用户认证头，也不出现在 Web 主流程中；整套 Switchyard Web 应只开放给可信设备。旧的 grants 代理接口保留兼容。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/status` | 连接状态，无令牌 |
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
