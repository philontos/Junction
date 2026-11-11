# Junction v1：存储与交换契约

状态：随 v0.1.0 实现，面向单节点、本地联调。研究目录中的候选协议不构成本版本的实现承诺。

## 数据边界

```text
Claude / Codex JSONL → 解析器 → 不可变 Revision → 分页 HTTP / CLI → 目标 Agent
                           ↘ 原始字节归档（独立读权限）
```

- **Context** 是用户拥有的资产，具有 Junction UUID、标题和所有者。
- **Revision** 是完整快照，具有独立 UUID、递增序号、原件 SHA-256、来源文件名、provider、解析器版本、创建时间和解析状态。新快照不覆盖旧记录，也不自动继承分享。
- **标准化内容** 为 `Session → Turn → Message → content[]`，结构见 [JSON Schema](../schemas/context-v1.schema.json)。`schema_version` 固定为 `junction.context/1`，与 `parser_version`、数据库版本分别管理。
- **原件** 是上传的完整字节，按 SHA-256 归档。上传者做过的脱敏就是该原件的一部分；服务不宣称核实它来自官方工具，也不自动脱敏。
- **投影** 是原件的可查询解释，不是原 Agent 完整内存、精确模型请求或可直接 resume 的状态。历史角色、权限与提示词均不具有当前执行权限。

`ready` 表示当前解析器未发现影响可读性的缺口；`partial` 表示存在缺失、未知内容或不确定关系；`failed` 表示没有识别出可读对话。`ready` 不代表源日志包含完整模型上下文。

`history_semantics=recorded_history`，`effective_history=not_reconstructed`。保留压缩检查点、回滚和分叉标记及诊断，不擅自重建活跃分支。Codex `history_base` 只记录缺失祖先提示，不访问其指向的文件。

## 内容与来源

内容块包括文本、可见 reasoning、工具调用、工具结果、附件引用、事件标记和未知内容标记。工具参数、结果保持 JSON 值；无法解释的参数字符串仍保留字符串。工具关联仅依赖原生 session / call ID，缺失与歧义明确标记。

消息记录原始行号（从 1 开始）、原生 envelope/message/parent/turn/session ID；原始文件名在 Revision 上。Junction 的消息与轮次 ID 只在该 Revision 内唯一。时间戳是日志提供的字符串，不用它重排历史；顺序按原文件记录。无原生轮次时，按非 meta 用户输入推导，并标记 `inferred`。

Claude 同一 API message ID 的分块不能直接合并；相同原生 ID、内容与关联信息的重复记录合并来源行号。Codex 展示事件仅在显式同一 turn 且内容吻合时与主记录配对；缺乏关联依据时保留并提示，不按全局相同文本去重。

附件保留路径/URL 和可用性。服务不读取日志中的本机路径、不下载 URL、不复制环境。内嵌图片本版保存在原件，标准化记录标记 `raw_only`；接收者需要原件授权才能取得这些字节。未识别的 provider 字段仍在原件中，不声称无损转换成统一结构。

`extensions` 支持可选的、带版本命名空间的对象，例如 `switchyard.workspace/1`；默认空对象，不接受环境执行指令。`junction.overview/1` 由服务生成，导入方不能自行提供该命名空间。扩展不得改变核心字段的含义。仓库、分支、worktree 和权限控制由外部集成处理。

## 导入与持久性

- 只接受上传的 JSONL 字节，单份上限 32 MiB；前 100,000 条非空记录参与解析，超限部分留原件并产生诊断。JSON 嵌套超过 64 层视为无法解析的记录。
- 空文件拒绝。非空文件含坏行、截断尾行或未知记录时，原件仍归档，返回诊断和状态；不会伪造补全。
- 幂等身份是 `owner + provider + 原件 SHA-256 + parser_version`；指定 Context 时再限制在该 Context 内。文件改名不改变身份，空白字节变化会形成新快照。
- 不指定 `context_id` 时，完全相同的上传返回原 Revision，否则创建 Context。**不会仅靠原生 session ID 自动追加**。指定自己的 Context 才追加完整快照；不合并两份日志、不增量 tail。已有 Context 的标题不会被追加导入改写。
- 原件先通过临时文件、文件 fsync、原子 rename 和目录 fsync 落盘，再在单个 SQLite 事务中提交 Revision、Turn、Message、Diagnostic。原件落盘后数据库提交失败，最多留下未引用归档；本版不自动清理它。
- SQLite 使用 WAL、外键、FULL 同步及写事务串行化；读取授权和对应数据在同一读事务内完成。数据目录应在本机文件系统上，服务单进程运行。
- 原件读取重新校验 SHA-256。`junction check` 检查 SQLite、外键、原件校验值与标准化结构/计数。`junction backup` 用 SQLite backup API 取得一致快照，复制其引用的不可变原件，再验证，最后写 `BACKUP_COMPLETE.json`。只有带完成标记的备份可用于恢复。

## 授权

用户由服务所在机器的管理员通过 CLI 创建；随机 bearer token 仅明文写入指定私有文件，数据库仅保存摘要。token 轮换使旧 token 无效。v0.1 的用户是隔离主体，尚无组织、分组、管理员 Web API 或公开匿名分享。

分享的最小单位是 **固定 Revision**。所有者可以将其加入共享列表，使同一服务的所有已认证用户可读取标准化历史，包括后续新增用户。只有所有者可以追加版本、分享或取消分享；原件读取仍由所有者身份或显式的 `include_raw` 授权决定。发布状态存于独立的 `publications` 表，不改写快照内容。

`POST /v1/imports?shared=true` 在同一事务内完成导入与分享。默认 `shared=false` 保持私有导入兼容；重复导入可分享已有快照，不会复制记录，传 false 不会撤销已有分享。新版本不会自动继承分享。既有的按用户 `grants` 接口保留，取消公共分享不影响独立授权。

列表、详情、分页、内容分块和原件下载都在服务端检查权限。`GET /v1/contexts?shared_only=true` 仅返回每个 Context 最新已分享版本，即使所有者存在更新的私有版本，也不会混入共享列表。默认列表仍包含私有及显式授权的记录。不存在与无权限统一 404，无效 token 返回 401。取消分享阻止后续公共读取，已经下载的副本无法远程收回；已经开始的读取可能按其事务快照完成。

标准化记录也可能包含代码、命令输出及敏感文本。原件单独授权不等于标准化内容已脱敏；上传与分享前由用户选择合适资料。

## 接口

所有数据接口要求 `Authorization: Bearer ...`；`/healthz`、`/v1/schema`、`/docs`、`/openapi.json` 不含用户数据。实时定义以服务的 OpenAPI 为准。响应不缓存；CLI 拒绝携带 token 跟随 HTTP 重定向。

| 接口 | 作用 |
|---|---|
| `POST /v1/imports?provider=claude` | JSONL 原始请求体；可选 context_id、source_name、title、extensions、shared |
| `GET /v1/contexts` | 可见记录；shared_only=true 仅列共享记录 |
| `GET /v1/contexts/{c}` | 当前用户可见的最新版本及权限 |
| `GET /v1/contexts/{c}/revisions` | 可见版本列表 |
| `GET /v1/contexts/{c}/revisions/{r}` | 固定版本信息 |
| `GET …/{r}/turns` | 轮次 |
| `GET …/{r}/messages` | conversation / trace；可按 turn_id、tail_turns 过滤 |
| `GET …/{r}/messages/{m}/content` | 完整内容的 JSON 文本分块 |
| `GET …/{r}/diagnostics` | 解析诊断 |
| `GET …/{r}/raw` | 原始 JSONL，独立授权、校验 SHA-256 |
| `PUT / DELETE …/{r}/publication` | 分享到公共列表或取消分享，所有者操作 |
| `GET …/{r}/grants` | 所有者查看分享 |
| `PUT / DELETE …/{r}/grants/{user}` | 分享或撤销 |
| `GET /v1/me` | 当前身份 |

导入新版本返回 201，幂等复用返回 200。其他参数错误可能为 400 / 422，超限 413，媒体类型错误 415，存储忙或不可用返回 503。业务错误形如 `{"error":{"code":"...","detail":"..."}}`；框架参数校验使用 FastAPI 的 `detail` 结构。

分页输出 `{items,next_cursor}`；cursor 与资源/过滤条件绑定且不应解释或修改。除 limit 外，后续请求保持相同查询参数。固定版本页不受新导入影响；Context 列表按创建顺序翻页，新建项在重新列表时出现，共享/撤销可以改变可见项。

消息页每次最多 50 条；其他列表最多 100 条。单条内容超过 4,096 个 Unicode 码点时返回 `content=null`、明确截断标志及短预览；完整内容由 content 接口获取。块大小最多 16,384 码点，offset 以 Unicode 码点计数，按 `next_offset` 继续；拼接 `text` 后 JSON 解码得到原内容块数组。CLI `export` 自动拼接所有页与内容块，输出符合 Schema 的完整标准化文件。

`conversation` 展示非 meta 的 user/assistant 消息（可能包含 assistant 的工具调用块）；`trace` 包含所有消息、工具结果、系统/环境记录。两者均为读取视图，不改变存储历史。

## 版本演进

当前写入器仅写 `junction.context/1`；解析器升级允许同一原件生成新 Revision，不修改旧解释。破坏性核心结构变更使用新 schema_version；数据库迁移显式增加 user_version，未知版本拒绝启动。HTTP 兼容演进在 `/v1` 内增加能力，破坏性变更另开版本。

数据库版本 2 增加 publications 表；版本 3 增加 revision_overviews 表，保存自动整理的阅读说明。事务迁移不自动公开旧记录，不改写原件或原有标准化消息。旧版本重新导入时可补齐阅读说明，保留原版本 ID 与校验值。升级前制作完整备份。

后续按实际联调需要增加分组授权、派生关系及 Git 扩展，复用现有 Context / Revision / Grant 边界。云端部署再配置 TLS、反向代理上传限制、凭证分发和备份；当前实现不承诺公网生产运行所需的完整治理能力。

## Optional import extensions

`POST /v1/imports` accepts an optional `extensions` query parameter containing a strict JSON object (maximum 8192 characters when serialized with ASCII escaping). Keys should be namespaced and versioned, for example `switchyard.workspace/1`. Junction stores these values in the immutable normalized header without interpreting them as executable instructions or authority. Clients must validate extensions they use. Never place credentials in extensions.

The original JSONL bytes and checksum are unchanged. Re-importing the same raw snapshot with identical extensions is idempotent. Supplying different extensions for that already archived snapshot returns `409 extensions_conflict`; metadata is never silently overwritten. Omitting the parameter preserves the existing metadata on a duplicate import.

The CLI accepts `junction import ... --extensions-file metadata.json`. This allows a workspace adapter to carry repository identity, commit, dirty state and lineage while the Context schema stays independent of any worktree manager.

## 自动阅读说明

每次新导入自动保存一份 `junction.overview/1`，读取与导出时放入标准化记录的 `extensions`，接续 Agent 可以通过同一份 Context 查询它。它是独立保存的派生说明，不代替完整历史。

- `generator`：当前为 `extractive/1`，不额外调用模型。
- `title` / `title_source`：优先使用调用方已有任务标题，否则摘录首条用户文本；无可用文本时给出 Agent 名称占位标题。
- `description` / `evidence`：摘录首条用户、最近用户和最近助手文本，保留消息 ID、原始行号、截断标记。每条摘录最多 360 字符；完整内容仍保存在 messages 中。
- `missing`：没有记录的会话 ID、工作目录、用户/助手文本和消息时间等，不推测补全。
- `diagnostic_counts` / `resource_availability`：解析问题和附件可用性计数，详细数据仍在 diagnostics 与 messages 中。

阅读说明不把“最近助手声称完成”当成已核验事实。当前代码状态、目标与下一步仍由接续 Agent 结合原文和实际环境判断。
