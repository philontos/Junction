# Junction v1：存储与交换契约

状态：随 v0.2.0 实现，兼容已有 v1 存档，面向单节点、本地联调。研究目录中的候选协议不构成本版本的实现承诺。

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

v0.2 起，工具参数原本是字符串时另存 `arguments_text`，避免 JSON 数值和转义形式在解析后无法回查。`marker(name=message_metadata)` 保存日志实际出现的模型、usage、结束原因、channel / phase 等字段，`output.line` 指向原始行，`output.fields` 保留原字段名和值，不统一推测各厂商的 token 口径。它放在可分页、可分块的 content 中，不塞入无限增长的消息头。Claude 已识别的辅助记录与 Codex 生命周期记录也作为 meta 标记保留。

消息记录原始行号（从 1 开始）、原生 envelope/message/parent/turn/session ID；原始文件名在 Revision 上。Junction 的消息与轮次 ID 只在该 Revision 内唯一。时间戳是日志提供的字符串，不用它重排历史；顺序按原文件记录。无原生轮次时，按非 meta 用户输入推导，并标记 `inferred`。

Claude 同一 API message ID 的分块不能直接合并；只有原生 ID、内容、关联信息和原生记录字段一致时，才合并重复记录的来源行号。Codex 展示事件仅在显式同一 session / turn、内容吻合、已有 ID 与元信息不冲突且候选唯一时与主记录配对；多个候选保留并提示，不按全局相同文本去重。`source.native_role` 保留来源角色，避免 Claude 的 user 工具结果转成 tool 后失去原角色。

### 原生记录索引

标准化导出新增可选的 `record_index` 和 `records[]`，与 `session.messages` 分开：原生事件不必都是对话消息。消息用 `source.record_ids` 引用记录；一条消息可关联多个展示记录，每条记录也保存反向 `message_ids`。原生 ID 和 parent ID 仍保留在 source 中；这些索引不替代原生父子关系。

- `id=r<物理行号>`、`sequence`、`line`：ID 在 Revision 内有效，行号从 1 开始。
- `byte_offset` / `byte_length` / `sha256`：相对于完整原件的字节区间及校验值，包含该行原有 BOM、CRLF / LF；末行可以没有换行。空白行不建记录，但仍在原件中。
- `native_type`：来源 type 或 role 的标识；不以它推断可执行行为。
- `status=projected/unmapped/invalid`：是否关联标准化消息、未映射、或无法按严格 JSON 对象读取。`projected` 仅表示建立了阅读投影，**不表示每个原生字段都已标准化**。
- `record_index.complete`：是否索引了所有非空记录；超过 100,000 条时为 false，未索引尾部仍完整留在原件。旧版本没有该字段不等于记录已丢失。

索引可按普通 Context 权限查询；原字段和字节通过原件权限读取。`GET …/records/{id}/content` 返回 base64 字节块，`offset_unit=byte`，按 `next_offset` 拼接解码后的字节即可得到原行，包括未知字段、重复 JSON 键或无效 UTF-8。该接口与 `/raw` 使用同一权限和校验规则，不能绕过独立原件授权。`records` 不是原件副本，不可独立还原完整 JSONL。

附件保留路径/URL 和可用性。服务不读取日志中的本机路径、不下载 URL、不复制环境。内嵌图片本版保存在原件，标准化记录标记 `raw_only`；接收者需要原件授权才能取得这些字节。未识别的 provider 字段仍在原件中，不声称无损转换成统一结构。

`extensions` 支持可选的、带版本命名空间的对象，例如 `switchyard.workspace/1`；默认空对象，不接受环境执行指令。`junction.overview/1` 由服务生成，导入方不能自行提供该命名空间。扩展不得改变核心字段的含义。仓库、分支、worktree 和权限控制由外部集成处理。

## 导入与持久性

- 只接受上传的 JSONL 字节，单份上限 32 MiB；前 100,000 条非空记录参与解析，超限部分留原件并产生诊断。JSON 嵌套超过 64 层视为无法解析的记录。
- 空文件拒绝。非空文件含坏行、截断尾行或未知记录时，原件仍归档，返回诊断和状态；不会伪造补全。
- 版本指纹 `snapshot_sha256` 覆盖 `provider + 原件 SHA-256 + parser_version + extensions`，对象键排序后计算。相同 Context 内的相同指纹复用已有 Revision；仅工作信息改变也形成新版本。文件改名不改变身份，空白字节变化会形成新快照。标题是 Context 属性，不纳入快照指纹。
- 可传 `source_key`（1–256 个字母、数字或 `._:/-`）表示稳定来源。它在当前所有者内唯一，新来源键创建并绑定自己的 Context，以后自动追加或复用版本；绑定与落库在同一事务中完成。Switchyard 使用 `switchyard:<node_id>:task:<task_id>`，不同任务或所有者不会因原件相同而合并。要绑定已有 Context，须同时传 `context_id`；它必须与已有绑定一致，否则返回 `409 source_conflict`。
- 不指定 `source_key` 或 `context_id` 时，完全相同的上传仍可返回原 Revision，否则创建 Context。**不会仅靠原生 session ID、标题或仓库自动归并**。各版本保存完整快照；不合并两份日志、不增量 tail。已有 Context 的标题不会被追加导入改写。相同旧快照再次分享不会生成新版本或提升它的序号。
- 原件以 SHA-256 独立寻址。多个版本甚至不同 Context 可以引用同一个不可变文件，读取权限仍按版本判断；实际 JSONL 字节改变才保存新原件。不会把持续增长的活动日志当成多个旧版本共用的可变文件。
- 原件先通过临时文件、文件 fsync、原子 rename 和目录 fsync 落盘，再在单个 SQLite 事务中提交 Revision、Turn、Message、Diagnostic。原件落盘后数据库提交失败，最多留下未引用归档；本版不自动清理它。
- 原生记录索引与上述标准化记录在同一事务落库。`junction check` 同时验证实际字节区间、物理行号、逐行校验值、覆盖计数及消息双向引用。
- SQLite 使用 WAL、外键、FULL 同步及写事务串行化；读取授权和对应数据在同一读事务内完成。数据目录应在本机文件系统上，服务单进程运行。
- 原件读取重新校验 SHA-256。`junction check` 检查 SQLite、外键、原件校验值与标准化结构/计数。`junction backup` 用 SQLite backup API 取得一致快照，复制其引用的不可变原件，再验证，最后写 `BACKUP_COMPLETE.json`。只有带完成标记的备份可用于恢复。

## 授权

用户由服务所在机器的管理员通过 CLI 创建；随机 bearer token 仅明文写入指定私有文件，数据库仅保存摘要。token 轮换使旧 token 无效。v0.1 的用户是隔离主体，尚无组织、分组、管理员 Web API 或公开匿名分享。

分享的最小单位是 **固定 Revision**。所有者可以将其加入共享列表，使同一服务的所有已认证用户可读取标准化历史，包括后续新增用户。只有所有者可以追加版本、分享或取消分享；原件读取仍由所有者身份或显式的 `include_raw` 授权决定。发布状态存于独立的 `publications` 表，不改写快照内容。

`POST /v1/imports?shared=true` 在同一事务内完成导入与分享。默认 `shared=false` 保持私有导入兼容；重复导入可分享已有快照，不会复制记录，传 false 不会撤销已有分享。新版本不会自动继承分享。既有的按用户 `grants` 接口保留，取消公共分享不影响独立授权。

列表、详情、分页、内容分块和原件下载都在服务端检查权限。`GET /v1/contexts?shared_only=true` 仅返回每个 Context 最新已分享版本，即使所有者存在更新的私有版本，也不会混入共享列表。默认列表仍包含私有及显式授权的记录。不存在与无权限统一 404，无效 token 返回 401。取消分享阻止后续公共读取，已经下载的副本无法远程收回；已经开始的读取可能按其事务快照完成。

标准化记录也可能包含代码、命令输出及敏感文本。原件单独授权不等于标准化内容已脱敏；上传与分享前由用户选择合适资料。

## 接口

所有数据接口要求 `Authorization: Bearer ...`；`/healthz`、`/v1/schema`、`/v1/schema/environment`、`/docs`、`/openapi.json` 不含用户数据。实时定义以服务的 OpenAPI 为准。响应不缓存；CLI 拒绝携带 token 跟随 HTTP 重定向。

| 接口 | 作用 |
|---|---|
| `POST /v1/imports?provider=claude` | JSONL 原始请求体；可选 context_id、source_key、source_name、title、extensions、shared |
| `GET /v1/providers` | 已安装适配器、原生格式与解析版本，不含用户数据 |
| `GET /v1/contexts` | 可见记录；shared_only=true 仅列共享记录 |
| `GET /v1/contexts/{c}` | 当前用户可见的最新版本及权限 |
| `GET /v1/contexts/{c}/revisions` | 可见版本列表；`shared_only=true` 仅含已共享版本，包含分页游标隔离 |
| `GET /v1/contexts/{c}/revisions/{r}` | 固定版本信息 |
| `GET …/{r}/turns` | 轮次 |
| `GET …/{r}/messages` | conversation / trace；可按 turn_id、tail_turns 过滤 |
| `GET …/{r}/messages/{m}/content` | 完整内容的 JSON 文本分块 |
| `GET …/{r}/diagnostics` | 解析诊断 |
| `GET …/{r}/records` | 分页原生记录索引，不返回原字段值 |
| `GET …/{r}/records/{id}/content` | 原始行的 base64 字节块，独立原件授权 |
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

v0.2 的存档读取器保留同一主版本的未知新增字段，不静默删除；未知协议主版本仍拒绝。API 写请求继续严格校验。新增字段不得改变现有含义，Agent 专有语义优先通过原生记录和命名空间扩展表达。旧 v0.1 CLI 使用封闭字段校验，读取新投影前需升级；当前 CLI 和 Switchyard 同时支持有 / 无记录索引的快照。

`provider` 是开放格式标识（如 claude / codex），不等于模型厂商；实际导入能力由注册的适配器决定。未安装适配器明确拒绝，不能默认按 Codex 解析。`parser_version` 组合投影版本和对应适配器版本，两者任一改变都会产生新解释身份，避免升级一个适配器时误复用旧结果。详见[适配器契约](adapter-contract.md)。

数据库版本 2 增加 publications 表；版本 3 增加 revision_overviews 表，保存自动整理的阅读说明。事务迁移不自动公开旧记录，不改写原件或原有标准化消息。旧版本重新导入时可补齐阅读说明，保留原版本 ID 与校验值。升级前制作完整备份。

数据库版本 4 增加版本指纹和来源绑定，调整版本唯一约束以允许不同工作信息引用同一原件。迁移保留全部 Context / Revision ID、序号、权限与原文，校验外键后提交。旧 Switchyard 记录有唯一、明确的节点和任务来源时自动绑定；多个历史 Context 声称同一来源时不猜测合并。新的标准导入能力只依赖通用 `source_key`，旧扩展识别仅用于迁移兼容。

数据库版本 5 只新增 records 索引表。迁移不重新解释旧 JSONL、不补写旧消息、不改变分享；旧快照导出也不凭空补入新字段。以后重新导入同一 source_key / context_id 时，新解释生成新 Revision，原件继续按 SHA-256 复用。

后续按实际联调需要增加分组授权、派生关系及 Git 扩展，复用现有 Context / Revision / Grant 边界。云端部署再配置 TLS、反向代理上传限制、凭证分发和备份；当前实现不承诺公网生产运行所需的完整治理能力。

## Optional import extensions

`POST /v1/imports` accepts an optional `extensions` query parameter containing a strict JSON object (maximum 8192 characters when serialized with ASCII escaping). Keys should be namespaced and versioned, for example `switchyard.workspace/1`. Junction stores these values in the immutable normalized header without interpreting them as executable instructions or authority. Clients must validate extensions they use. Never place credentials in extensions.

The original JSONL bytes and checksum are unchanged. Re-importing the same raw snapshot with identical extensions is idempotent. Within a Context, different extensions produce a new immutable revision referencing the same raw archive; older metadata is never overwritten. Omitting the parameter preserves existing metadata when a matching raw snapshot is found. For automatic version grouping, supply the same source_key, or explicitly supply context_id.

The CLI accepts `junction import ... --source-key tool:task:123 --extensions-file metadata.json`. This allows a workspace adapter to carry repository identity, commit, dirty state and lineage while the Context schema stays independent of any worktree manager.

## 自动阅读说明

每次新导入自动保存一份 `junction.overview/1`，读取与导出时放入标准化记录的 `extensions`，接续 Agent 可以通过同一份 Context 查询它。它是独立保存的派生说明，不代替完整历史。

- `generator`：当前为 `extractive/2`，本地提取，不额外调用模型。
- `title` / `title_source`：保留有意义的已有标题；“测试”等占位标题改用首条有效需求生成短标题。跳过寒暄、环境注入、skill 正文等。无可用需求时保留原标题或使用 Agent 名称占位。
- `summary` / `summary_evidence`：最多 160 字符的任务需求摘录，结合首次有效需求与最近补充，保留对应消息 ID 和行号。缺少有效需求时为空，不根据助手回复推断完成状态。
- `description` / `evidence`：摘录首条用户、最近用户和最近助手文本，保留消息 ID、原始行号、截断标记。每条摘录最多 360 字符；完整内容仍保存在 messages 中。
- `missing`：没有记录的会话 ID、工作目录、用户/助手文本和消息时间等，不推测补全。
- `diagnostic_counts` / `resource_availability`：解析问题和附件可用性计数，详细数据仍在 diagnostics 与 messages 中。

阅读说明不把“最近助手声称完成”当成已核验事实。当前代码状态、目标与下一步仍由接续 Agent 结合原文和实际环境判断。

旧数据可运行 `junction refresh-overviews --data-dir .local/data` 补齐标题和摘要。该命令仅更新派生说明，不改写原始 JSONL、标准化消息、Context 身份或版本校验值；重复执行跳过当前生成器版本。升级前可用 `junction backup` 保留旧说明。

## Optional environment manifest

`extensions["junction.environment/1"]` records observations from the executing device, separately from conversation history. Junction validates its envelope and retains the exact supplied JSON values in the immutable revision. Schema: [environment-v1.schema.json](../schemas/environment-v1.schema.json), also available at `GET /v1/schema/environment`. No database migration is needed.

- `captured_at`, `collector` and `scope` identify observation time, collector version and scope. Historical evidence has its own `observed_at`; absent/unknown historical time must not inherit capture time.
- Each group has `coverage`: `not_collected`, `partial`, `collected` or `not_applicable`. Omitted groups mean not collected. Group item IDs are unique within the group.
- Each item separates `observed` (`present`, `missing`, `unknown`, value and source) from optional `requirement` (`required`, `optional`, `unknown`; omitted means unknown). Observed software is not automatically a task requirement.
- Unknown categories and additive fields survive round trips. Incompatible extensions use another versioned key. Old contexts without the extension remain valid.
- The extension is descriptive data, not credentials, executable commands, or inherited permission rules. Junction does not probe source devices or attest to the truth of client-supplied observations.
- Receiving-device checks belong in a separate local report tied to context/revision, receiving directory and check time. They do not mutate the source manifest.

The existing 8192-character extensions budget and raw archive deduplication still apply. A client fixes capture results before retries so a newly generated timestamp does not create duplicate revisions. A changed manifest produces a new revision, which can reference the same original JSONL. Configure a reverse proxy to accept the existing import API's encoded metadata query (16 KiB request-line/header capacity is recommended), as well as the 32 MiB body limit.
