# Junction

一个仓库，两个运行环境：云端管理账号、设备和 Context，本机运行 Junction 工作台与 Agent。当前电脑使用本机直连；远程设备保留云端中转。

Junction 让未完成的工作可以交接：把 Agent 的原始会话保存为底稿，转换成可查询的统一 Context，供另一台设备或另一个 Agent 理解前情、核对环境后继续。代码仓库、工具安装和执行权限仍由工作设备管理。

## 本地开发

需要 Node.js 22+、Python 3.11+；运行任务还需要 Git、tmux、zsh 和对应 Agent CLI。

```sh
git clone https://github.com/philontos/Junction.git
cd Junction
npm run setup
npm run dev
```

打开 **http://127.0.0.1:3100**。同时启动的 Context 服务位于 `127.0.0.1:8768`，开发账号和连接自动配置。数据独立保存在 `.local/dev/`，再次启动会复用。端口冲突时设置 `WORKBENCH_PORT` 和 `JUNCTION_PORT`。Ctrl+C 只停止本次服务，不关闭已有 tmux 任务。

## 目录

| 路径 | 职责 |
| --- | --- |
| `apps/workbench` | Junction 界面、本机节点、任务与工作环境 |
| `services/junction` | Python Context 服务；`gateway/` 管理账号、设备和中转 |
| `packages/agent-adapters` | Node Agent 启动/日志定位与 Python JSONL 归一化 |
| `packages/node-transport` | 本机和云端复用的传输原语 |
| `deploy` | 开发启动、发布打包、云端部署与节点安装 |

目录统一，运行边界不变；节点凭据、数据库、工作目录和 Agent 安装不进仓库。两份旧仓库的提交历史均保留；Switchyard 的旧导入路径只作兼容转发，不维护第二份实现。

部署不绑定某台 VPS：仓库提供通用模板，实际域名/IP、令牌、证书和数据保存在部署机器上，见[配置与敏感信息](deploy/README.md#配置与敏感信息)。

## 页面入口

左侧窄导航只有 **工作台 / Context**：工作台直接承载任务、仓库与终端，Context 是独立的共享空间，可按标题、用户名搜索，或筛选自己共享的记录。进入设备后，两者在同一个页面即时切换：终端保持连接与尺寸，卡片、搜索和滚动位置保留；先展示已有内容，再后台刷新。浏览云端 Context 时预加载工作台资源；设备路由确认后，任务、仓库和机器数据与前端模块并行加载。首次没有数据时只在对应内容区加载，Context 正文与版本按需读取。

- 云端首页及 `/contexts`：直接浏览当前账号可见的共享记录，不要求节点在线。
- `/workbench`：进入上次使用的在线设备；没有记录时优先本机，再选择可用设备。本机走回环地址，其他设备走中转。
- 顶部设备下拉：切换设备；“设备接入与配置”打开管理弹窗。`/devices` 兼容旧链接，打开同一弹窗，不再是工作台页面。本机直连时，账号管理在新的云端标签页中打开，保留当前任务连接。
- 接续：打开 Context 后统一预览对话、环境和记录信息，底部“继续此任务”保持不变。点击后在同一弹窗选择 Agent；从云端共享空间进入时先选择执行设备。返回预览会保留已填配置，工作目录自动准备，仅浏览或切换页签不会启动任务。

返回页面时可复用按账号隔离、15 分钟有效的卡片摘要，点开仍读取授权后的固定版本；对话与环境详情不写入浏览器缓存。云端浏览走只读 `/hub/context/contexts…`，设备内浏览走 `/api/junction/contexts…`，权限均由服务端检查。

## 任务工作区

新建任务默认自动分配目录，只需选择 Agent 并描述任务。选择仓库时自动创建独立 Worktree；也可以选择“指定已有目录”。从共享 Context 接续时，无需选择工作位置：执行设备自动匹配对应仓库，缺少时添加仓库并拉取代码，再从记录的提交创建新分支和 Worktree；同一仓库有多个登记时复用最早就绪的一项。仓库访问使用本机已有的 Git 认证，不会沿用来源设备的绝对路径或凭据。没有仓库地址的 Context 自动分配独立任务目录；来源包含代码信息却缺少地址时明确提示代码尚未恢复。

接续过程展示读取 Context、准备仓库、拉取代码、创建工作区、启动 Agent 的实际阶段。主仓库或固定提交无法准备时，改为普通 Agent 任务并保留历史，不会冒充恢复成功或改用主分支；修复网络或权限后重试会复用已添加的仓库。历史中只记录了分支时使用该分支的当前版本，并在启动前注明；未提交修改仍不随 Context 传输。

新工作区放在可见的 `~/Junction/workspaces/<节点标识>/`，与 `.switchyard` 中的凭据、数据库和安装包分开。节点标识用于隔离同一台电脑上的不同节点实例：

```text
~/Junction/workspaces/<节点标识>/
  tasks/<任务 ID>/                       普通 Agent 任务
  repos/<仓库 ID>-<仓库名>/<任务 ID>/      仓库任务的 Worktree
```

普通任务和 Context 接续均可添加 Ref，选择当前执行设备的仓库、分支与别名。仓库任务的参考快照位于 Worktree 内的 `.tdsp/refs/<别名>/`；目录任务的参考快照与清单放在节点 `tasks/<任务 ID>/.tdsp/`，Agent 通过绝对路径读取，因此多个任务使用同一已有目录时互不覆盖。Ref 固定到选定分支的提交，默认只读，运行中仍可追加。

仓库与 Context 提交均使用 blobless fetch 保留完整提交历史，创建 Worktree 时批量下载当前版本文件；已有 Context 提交直接复用。Context 历史分页使用接口允许的批量大小，长消息限流并发读取，保留原顺序与完整性检查。

普通仓库任务提交后立即显示任务编号，工作区在执行设备上后台准备；刷新页面后仍可查看准备阶段或停止创建。同一仓库的工作区准备依次使用共享缓存，避免并发重复下载。分支更新限时 90 秒，首次工作区文件下载单独限时 10 分钟；大文件仓库首次需要下载完整的当前版本，后续任务复用已完成的缓存。

旧任务保持原路径；恢复任务使用已记录目录。普通任务的目录在归档或删除任务记录后保留，仓库任务沿用原有的显式 Worktree 清理流程。节点升级不移动工作区。

需要自定义位置时，可在节点私有 `node.json` 设置 `workspace_root` 并重启节点，或为独立运行的服务设置 `JUNCTION_WORKSPACE_ROOT`。仅影响新任务。`npm run dev` 的工作区仍放在隔离的 `.local/dev/` 中。

工作区是执行环境，Context 是可共享资产：共享上传会话快照和环境描述，不上传工作目录；同一任务继续共享归入同一 Context，内容变化时生成新版本。从 Context 接续会创建独立任务，固定来源 Context 与版本；再次共享记录 `derived_from`，不会覆盖原 Context。任务清单和交接来源保存在节点的 `tasks/<任务 ID>/`；接续用的固定版本历史副本放在任务控制目录的 `.tdsp/context/`，与 Agent 自己生成的会话分开。

共享前检查未提交文件和提交的远端可获取性，有问题才提醒返回处理或仍然共享；不会自动提交、推送或转移工作区文件。共享同时记录 Ref 的地址、别名、分支和固定提交；接续逐个准备只读参考目录，失败项不阻止其他 Ref 或 Agent 启动。旧 Context 没有清单时标为未记录。

接续完成后显示需要手动关闭的启动与环境报告，列出已就绪、缺失、有差异和待核对项；任务标题旁的小图标可再次打开。报告存于节点 `tasks/<任务 ID>/continuation.json` 和数据库，Agent 读取任务控制目录下的 `.tdsp/context/preparation.json`。仓库任务的控制目录就是独立 Worktree；目录任务使用节点 `tasks/<任务 ID>/`，不会向共用工作目录写同一份交接文件。

节点 CLI 与 Web 共用接续流程（使用当前节点的数据与连接配置）：

```sh
tdsp context check <task-id> --json
tdsp context continue <context-id> --revision <revision-id> --agent codex --json
tdsp context report <task-id> --json
```

## 常用命令

```sh
npm run typecheck
npm run test:targeted
npm run test:context
npm run build
```

构建产生 `dist/node.tar.gz`、`dist/junction.tar.gz`、SHA-256 和共同的源提交号。分别用于节点/云端网关与 Context 服务，无需把 Python 服务安装到每个节点。

- [部署与升级](deploy/README.md)
- [架构与依赖方向](docs/architecture.md)
- [Agent 接入](packages/agent-adapters/README.md)
- [云端、本机工作台与设备接入](apps/workbench/docs/cloud-workspace.md)
- [Context 协议](services/junction/docs/protocol-v1.md)
- [原 Switchyard 使用说明](apps/workbench/README.md)
