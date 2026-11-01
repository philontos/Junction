# Codex Claude Code 与 Pi 的原生 Context 存储和恢复

研究日期：2026-10-31；2026-11-01 补充原生完整性、Pi 与 fork 实现。本文是[主报告](README.md)的证据附录。

原生 JSONL 通常保存详细会话历史，能够直接作为持久化原件；它不自动保证包含全部历史、所有依赖或精确模型请求。最新结论及官方能力复用见[第 9 节](#9-原生完整性与生命周期复核)，先于通用层设计。

本文的“Context”不指模型服务内部的 KV cache 或不可观察的推理状态。研究对象是我们可以合法读取和保存的会话记录、工具证据、运行元数据、持久记忆，以及由这些材料重建的有效输入。磁盘 transcript 也不自动等于模型每一步实际收到的完整 request。

## 1. 版本与观察范围

| 对象 | 本次基线 | 证据性质 |
|---|---|---|
| 本机 Codex CLI | `0.157.1` | 实际执行版本命令；读取原生结构；从该二进制生成 App Server TypeScript schema |
| Codex 源码 | `rust-v0.157.1` / `36650394c5b38c2990ccf2a3457165ca3e9d9726` | 以匹配本机版本的提交审阅，不把 main 分支新功能套用到本机 |
| 本机 Claude CLI | `2.1.203` | 实际版本命令；有限 transcript 结构抽样 |
| Claude transcript 样本 | 包括 `2.1.202`、`2.1.201`、`2.1.185` | 文件中的版本；与当前安装版本不同很正常 |
| Claude Agent SDK Python | `0.2.176` / `2146f9d8985513053e904b13200c8f744b36785a` | 官方开源 SDK；该提交 changelog 的 bundled CLI 是 `2.1.316` |
| Pi coding agent | `1.4.0` / `babe30a7e6c185346c85859da30b58183e5964f0`，会话格式 v3 | 官方格式文档、SessionManager、请求投影与跨模型转换源码；合成纯函数验证，未检查本机真实 Pi 会话 |

没有从 Claude 闭源 CLI 反编译内部实现；SDK 的读取与镜像实现、官方文档和本机实际记录是主要依据。SDK 新接口不能仅凭本机 CLI 版本推定可用，正式接入应固定 SDK/CLI 组合再验证。[SDK changelog](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/CHANGELOG.md)。

本机 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`XDG_CONFIG_HOME` 未设置，以下是该环境默认位置。所有采集器都应允许配置来源路径，不能把这一观察写死为唯一位置。SQLite 观察用于结构与有限统计，不声称是在活跃写入环境下取得了完整、一致的灾备快照。[结构观察记录](evidence/local-observations.json)。

## 2. Claude Code 的磁盘材料

观察到的典型布局，可概括为：

```text
~/.claude/
  history.jsonl                         # 命令/输入历史，不是完整会话
  projects/<encoded-project>/
    <session-id>.jsonl                  # 原生会话记录
    <session-id>/subagents/
      agent-<id>.jsonl                  # 子 Agent 流
      ... sidecar files
    memory/                            # 某些项目的持久记忆文件
  ... file-history and other state
```

这是一组材料，不是一个可直接复制就保证全部能力恢复的单文件。官方 session 文档也区分会话历史与实际文件系统；恢复对话不自动恢复工作目录内容。[Claude sessions](https://code.claude.com/docs/en/sessions)。

### 2.1 JSONL 记录的两层身份

本机记录中可见的 envelope 字段包括：`type`、`uuid`、`parentUuid`、`isSidechain`、`sessionId`、`timestamp`、`version`、`cwd`、`gitBranch`。其内 `message` 又有 Anthropic 消息与 content blocks。两个层次的 ID 不能混同。

常见 content blocks：

| 块 | 结构含义 | 归一时应保留 |
|---|---|---|
| `text` | 消息文本 | 文本及原角色/作者 |
| `thinking` | 原生记录暴露的推理相关内容，可能含 signature | 不透明原生字段及可公开的文本范围；不推断未记录内容 |
| `tool_use` | `id`、`name`、`input` | 调用 ID、原工具名、原参数 |
| `tool_result` | `tool_use_id`、`content`、`is_error` | 与调用的关联、结果、错误状态 |
| 其他多模态/新增块 | 随版本演进 | 原始结构、附件引用、解析状态 |

不要把 user envelope 一律解释为“用户亲手输入”：工具结果、系统注入材料和用户实际输入可能以不同形式进入消息记录。资产层需要标明来源语义，展示层可以另行筛选。

抽样还出现 `system`、`attachment`、`file-history-snapshot`、`last-prompt`、`mode`、`permission-mode`、`bridge-session`、`ai-title`、`pr-link`、`queue-operation` 等顶层类型。它们是否影响恢复、审计或 UI，要由适配器判断；一开始只保留 user/assistant 会让以后无法重新解析。[本地观察](evidence/local-observations.json)。

### 2.2 有效分支不能用文件顺序代替

官方 SDK 的 `_build_conversation_chain` 会建立 UUID 索引，选择主链的末端记录，沿 `parentUuid` 回溯。当前实现特意不沿 `logicalParentUuid` 重新纳入压缩前全文，因为压缩摘要已经承担了有效对话中的替代作用。[读取实现](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/sessions.py)。

进一步的细节是并行工具调用：同一次 API assistant message 可能拆成多个 transcript entry，并共享 `message.id`；只沿 parent 指针走，会漏掉一些 sibling 工具结果。SDK 的 `_recover_orphaned_parallel_tool_results` 专门恢复这种关系。因此“我支持 parentUuid”还不足以证明正确重建了会话。

不同消费者也可能需要不同视图：SDK 展示当前有效会话；历史分析器可能希望沿压缩前逻辑关系查看全部证据。二者不能用一个名为 `messages` 的无版本输出含糊代替。原始档案应能支持两种投影。

### 2.3 SessionStore 是重要的官方接入点

官方 SDK 已提供外部 session storage。核心接口是 `append` / `load`；`SessionKey` 包含 project、session、可选 subpath，子 Agent 可分开存储。CLI 仍先写本地 transcript，外部 store 接收镜像副本，而不是接管所有原生写入。[官方说明](https://code.claude.com/docs/en/agent-sdk/session-storage)、[接口契约](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/types.py)。

对我们的关键启示：

- 原生 entry 按 opaque JSON 处理，未知字段要透传；不能在 store 中先转成自定义消息模型再期待完整恢复。
- `load` 要返回 deep-equal JSON，契约不要求原始序列化字节相同。
- 单进程内保留 append 顺序；并发写入、重试和去重仍需实现者按契约处理。带 UUID 和不带 UUID 的记录不能用同一个简单去重规则。
- mirror 失败可能形成采集缺口，必须被记录和补采；“会话成功运行”不证明远端镜像完整。
- `list_subkeys` 等能力关系到是否能取回子流。只保存主 session 不应标记整个 session tree 完整。

SDK 还提供从已有本地 JSONL 导入 store 的实现，处理主会话、子 Agent 以及部分 metadata sidecar；这可以作为历史补采路径参考。它与读取用户可见消息的 API 是不同层。[原生导入](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/session_import.py)、[store conformance](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/testing/session_store_conformance.py)。

接入建议是两条来源并存：受我们启动管理的 SDK 会话可研究官方镜像；用户直接运行 CLI 的历史则用只读文件采集器。两种来源必须保留来源身份、覆盖范围和重复检测依据，不能假定已自然对齐。

## 3. Codex 的磁盘材料

本机观察到：

```text
~/.codex/
  sessions/.../rollout-*.jsonl
  archived_sessions/...
  state_5.sqlite
  thread_history_1.sqlite
  memories_1.sqlite
  history.jsonl
  session_index.jsonl
```

不同文件承担不同责任。`history.jsonl` 的输入历史不是 transcript，`session_index.jsonl` 也不能作为全部历史来源。

### 3.1 SQLite 与 rollout 并存

本次查看的 `state_5.sqlite` 中，310 条 thread 的 `history_mode` 分布为 309 paginated、1 legacy；对应 rollout 路径均存在。它只证明本次查看范围内的事实，不代表所有版本、所有设备或所有归档状态。

| 文件/表 | 本次看到的关键结构 | 用途判断 |
|---|---|---|
| `state_5.sqlite / threads` | thread ID、rollout path、cwd、Git、CLI 版本、source、history mode 等 | 发现、定位和元数据；本机比仅按 cwd 扫最新文件更精确 |
| `thread_spawn_edges` 等 | 父子 thread、动态工具、附件相关表 | session tree / 运行关联不能只由聊天文本恢复 |
| `thread_history_1.sqlite / thread_items` | thread/turn/item、`item_json`、类型、rollout ordinal、更新时间位置 | 规范化历史项目的物化表示 |
| `thread_turns` | 状态、开始/结束、字节位置、root turn | turn 边界与分页查询 |
| `thread_history_projection_state` | 下一字节位置、下一 ordinal | 投影同步进度；投影可能与原始流存在时序差 |
| `memories_1.sqlite` | `stage1_outputs`、jobs、consolidation progress 等 | 记忆流程的另一个状态域；表存在不代表当前用户启用了相关功能 |

不应把这些内部表名定为跨 Agent 协议。适配器可以利用它们，但需要版本检测，也不能对活跃数据库直接做忽略 WAL 的文件复制并宣称一致备份。[本地结构证据](evidence/local-observations.json)。

### 3.2 Rollout 不是单一 messages 流

固定版本的 `RolloutItem` 包括 `SessionMeta`、`ResponseItem`、`Compacted`、`TurnContext`、`EventMsg`，以及 world state、retained context、token usage、inter-agent communication 等记录类别。`RolloutLine` 除 timestamp 外还有可选 ordinal。[官方类型](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/history/src/lib.rs)。

本机相关结构可概括为：

- `session_meta`：thread/session 身份、history mode、来源、版本、cwd、Git、base instructions 等。
- `turn_context`：模型/推理配置、turn/root turn、workspace roots、权限和 sandbox/approval 等运行材料。
- `response_item`：模型消息、function/custom tool 调用及返回、reasoning 等原生输入输出表示。
- `event_msg`：turn 生命周期、rollback、item 完成等事件；不能一概认为只是上一类的冗余复制。
- `compacted`：压缩消息和可选替代历史、保留上下文、window 信息及 resume metadata 等。

这些层可能重复描述同一动作，也可能分别保有不同信息。统一投影既要避免重复计数，也要避免把非重复的信息删掉。

### 3.3 Legacy / paginated 是实际兼容性边界

持久化 policy 根据 history mode 决定写入哪些事件。Legacy 的 user/agent message 事件与 paginated 的 `ItemCompleted` 并不能套同一规则；一些瞬时事件也不会按原样全部持久化。[持久化策略](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/rollout/src/policy.rs)。

本机 paginated 记录出现 `event_msg.payload.item.type = UserMessage`；数据库/App Server 风格的 item 则可见 `userMessage`、`agentMessage`、`commandExecution` 等名称。大小写和 envelope 不同并非可以凭猜测互换的格式。

所以适配器至少要显式区分：原始 rollout、旧事件流、新规范化 item、App Server API 输出。第三方库声称“支持 Codex”时，还要问其覆盖哪个版本、哪个读取面。[合成探针](evidence/asp-probes.json)展示了只读 response_item 的 normalizer 遇到单个新式 user item 时返回空结果的情况；这是事件覆盖探针，并非完整原生文件验证。

### 3.4 压缩和回退需要状态化重建

固定版本 `CompactedItem` 包含 `replacement_history`，还可能涉及 retained context、多个 window 和恢复元数据。官方 `rollout_reconstruction` 针对 rollback、compaction、world state 等有状态地重建历史。[压缩数据结构](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/history/src/lib.rs)、[重建算法](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/session/rollout_reconstruction.rs)。

不正确的快捷方式包括：保留所有文本忽略 rollback；从最后一条 compacted 后截取却丢失 replacement history；以最后一条消息的 cwd 推断整个会话环境；将 reasoning 的 encrypted payload 当跨 provider 可解释文本。

我们无需第一期把完整 Codex runtime 重写一遍。应明确承诺：原生记录可归档；部分语义可标准化；有效历史由特定版本 adapter 或官方 API 构造；不能正确处理的边界返回不支持或部分覆盖，而不是伪造 exact resume。

### 3.5 App Server 是结构化读取入口，但要固定版本

从本机 0.157.1 二进制生成的 schema 显示：

| 接口/类型 | 观察 |
|---|---|
| Thread | `id`、`sessionId`、`forkedFromId`、`historyMode`、cwd；path 有不稳定性标记 |
| ThreadRead | `includeTurns` 已有 deprecated 标记 |
| ThreadTurnsList | cursor、limit、sort direction、items view |
| ThreadItemsList | 指定 thread/turn 的分页 item |
| ExternalAgentConfigDetect | 可检测包括 sessions / memory 在内的外部 Agent 迁移项 |
| Session import | 有异步导入 ID 和后续通知，不是同步拷贝一个文件即完成 |

研究期间线上文档与本机生成 schema 已出现 cursor 表示差异。因此客户端应以目标二进制生成的契约及能力协商为依据，不能同时混用“最新版网页示例”和旧运行时。[App Server 官方入口](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server/README.md)。

API 优先用于查询和恢复控制，原生 capture 用于保留证据；这两个入口的记录应有映射，而非简单将两个流直接拼接。这里尚未验证一套完整的双入口去重方案。

## 4. Codex 官方 Claude 导入：有价值，但有明确损失

匹配本机的源码已包含 external-agent-migration session importer。对 Claude JSONL 的读取主要提取 user/assistant，过滤 isMeta/isSidechain，将内容转换成 `ConversationMessage { role, text, timestamp }`，并计算源内容 hash。[Claude 读取器](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/external-agent-migration/src/sessions/records_cla.rs)。

转换规则包括：

- text 保留为文本。
- tool_use / tool_result 生成带标记的文本说明；相关文本有 2,000 / 4,000 的截断上限。
- thinking 跳过；其他 block 变成 unsupported 类型提示。
- 只有 tool_result 的原 user 记录可被映射为 assistant 文本。
- 随后生成新的 turn ID、文本 response item 和导入标记；部分 token 信息由字节数估算，不能据此还原来源模型的真实 usage。

证据：[内容提取](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/external-agent-migration/src/sessions/records_common.rs)、[生成导入历史](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/external-agent-migration/src/sessions/export.rs)。

它值得作为“官方支持的继续工作方式”纳入实验；但按上述源码不能叫作跨 Agent 无损归档。源文件 hash 也只证明参与处理的原始输入是什么，不代表输出保留了输入全部语义。本次没有对真实会话执行导入。

## 5. 哪些信息可以共享，哪些只能保存或描述

| 信息 | 跨 Agent 的候选处理 | 保真边界 |
|---|---|---|
| 用户目标、明确约束、决策 | 带来源的文本/结构化事实 | 不能由摘要擅自增加或删除约束 |
| 工具调用与结果 | 保留原始调用、结果和证据；可派生通用 tool observation | 原工具可执行性、权限、错误语义不保证等价 |
| 图片/文件/patch | 独立 artifact，hash、类型、大小及可访问状态 | 路径字符串不是内容；Git commit 不包含未提交文件 |
| 历史分支、rollback、compaction | 原始事件 + 明确有效 view | 一条通用 summary 不能代替原生恢复算法 |
| thinking signature / encrypted reasoning | 作为 provider-specific opaque 数据按策略保存 | 不保证跨模型使用，也不推断其中不可见内容 |
| system/developer 等历史指令 | 保存来源角色和当时语境；接收方视作历史材料 | 不自动变成新的高优先级指令或权限 |
| cwd、worktree、进程、工具配置 | 环境描述/证据，Run 再绑定实际环境 | 不能靠复制 transcript 恢复运行中进程或文件系统 |
| 长期记忆 | 保留原始 memory 文件/记录与派生来源 | 自动记忆可能含错误、过期或用户修订内容 |

由此应分开对外承诺三种动作：

1. **Native restore**：在受支持的同 provider/版本/环境条件下恢复。
2. **History import**：将可转换历史交给另一个 Agent，出具损失报告。
3. **Task handoff**：给另一个 Agent 一个经过选择、带证据的工作状态包。

三者可以共享资产底座，但不能使用同一个“Resume 成功”状态来掩盖差异。

## 6. 采集层需要处理的工程边界

这些是由上述存储结构推导的建议，尚未实现：

- 活跃 JSONL 可能有未写完的末行；只确认完整记录，保留 byte cursor 与文件身份，遇到 truncate/replace 时识别新 generation。
- 重试采集需要幂等；不能仅靠 timestamp 或文本 hash 去重，否则重复发生的相同行为会被误删。
- 主流、子流、sidecar、附件各有覆盖范围；未发现附件不代表不存在附件。
- 原生顺序、采集顺序、实际发生时间各自记录；多设备合并不能只按时钟排序推断因果。
- SQLite 与 JSONL 一致性需要支持的 API、正确快照或高水位对照；文件存在性不代表投影已追平。
- 分享选择作用于发布视图及其依赖闭包，不能为了“补全”而向接收方自动展开整个私有源 session。

## 7. 与宿主应用的接入边界

独立 Context 模块与现有 Agent 管理应用接入时，需要分清以下职责：

- 展示层可以截断工具输出或过滤事件，但这种视图不能作为唯一原始档案。
- 会话采集绑定明确的 provider session、来源实例和采集边界，不能只依赖 cwd 或“最近会话”。
- 官方 hook 和 SDK 提供的 session ID、transcript path 等信息，可以作为会话定位入口。
- 多租户共享需要独立的身份、授权和发布边界，不能继承单用户宿主的信任假设。
- Context 不负责 Worktree 生命周期；宿主应用在启动运行时关联上下文与环境。

这些是接入边界，不要求将某个宿主应用或其代码并入本仓库。

## 8. 尚未验证的内容

- 所有 Claude/Codex 历史版本的完整兼容范围，以及 macOS 以外的真实路径/运行行为。
- Claude SessionStore 在所选 SDK/CLI 组合下的断线恢复、跨进程写入及全子流回放。
- Codex App Server、原始 rollout 和 SQLite 投影在长会话、分页、压缩、回退后的完整对照。
- 任一第三方转换器的完整原生导入与继续执行成功率。
- 带附件、子 Agent、长期 memory、未提交文件的跨机器恢复。
- 多租户服务的实际隔离、撤销、索引失效、端到端加密与性能。

这些项目是下一阶段实验的边界。原生归档与转换应分开验证，暂不据此冻结统一内容协议。

## 9. 原生完整性与生命周期复核

### 9.1 原生文件是否保存了完整 Context

**通常不是只有摘要，而是供官方恢复使用的详细会话档案。可以原样持久化，但不能用一个“完整”覆盖下列四种不同含义。**

| 要确认的内容 | 复核结论 |
|---|---|
| 用户、助手、工具调用与结果的历史 | 三家均有原生结构承载；实际保留范围受版本、清理、截断、采集时点影响 |
| 下一轮模型应读的有效历史 | 从档案按分支、压缩、回退等规则重建，不等于逐行拼接 |
| 每次发给模型的精确请求 | 不能普遍保证；提示词、工具声明、扩展投影和运行配置可能在读取后生成或修改 |
| 当时的运行环境 | JSONL 不等于仓库、Worktree、进程、MCP 服务和附件文件的完整快照 |

六份本地样本中，Codex 的一份 0.157.1 档案有 994 行、3 个 `compacted` 记录；压缩前的原记录仍在文件中。Claude 的一份 2.1.185 档案有 521 行，包含 85 次工具调用及对应结果。这足以排除“它们通常只是最终摘要”的理解，但不是所有会话完整性的证明。活跃会话中尚无结果的调用也不能直接判为损坏。[脱敏结构统计](evidence/local-session-samples.json)。

压缩首先改变模型输入选择。例如一条历史包含旧消息、保留消息、压缩记录、新消息；恢复时通常使用压缩摘要、保留消息和新消息，旧消息未必再次送给模型。Codex 的 `replacement_history` 和 Pi 的 compaction checkpoint 把这一点直接写进存储结构。[Codex 重建](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/session/rollout_reconstruction.rs)、[Pi SessionManager](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/src/core/session-manager.ts)。

**可恢复不等于原历史全部仍在。** Claude 当前官方文档有一个明确反例：v2.1.287 起，在 `-p` / SDK 会话启用 `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` 后，文件超过 5 MB 时可在压缩后清掉此前历史；v2.1.296 起增加最少缩小 10% 的条件。官方说明清理不改变恢复出的会话。该行为不适用于本机较旧 CLI，却直接约束长期归档策略：若要保存被清掉的历史，需要事先采集。[官方环境变量](https://code.claude.com/docs/en/env-vars#variables)。

原生存储也不是永久仓库。Claude 的会话保留时间、禁用持久化选项及清理行为可配置；文件存在只表示此刻能读到它。做长期资产需要自己的保留机制，不能依赖 CLI 永不清理。[会话存储与保留](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)。

### 9.2 Codex 原件的逻辑模块

0.157.1 的 rollout 可以分为：

| 模块 | 原生承载 | 保存的内容 |
|---|---|---|
| 会话身份与来源 | `session_meta` | session ID、版本、来源、cwd、基础指令，以及适用时的 fork / history-base 信息 |
| 模型交互记录 | `response_item` | message、reasoning、function/custom tool 调用和结果、compaction 等 |
| 执行与展示记录 | `event_msg` | turn 生命周期、完成的命令/文件修改/消息等；和模型交互记录可能描述同一行为的不同侧面 |
| 运行上下文 | `turn_context`、`world_state` | 模型与思考设置、权限和环境、指令/工具等状态；部分值只是引用或摘要 |
| 上下文选择 | `compacted`、retained context、rollback 等 | replacement history、保留材料、压缩窗口、恢复信息和回退控制 |
| 使用量 | token usage 记录 | 使用量和上下文统计，不能当作消息正文 |

这些是按代码职责划分的模块，不是建议的新 schema。[原生类型](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/history/src/lib.rs)。

本地样本确实包含基础指令、逐轮上下文及工具内容；但源码有明确的持久化筛选。0.157.1 的 policy 不保存 `AdditionalTools` response item 和部分瞬时事件，而本地 0.165.0 / 0.166.0 档案已出现 `additional_tools`。因此既不能说“工具定义永远不存”，也不能用新版样本反推旧版记录完整。[持久化策略](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/rollout/src/policy.rs)、[样本统计](evidence/local-session-samples.json)。

恢复由官方历史重建代码选择仍有效的压缩 checkpoint，并处理 rollback 和后续记录。`event_msg` 与 `response_item` 不能当两套独立对话重复灌入；`compacted.message` 为空也不代表没有压缩状态，实际内容可能在 `replacement_history` 中。[历史重建实现](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/session/rollout_reconstruction.rs)。

### 9.3 Claude Code 原件与官方存储入口

其 transcript 的逻辑模块包括：带 `uuid / parentUuid` 的消息图；消息内 text / tool_use / tool_result / thinking 内容块；压缩边界及关联；attachment 中的注入材料；模型、权限、标题等会话元数据；file-history 备份引用。子 Agent 的完整记录可位于独立文件，不能只由主会话里的最终汇报替代。[SDK 读取](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/sessions.py)、[原生导入及子流](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/session_import.py)。

提示词记录必须按版本判断。此前三份旧版本样本未发现独立的完整 system prompt 快照，不能据此断言 Claude 永远不存。当前官方文档明确：默认在首次请求构造并记录 system prompt，恢复时继续使用，直到压缩；bare mode、关闭快照和旧版 feature flag 行为有例外。**存了名为 `system` 的事件，也不自动代表存了完整 system prompt。** [官方提示词恢复规则](https://code.claude.com/docs/en/cli-reference#system-prompt-flags-in-resumed-conversations)。

最直接可复用的持久化能力是 **SessionStore**：保留 opaque 原生 JSON entries 与顺序，使用 `append / load`；已有本地档案可用官方 `import_session_to_store` 补入，子流通过 subkey 管理。恢复时 SDK 将 store 内容物化为临时 `CLAUDE_CONFIG_DIR` 中的原生目录和文件，再交给 CLI。这正是“自己存原件，让官方负责恢复”的实现路径，不要求先做统一消息协议。[SessionStore 契约](https://code.claude.com/docs/en/agent-sdk/session-storage)、[恢复实现](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/session_resume.py)。

此入口承诺的是原生记录内容等价，不是每个 JSONL 字节、文件备份与外部服务都已存入。适配器仍需固定 SDK/CLI 组合，并验收镜像缺口、顺序、子流和跨机器恢复。

### 9.4 Pi 原件与有效上下文

Pi 1.4.0 的 v3 会话格式公开、分支关系明确，适合借鉴其分层：

| 模块 | 原生记录 |
|---|---|
| 会话头 | `session`：id、version、cwd、可选 parentSession |
| 历史树 | entry 的 `id / parentId`；一个文件可包含多条分支 |
| 对话与工具 | `message`：system、user、assistant、toolResult 等角色；助手消息记录 provider / api / model |
| 提示词和工具声明 | 初始 system message 的结构化 prompt sections 与工具声明；后续按 section 和 toolsAdded / toolsRemoved 更新 |
| 压缩与输入修订 | `compaction` 的 summary、firstKeptEntryId、systemMessage checkpoint；`context_edit` 改变输入投影 |
| 分支与扩展 | `branch_summary`、custom、custom_message、label、session_info、模型/思考设置和 usage |

`custom` 保存扩展状态，通常不进模型输入；`custom_message` 可以进入。`context_edit` 改变指定分支上的模型输入，不改原始消息。压缩追加记录，保留旧历史。`buildSessionContext` 按 leaf 路径、最新 compaction、保留区间和后续事件生成有效输入。[会话格式](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/docs/session-format.md)、[上下文投影实现](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/src/core/session-manager.ts)。

即使 Pi 记录了 prompt 与工具声明，也不保证记录每次请求的精确字节。`AgentSession` 的 forced system prompt 可以仅投影到请求而不记录该文本，隐藏工具声明也会在发送前过滤。工具的可执行实现仍来自当前 registry，而非 JSONL 中的声明。[请求投影与工具恢复](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/src/core/agent-session.ts)。

### 9.5 官方 fork 究竟复制什么

三者共同语义是：**在选定历史边界产生独立的后续路径，沿用已有历史及压缩状态，不重新从零执行过去的工具。** 它不等于 Git 分支或 Worktree 快照。物理实现却有明显区别。

| 能力 | 历史选择与存储方式 | 不应默认带入的内容 |
|---|---|---|
| Codex fork | 新 thread；有 copied 和 referenced 路径，后者通过 history_base 引用既有历史区间 | 不能假定子 thread 的一个 JSONL 自包含；不复制文件系统 |
| Claude SDK 离线 fork | 选择 transcript 前缀，可截止到指定 message，重新生成会话/消息 UUID 并修复关联 | 不复制 file-history undo 快照；sidechain 被排除，不自动复制子 Agent 文件 |
| Pi `/tree` | 同一 JSONL 内切换 leaf，之后的消息构成新分支；可加被离开分支的摘要 | 不是创建新的独立会话文件 |
| Pi `/fork`、`/clone` | 将所选路径复制到新文件，新 session header 记录 parentSession | 不包含源文件中的其他分支；不复制整个执行环境 |

**Codex 的引用式 fork 尤其影响归档。** `fork_prepared_thread` 传递 `ForkPersistence::Referenced`，记录历史来源及截止 ordinal / byte offset。官方 reader 递归沿 `session_meta.history_base` 解析祖先 rollout，检查缺失、循环和边界，再合并有界区间。某个子文件可恢复，不代表单独复制它到另一台机器也能恢复。[fork 入口](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/thread_manager.rs)、[历史引用解析](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/thread-store/src/local/rollout_lineage.rs)。

引用式 fork 也不是随意记录“当前文件大小”：准备过程先协调写入并确定持久化边界；指定 turn 的 fork 拒绝尚在进行中的目标。应优先复用 App Server `thread/fork` 等官方能力，并单独验证归档需要的依赖集合。[边界准备](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/thread-store/src/local/paginated_fork.rs)、[App Server](https://learn.chatgpt.com/docs/app-server)。

**Claude fork 不能简化成改文件名。** 官方 Python SDK 的 `_build_fork_lines` 重写 session/message UUID、parentUuid、压缩 logicalParentUuid，跳过 progress 链接；工具调用 ID 与结果内的关联保留。它还保留 isMeta，排除 sidechain，写入 forkedFrom；file-history-snapshot 不进入副本。store 版调用同一转换，因此简单对象存储 CopyObject 不等价于官方 fork。这里审阅的是开源 SDK helper，不冒充闭源 CLI 内部实现。[SDK fork 实现](https://github.com/anthropics/claude-agent-sdk-python/blob/2146f9d8985513053e904b13200c8f744b36785a/src/claude_agent_sdk/_internal/session_mutations.py)。

运行中的 SDK 会话另有 `resume + fork_session` 接口。该接口与离线 helper 都有官方用途，但是否完全相同的记录覆盖范围，仍须端到端对照。[官方 SDK 会话管理](https://code.claude.com/docs/en/agent-sdk/sessions)。

**Pi 明确区分树内分支和独立会话。** `/tree` 移动当前 leaf；`createBranchedSession` 抽取 root 到指定 leaf 的路径，创建新 session header、记录 parentSession，再处理 label 与压缩保留边界。这种“档案树与当前输入分别管理”的机制可直接参考，而不必先引入新的图协议。[会话操作](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/docs/sessions.md)、[分支实现](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/coding-agent/src/core/session-manager.ts)。

### 9.6 跨 Agent 转换应从原件出发

直接转换并非不可行，Codex 已有官方 Claude 导入。它选取用户/助手记录，将工具调用和结果变成文本说明，对这两类说明分别采用 2,000 / 4,000 的长度限制，跳过 thinking。它解决“接着了解和处理这个任务”，并不保全原始会话状态。源档案应保留，导入产物另存。[导入过滤](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/external-agent-migration/src/sessions/records_cla.rs)、[内容转换](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/external-agent-migration/src/sessions/records_common.rs)。

Pi 的跨 provider 转换更接近消息级复用：保留文本和工具结构，规范化成对的调用 ID；跨模型丢弃专属 thinking / signatures，同模型可保留；缺失工具结果会补合成错误结果。这是 **Pi 内切换模型供应商**，不能据此说它已经支持 Claude Code JSONL 直接恢复成 Codex。[转换实现](https://github.com/earendil-works/pi/blob/babe30a7e6c185346c85859da30b58183e5964f0/packages/ai/src/api/transform-messages.ts)。

因此当前可以明确的工作顺序只有四步：

1. 保存原生记录及恢复所需依赖，记录实际采集范围和来源版本。
2. 在同一工具、固定版本下，用官方能力验证恢复和 fork。
3. 使用官方导入或小型直接 adapter 验证 Claude、Codex、Pi 之间的转换，逐项记录损失。
4. 只有多个转换反复需要同一稳定结构时，再提炼薄的公共内容层；原件始终保留。

长期分析也不要求先把原件改写成统一格式。检索、统计、摘要或未来的统一模型都可以作为可重建的派生结果。这是由原生机制推导的取舍，尚未确定中间层字段或服务架构。

### 9.7 本轮验证结果与边界

对固定提交的官方纯函数运行了七个合成案例：Claude fork 三个，验证身份/关联修复、记录覆盖和包含截止点；Pi 四个，验证分支与压缩 checkpoint、分支内 context_edit、跨模型签名及工具 ID、缺失结果补齐。全部通过，输入原件未被修改。脚本检查源码 SHA-256 后加载原始函数，未安装 SDK 或调用模型。[结果及复现](evidence/README.md#官方原生函数探针)。

Codex fork 为固定源码审阅；未运行整个 Codex fork/compaction 集成测试。Pi 没有本机真实会话样本；Claude 运行时 fork 与离线 helper 尚未端到端对比。七个案例不构成跨工具等价恢复证明，也不证明所有版本兼容。
