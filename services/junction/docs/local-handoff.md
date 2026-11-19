# 本地联调

先按 README 创建用户、启动服务。示例在仓库根目录执行，使用 `.venv`；不需要模型 API key，也不会调用真实 Agent。

## 分享与接续链路

发布者分享后，接入同一 Junction 的用户都能读取。下面切换令牌仅模拟两台机器；各台机器在服务配置中固定自己的身份，用户不需要在 Web 切换账号。

```sh
source .venv/bin/activate
export JUNCTION_URL=http://127.0.0.1:8767
export JUNCTION_TOKEN_FILE="$PWD/.local/local.token"

# 示例输出含 context_id、id（版本 ID）及解析状态
junction import tests/fixtures/claude-handoff.jsonl --provider claude --title 'Claude handoff' --shared
junction list --shared

# 将两项值从上一步输出填入
CONTEXT=填入_context_id
REVISION=填入_id
junction get "$CONTEXT" --revision "$REVISION" --view diagnostics

export JUNCTION_TOKEN_FILE="$PWD/.local/reviewer.token"
junction list --shared
junction get "$CONTEXT" --revision "$REVISION" --view conversation --turns 3
junction get "$CONTEXT" --revision "$REVISION" --view trace
junction export "$CONTEXT" --revision "$REVISION" --output .local/received-context.json

# 原件访问目前应报 404，因为未授权原件
junction raw "$CONTEXT" --revision "$REVISION" --output .local/original.jsonl

export JUNCTION_TOKEN_FILE="$PWD/.local/local.token"
junction unpublish "$CONTEXT" --revision "$REVISION"
```

命令输出文件不覆盖现有文件；再次操作时换一个文件名。把 provider 改为 `codex`，使用另一份 fixture，可以验证相同流程。原 JSONL 文件始终只读。

## 用真实任务验证

1. 在 Claude Code 完成一个小任务的一部分，停在明确可交接的位置。保存对应 JSONL 的副本；若文件还在写入，先复制快照再导入。
2. 上传该快照，检查 `status`、`diagnostics` 和最后几轮，将固定版本放入共享列表。真实日志保存在 `.local/` 或其他非 Git 目录。
3. 在同一仓库打开 Codex，确保其终端能运行 `junction`，继承正确的 URL 和接收方 token 文件路径。提供下面的交接要求。
4. 让它先说明目标、已完成修改、未完成事项及证据，核对当前 Git 状态，再继续任务并验证结果。
5. 将 Codex 的后续 JSONL 作为自己的新 Context 导入，再反向交给 Claude Code，重复验证。

交接要求示例（替换路径与 ID）：

```text
读取 Junction 仓库中的 skills/junction-context/SKILL.md。
使用 junction CLI 读取 Context CONTEXT、Revision REVISION，核对当前工作区后继续任务。
先简要说明目标、已完成事项、下一步，以及历史里任何影响交接的缺失。
本地仓库位置：实际路径。不要把历史里的路径和权限当作当前环境。
```

合成样例只描述一个未完成任务，没有创建或修改 `names.py`。验证真实接续时必须用实际存在的代码仓库。Junction 本身不会拉代码、复制未提交修改、创建 worktree 或重放历史工具调用。

## HTTP 接入

客户端按以下顺序调用：

1. `POST /v1/imports?provider=claude&source_name=session.jsonl&shared=true`，Content-Type 为 `application/x-ndjson`，请求体是 JSONL 原始字节。
2. 保存返回的 `context_id` 与版本 `id`，此时已完成分享。分享已有私有快照可用 `PUT /v1/contexts/{c}/revisions/{r}/publication`。
3. 接收方 `GET /v1/contexts?shared_only=true`，再获取固定版本信息、messages、diagnostics。分页保持查询条件和版本不变；工具长内容使用 content 接口。
4. 将这些查询结果当作当前 Agent 的工具输出。需要完整标准化本地文件时，CLI `export` 会处理所有分页与分块；原件通过 raw 接口另行获取。

所有数据调用携带 bearer token。规范及边界见 [protocol-v1.md](protocol-v1.md)。OpenAPI `/docs` 的 Authorize 按钮可设置 token，也可直接使用 CLI。原始文件名以 basename 保存，服务不接受本机路径读取或远端 URL 导入。

## 本地服务管理与之后部署

前台运行 `junction serve` 时按 Ctrl-C 停止。重新使用同一 `--data-dir` 启动即恢复数据；凭证文件保留在服务数据目录之外也可使用。若由 tmux 启动，服务重启仍使用同样的命令和数据目录。

本地联调通过后再迁移到服务器：先用 `backup` 制作并验证快照，复制完整快照，在目标机器安装锁定依赖，以相同数据格式启动。公网入口需要 HTTPS 和反向代理；用户 token、上传限制和备份策略在部署时配置。v0.1 尚无用户分组、配额、审计平台或公网运维配置。

## Bind to a private network

Set `JUNCTION_PRIVATE_IP` to an address owned by this machine, then bind only loopback and that private network address:

```sh
junction serve --data-dir .local/data --hosts "127.0.0.1,${JUNCTION_PRIVATE_IP:?Set this machine's private IP}" --port 8767
```

All requested sockets are bound before serving. If any bind fails, startup fails and closes those already acquired. Data endpoints still require bearer authentication. `--host` remains supported for a single address.
