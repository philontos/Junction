# Switchyard × Junction 本机联调

Switchyard 继续管理机器、仓库、worktree 和 Agent 终端。Junction 独立保存 JSONL 原件、标准化会话、版本和读取授权。浏览器通过 Switchyard 服务端访问 Junction，不持有 Junction 令牌。

## 运行

Junction 仓库中：

```sh
.venv/bin/junction serve --data-dir .local/data --hosts 127.0.0.1,10.10.0.3 --port 8767
```

先用 Junction 的 `user-add` 为发布者和接收者生成令牌文件。Switchyard 端创建一个仅本机可读的配置文件：

```json
{
  "url": "http://127.0.0.1:8767",
  "default_account": "local",
  "accounts": [
    {"id": "local", "label": "发布者", "token_file": "/private/path/local.token"},
    {"id": "reviewer", "label": "接收者", "token_file": "/private/path/reviewer.token"}
  ]
}
```

`accounts[].id` 是本机配置别名；共享时填 Junction 的用户 ID。双账号选择器仅用于可信本机联调，不是多用户登录或隔离边界。正式给不同用户使用时，各自机器只配置自己的账号；设备访问权限仍由 Switchyard 所在环境决定。

Switchyard 中执行：

```sh
npm ci
TASK_DISPATCHER_DATA_DIR=/private/path/switchyard-junction-data \
SWITCHYARD_JUNCTION_CONFIG=/private/path/junction.json \
HOSTS=127.0.0.1,10.10.0.3 PORT=4502 npm start
```

数据目录独立于现有 Switchyard，完整保留原有功能，但不会复制原实例的任务、设备或登录授权。机器必须拥有配置的绑定地址；默认不要监听公网。Junction 令牌仅从服务端文件读取，支持服务配置变更后按请求重新读取。

## 完整链路

1. 在 Switchyard 本机添加仓库，创建 Claude Code 或 Codex 任务并进行对话。
2. 顶栏 **Contexts → 发布任务 → 预览发布内容 → 存入 Junction**。也可以选择已有 JSONL 文件导入。默认归档仅发布者可见。
3. 在详情中填接收方用户 ID，点击 **授权共享**。授权绑定到当前 revision；原始 JSONL 访问权另行勾选。可撤销授权，已下载副本不会被远程删除。
4. 切换接收者账号，打开共享记录，点击 **在本机接续**，选择已就绪的仓库和 Agent。
5. Switchyard 固定下载当前 revision 的完整标准化记录，包括分块返回的长工具内容。创建独立 worktree，放入 `.tdsp/context/{manifest.json,normalized.json,read.mjs,SKILL.md}`，启动当前机器的 Agent。首条提示指导 Agent 分页阅读前情并核对当前环境。
6. 若来源节点已经接入 Switchyard，详情也可 **进入原任务**，沿用现有本地/远程终端能力。这会进入原任务的当前状态，与归档快照可能不同。

原生 Agent 首次进入新目录可能要求信任目录、登录或确认工具权限。终端保留这些交互，不自动继承历史权限。

## 工作区边界

发布任务时附带 `extensions["switchyard.workspace/1"]`：来源节点与任务 ID、无凭据仓库地址、分支、完整 commit、dirty 状态，以及可选 `derived_from`。Junction 将其作为不可执行的附加数据保存，核心协议不依赖 Switchyard。

接续只使用接收方已经登记的仓库，不依据历史 URL 自动克隆或执行命令。有工作区元数据时必须匹配仓库，并从固定 commit 创建 worktree；缺少该提交时尝试从目标仓库已有 origin 获取，失败则明确提示先同步提交。JSONL 单独导入没有工作区信息时，由接收方指定仓库与分支。

未提交代码、未跟踪文件、附件内容、工具安装、skill 路径和凭据不随 Context 迁移。未提交代码或不完整解析需要明确确认后才能接续。原始工具调用不重放，也不伪造 Codex/Claude 的原生 session 文件。工作区查询文件不依赖在线令牌，后续 Junction 离线仍能读取已下载快照。

第一版新增的发布与创建接续任务在当前 Switchyard 节点执行；远程节点现有功能保留。自动把 Context 调度到任意远程节点尚未接入。

## 新增 Web 服务接口

路径前缀 `/api/junction`，可选请求头 `X-Junction-Account` 选择服务端预配置别名。它不是用户认证头；整套 Switchyard Web 应只开放给可信设备。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/status` | 连接状态与账号标签，无令牌 |
| GET | `/contexts` | 分页列出可见记录 |
| GET | `/contexts/:cid/revisions` | 分页列出可见版本 |
| GET | `/contexts/:cid/revisions/:rid` | 固定版本详情 |
| GET | 上述版本路径 + `/messages`、`/turns`、`/diagnostics` | 分页查询 |
| GET | 上述版本路径 + `/messages/:mid/content` | 完整内容分块 |
| GET | 上述版本路径 + `/export` | 下载完整标准化 JSON |
| GET / PUT / DELETE | 上述版本路径 + `/grants` 或 `/grants/:user` | 查看、授予、撤销版本权限 |
| GET | `/tasks/:id/preview` | 预览本机任务的归档范围和代码状态 |
| POST | `/publish` | 按任务 ID 归档 JSONL，可指定已有 `context_id` 追加版本 |
| POST | `/import?provider=claude&name=...&title=...` | 上传 JSONL 字节，最多 32 MiB |
| POST | `/continue` | 固定版本、仓库、Agent 创建接续任务 |

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
