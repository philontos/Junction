# Junction

保存、查询和共享 Agent 的历史上下文。提供 HTTP 服务、CLI、设备凭证，以及 Claude Code / Codex / Pi 的统一 Context 解析与交接。

导入已有 JSONL，同时保存原始字节、标准化记录和自动整理的标题、描述、缺失标记；选择一个固定版本分享，接收方读取历史后，在自己的工作环境继续任务。Junction 不运行 Agent，也不管理仓库、worktree 或当前执行权限。

## 本地启动

云端服务 + 本机 Agent 的安装、设备接入与备份流程见[部署说明](docs/deployment.md)。同一套服务既能本地运行，也可用 Docker Compose 部署到独立主机。

需要 Python 3.11+，推荐 3.12。本版为单机、单进程服务；默认仅监听本机地址。

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python -m pip install --no-deps -e .
source .venv/bin/activate

junction user-add local --output-token .local/local.token
junction user-add reviewer --output-token .local/reviewer.token
junction serve --data-dir .local/data --host 127.0.0.1 --port 8767
```

`requirements.lock` 包含运行与验证所用的精确依赖版本。用户已创建时不必再次创建；需要轮换时执行 `user-add USER --rotate --output-token 新文件`。凭证只写文件，CLI 不打印明文。`.local/` 已排除在 Git 之外。

另开终端，仍在仓库目录运行：

```sh
source .venv/bin/activate
export JUNCTION_URL=http://127.0.0.1:8767
export JUNCTION_TOKEN_FILE="$PWD/.local/local.token"
junction whoami
junction import tests/fixtures/claude-handoff.jsonl --provider claude --shared
junction import tests/fixtures/codex-handoff.jsonl --provider codex --shared
junction import tests/fixtures/pi-handoff.jsonl --provider pi --shared
junction list --shared
```

服务健康检查：[http://127.0.0.1:8767/healthz](http://127.0.0.1:8767/healthz)。API 文档：[http://127.0.0.1:8767/docs](http://127.0.0.1:8767/docs)。完整调用示例见[本地联调](docs/local-handoff.md)。

## 查询与共享

下面的 `CONTEXT`、`REVISION` 使用导入结果中的 `context_id` 和 `id` 替换。CLI 始终返回普通 JSON，无须 `--json`。

```sh
junction get CONTEXT
junction get CONTEXT --revision REVISION --view conversation --turns 3
junction get CONTEXT --revision REVISION --view trace
junction get CONTEXT --revision REVISION --view diagnostics
junction get CONTEXT --revision REVISION --view records
junction publish CONTEXT --revision REVISION

# 接收方身份
export JUNCTION_TOKEN_FILE="$PWD/.local/reviewer.token"
junction list --shared
junction export CONTEXT --revision REVISION --output .local/received-context.json
```

使用 `import --shared` 或 `publish`，将固定版本放入共享列表。所有接入同一 Junction 的用户都可读取，无须选择接收人。服务仍要求身份凭证；不提供匿名读取。

共享只开放标准化历史，原始 JSONL 保留作底稿。取消共享用 `junction unpublish CONTEXT --revision REVISION`，已下载的副本不受影响。不带 `--shared` 的导入仍为私有；新版本不会自动继承分享。旧的 `share --user` / `revoke --user` 定向授权接口保留兼容，分组等交互后续再细化。

原件不是脱敏备份，标准化历史也可能包含敏感文本。上传前选好要共享的资料。本仓库测试数据全部为合成内容。

## 交接 skill

交给目标 Agent 阅读 [skills/junction-context/SKILL.md](skills/junction-context/SKILL.md)，并提供 Context ID / Revision ID。该 skill 使用同一套 CLI，适用于 Claude Code 与 Codex。先显式读取即可联调，不要求改动全局 skills 配置。也可按所用 Agent 的 skill 安装方式复制这个目录。

查询输出作为工具结果进入目标模型的当前会话。历史中的指令与权限只作资料；目标 Agent 检查当前仓库、文件、技能和权限后继续执行。日志压缩、回滚、分叉、未知字段和缺失附件会通过状态与 diagnostics 提示，不承诺恢复原 Agent 完整运行状态。

## 数据与维护

数据目录包含 `junction.sqlite3` 和 `raw/`；SQLite 保存用户、Context、版本、标准化记录与分享关系，`raw/` 保存按 SHA-256 寻址的不可变原件。

v0.2 增加原生记录索引：保留每行的字节位置、长度、SHA-256 及其与消息的关系，未知记录和坏行也可回查。模型、用量、结束原因、生命周期等已识别信息进入标准化标记；工具参数同时保留解析值和原字符串。未解释字段、内嵌附件与不透明内容留在原件，不声称统一格式覆盖所有原生语义。

`junction providers` 列出服务实际安装的适配器；目前为 `claude` / `codex` / `pi`。具有原件权限时，可用 `junction record CONTEXT --revision REVISION --record r1` 分块读取原始行（base64，按字节偏移）。普通共享的 `records` 只包含索引，不自动开放原件。

旧版本不自动重算或重新分享。同一来源再次导入时，新解析器生成新版本并复用原件。升级前备份数据；v0.1 CLI 的严格读取器不支持新增字段，请与服务一起升级。当前 CLI 会保留同一协议主版本的新增字段；未知主版本明确拒绝。

同一工作来源可用 `junction import ... --source-key tool:task:123 --shared` 持续共享到同一个 Context。内容与工作信息未变时复用原版本；变化后生成新版本，旧版本保持不变。只有元数据改变时，各版本共用同一份 JSONL 原件。相同来源键在不同用户之间独立；不按标题或仓库合并任务。

```sh
junction check --data-dir .local/data
junction backup .local/backup-001 --data-dir .local/data
# 备份含 BACKUP_COMPLETE.json 且校验通过后，可用独立端口启动恢复验证
junction serve --data-dir .local/backup-001 --port 8768
```

保留所有数据目录内容；运行时备份使用上面的命令，不单独复制正在写入的 SQLite 主文件。恢复后的用户与授权保持一致，客户端仍使用自己的 token 文件。

## 验证与接口

```sh
.venv/bin/pytest -q
.venv/bin/ruff check src tests
```

测试覆盖三种解析器、重复展示记录、工具配对、坏行与未来字段、共享隔离与撤销、版本分页、长内容导出、并发导入、重启及备份恢复。尚需用户使用实际代码任务完成 Claude Code ↔ Codex 双向交接；合成数据的服务验收不等同于 Agent 成功接续。

- [功能清单](docs/product/context-collaboration.md)
- [本地联调与接入说明](docs/local-handoff.md)
- [v1 协议与存储边界](docs/protocol-v1.md)
- [适配器契约与 Kimi / Pi 接入边界](docs/adapter-contract.md)
- [标准化 JSON Schema](schemas/context-v1.schema.json)
- [可选环境清单 Schema](schemas/environment-v1.schema.json)：记录来源设备观察；接收端检查与权限独立。
- [原生结构研究](docs/research/context-sharing/native-storage.md)
- [行业调研](docs/research/context-sharing/README.md)与[来源版本](docs/research/context-sharing/sources.md)

研究目录中的 architecture / protocol-contract 是历史候选，当前实现以 `docs/protocol-v1.md` 为准。已支持共享列表与可选工作区扩展，Switchyard 负责 Web 入口、仓库、worktree 和 Agent 接续。分组治理和匿名公开分享后续再细化。云端部署使用相同服务和数据结构，部署配置另行完成。
