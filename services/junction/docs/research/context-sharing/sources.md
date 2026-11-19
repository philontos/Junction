# 来源登记与研究边界

记录日期：2026-10-31；原生生命周期复核：2026-11-01。返回[主报告](README.md)。

下表的“源码审阅”只指所列模块，不表示审计整个项目。运行证据包括 ASP 六个案例，以及本次新增的 Claude fork 三个、Pi 投影/转换四个纯函数合成案例；没有运行项目完整测试套件、真实模型调用或端到端迁移。动态网站的链接反映研究时文档，GitHub 代码链接尽量固定提交。

## 1. 原生实现

| 来源 | 固定基线 | 实际审阅内容 |
|---|---|---|
| [OpenAI Codex](https://github.com/openai/codex/tree/36650394c5b38c2990ccf2a3457165ca3e9d9726) | `rust-v0.157.1`，`36650394…` | history 类型、rollout policy、重建、external-agent session import；本机生成 App Server schema |
| [Claude Agent SDK Python](https://github.com/anthropics/claude-agent-sdk-python/tree/2146f9d8985513053e904b13200c8f744b36785a) | `0.2.176`，`2146f9d…` | SessionStore 类型、原生 import/store、会话分支读取与并行工具恢复、conformance 契约、changelog |
| [Claude sessions](https://code.claude.com/docs/en/sessions) | 动态官方文档 | 会话持久化、恢复、压缩与文件系统边界 |
| [Claude SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions) | 动态官方文档 | SDK 会话与 resume/fork |
| [Claude session storage](https://code.claude.com/docs/en/agent-sdk/session-storage) | 动态官方文档 | 外部存储镜像、恢复与存储适配器契约 |
| [Pi](https://github.com/earendil-works/pi/tree/babe30a7e6c185346c85859da30b58183e5964f0) | coding-agent `1.4.0`，JSONL v3，`babe30a…` | 会话/格式/压缩文档、SessionManager 分支和投影、AgentSession 提示词/工具恢复、跨 provider 转换；四个合成案例 |
| 本地 CLI / 数据文件 | Codex `0.157.1`；Claude `2.1.203` | 结构、版本、类型和有限统计；见[脱敏观察](evidence/local-observations.json) |

研究时 Codex main 另为 `67f0994b532b8740f14b5b738af7b7b2a915b1d6`。本文主要存储分析使用上表匹配本机的版本，不把 main 与 tag 的内容合并描述。

## 2. 重点开源项目

| 项目与固定提交 | 审阅深度 | 主要依据 / 注意事项 |
|---|---|---|
| [TUTTI](https://github.com/tutti-os/tutti/tree/207beeea554435618dffd3b579d0ffe112b065c4) `207beee…` | 设计文档 + 选定源码 | Host/fork 类型与能力、SQLite fork/effective-history/message semantics、reference mention；没有验证整个平台部署 |
| [txcript](https://github.com/skillsynchq/txcript/tree/c60e686e7ed30e67019288eed80c4be478512d64) `c60e686…` | 核心类型与 codec 源码 + 格式文档 | 版本 `0.14.4`；原生/Common 边界、Claude/Codex codec、lineage；未运行原生导入 |
| [Agent Session Protocol](https://github.com/kevin-dp/agent-session-protocol/tree/470b9242d8c5eb5a35b6b330405b8edd52756a06) `470b924…` | 源码 + 实际纯函数探针 | 版本 `0.0.7`；types、tools、normalize；未执行 capi 的会话合并、Git 或 Agent 启动功能 |
| [Moirai](https://github.com/october-dev/moirai/tree/2f371b357e68e35eaf5e9ebf1994b03f1591507f) `2f371b3…` | 核心类型与 codec 源码 | model/archive/Claude/Codex；仓库创建于 2026-09，不能以 format 声明推定成熟兼容性 |
| [SCTXX](https://github.com/handyutils/sctxx/tree/37d60265877e79724dd5412096659fccc0eaf31e) `37d6026…` | IR、adapter、校验器源码与规范 | 仓库创建于 2026-09；预发布；未执行 LLM fold，也未验证其完整输出质量 |
| [Entire CLI](https://github.com/entireio/cli/tree/54b6a5cac34e5ff939e6e5871168da9ffd4d187a) `54b6a5c…` | 仓库架构文档 | sessions/checkpoints、Git-ref backend；没有把文档审阅标为运行实测 |
| [OpenViking](https://github.com/volcengine/OpenViking/tree/012e1f0c83405664c07d371c4f4d77a013015253) `012e1f0…` | Context/message/session/archive 核心源码 | 分层表示、工具产物、归档与提取；GitHub 许可证元数据为 AGPL-3.0；未审计完整跨租户授权 |
| [Graphiti](https://github.com/getzep/graphiti/tree/72b5c59c06607e09ea855be61b6ff5a3446fc951) `72b5c59…` | nodes / edges 源码 | episode、事实来源和时间字段；未验证模型抽取精度或部署 |
| [Harbor](https://github.com/harbor-framework/harbor/tree/5eb713ff9500daced4e143b98765a7c732744a1b) `5eb713f…` | ATIF trajectory / step / observation 模型与 RFC | 默认 ATIF-v1.8；有实际 schema 与验证实现；未执行各 harness 的导出器 |

## 3. 扩展检索与筛选

| 项目 | 版本依据 | 范围与处理 |
|---|---|---|
| [nutthouse/tutti](https://github.com/nutthouse/tutti/tree/6b86cca7457364888032e6ff9c04f2a87fc14cb2) | `6b86cca…` | 同名项目辨识，编排 CLI；未将其功能归给 tutti-os |
| [tuttiai/tutti](https://github.com/tuttiai/tutti) | 未固定 | 搜索线索；元数据请求超时，没有作为核心设计证据 |
| [Hindsight](https://github.com/vectorize-io/hindsight/tree/bc5ea195a0fed1346ff171a5780bbb72a38c89c8) | `bc5ea19…` | 官方项目/Retain API 文档；未做核心算法源码审计 |
| [Letta](https://github.com/letta-ai/letta/tree/8816d3a8516893bfdc0fa14bfb1235226012e295) | `8816d3a…` | AgentFile 官方 V1 文档；未把它描述成通用 CLI 恢复协议 |
| [Acontext](https://github.com/memodb-io/Acontext/tree/1ddfd903fd1004672ca9f9a70d92041153ba43d5) | `1ddfd90…` | 官方文档与 API 元数据；研究时 archived=true，最近 push 为 2026-10-24，不能据此确定归档操作的准确日期 |
| [Mem0](https://github.com/mem0ai/mem0/tree/753496cf1435d76c3a711f3af51303f7fdcb6420) | `753496c…` | 项目文档，记忆层分类；没有产品效果对比测试 |
| [CASS](https://github.com/Dicklesworthstone/coding_agent_session_search/tree/30f96a3dbed4f18e99ff205541fa97528eeba3e7) | `30f96a3…` | 项目文档，跨工具索引分类；许可证 API 返回 NOASSERTION，本文不据此作开源许可证判断 |
| [Git AI](https://github.com/git-ai-project/git-ai/tree/8a6184a3a8fc4e997ccfff3b16d79688e4255af4) | `8a6184a…` | 项目文档，代码来源维度 |
| [Buzz](https://github.com/block/buzz) | 未固定核心源码 | 官方项目介绍；本次只作为协作通信背景，不用它证明存储保真 |

初始部分 GitHub API 查询超时；ASP 和 txcript 的版本依据后来由实际 checkout 的 HEAD 和 package 文件确认。大仓库只检出所需目录，部分使用固定提交的 raw 文件读取；不以是否完整 clone 判断功能成熟度。

## 4. 协议与研究论文

| 来源 | 采用范围 |
|---|---|
| [MCP Resources 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/resources) | URI、读取与资源通知；不外推为会话资产格式 |
| [ACP v1](https://agentclientprotocol.com/protocol/v1/session-setup) | Session setup/load/update；研究时 v2 为另一个草案范围，不混用 |
| [A2A v1.0.1](https://a2a-protocol.org/v1.0.1/specification/) | task/message/artifact/contextId；存在安全与多租户相关机制，但并不直接等于我们定义的资产 ShareGrant |
| [OTel GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) | 官方当前仓库；Development 状态；包括可选内容/外部上传关联，但不默认保证完整归档 |
| [Agent Trace](https://agent-trace.dev/) | 官网 RFC 0.1.0；研究时 `cursor/agent-trace` GitHub API 返回 404，引用官网而不把第三方 fork 当官方 |
| [W3C PROV-DM](https://www.w3.org/TR/prov-dm/) | 来源、生成、派生的概念参考 |
| [LongMemEval](https://arxiv.org/abs/2410.10813) | 长期记忆评估维度；不引用其性能数字推断本项目效果 |
| [LongMemEvalV2](https://arxiv.org/abs/2605.12493) | 环境动态知识和可复用流程的研究线索；不作为格式标准 |

## 5. 如何复核结论

优先从主报告每段的直接链接查看固定文件，而非从仓库 README 的宣传概括反推功能。对重要适配器结论，应再用真实但经同意构造的干净会话语料做集成验证。

本次可重复的运行证据见[ASP 与官方原生函数探针](evidence/README.md)。本地结构统计是该时间点的观察记录，不是对所有用户环境的断言。多租户、长期存储与格式不变量各节是待验证的设计候选，不是本项目已经实现的能力。

## 6. 稳定性优先修订的补充依据

用于[架构修订](architecture.md)和[协议契约](protocol-contract.md)。本轮追加的是官方规范与文档审阅，没有新增未经执行的 conformance 或崩溃恢复测试结果。

| 来源与基线 | 采用程度及质量判断依据 |
|---|---|
| [CloudEvents 1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md)、[JSON 格式](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/formats/json-format.md)、[官网治理/SDK](https://cloudevents.io/) | 直接采用信封；发布版本、多语言实现及治理可核查。来源身份与重发规则明确，不据此推导持久化保证 |
| [OCI Descriptor 1.1.1](https://github.com/opencontainers/image-spec/blob/v1.1.1/descriptor.md) | 直接采用内容描述符；规范明确支持嵌入其他格式。没有宣称实现完整 OCI image/distribution 规范 |
| [JSON Schema 2020-12](https://json-schema.org/draft/2020-12)、[核心规范](https://json-schema.org/draft/2020-12/json-schema-core)、[测试套件](https://github.com/json-schema-org/JSON-Schema-Test-Suite) | 采用明确 dialect；有独立验证依据。测试工具仓库未固定具体版本，待实现选择验证器时一并固定 |
| [HTTP RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) | 条件更新与幂等资源行为；正式 Internet Standard |
| [Problem Details RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) | 直接采用错误表示；领域问题类型由我们补充 |
| [OCFL 1.1](https://ocfl.io/1.1/spec/)、[实现建议](https://ocfl.io/1.1/implementation-notes/) | 文档给出归档对象、版本和完整性规则；借鉴可重建与 fixity 原则，暂不实现完整目录规范 |
| [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)、[checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers) | 官方文档明确 checkpoint/store 区别、pending writes 恢复；仅借鉴边界，不增加运行时依赖或声称已审计其全部源码 |
| [SQLite WAL](https://www.sqlite.org/wal.html)、[atomic commit](https://www.sqlite.org/atomiccommit.html) | 存储前提、同步方式、WAL 约束和已公开缺陷；实际运行时版本及恢复行为仍须实施验收 |

成熟度判断是按模块、契约和采用范围做的定性筛选，不等价于第三方安全审计、性能认证或本产品的可靠性证明。

## 7. 原生完整性与 fork 补充依据

| 固定来源或官方文档 | 本次实际审阅与用途 |
|---|---|
| Codex `36650394…` 的 `core/src/thread_manager.rs`、`thread-store/src/local/paginated_fork.rs`、`rollout_lineage.rs` | copied / referenced fork、持久化边界、history_base 祖先依赖；源码审阅，未运行 Rust 集成测试 |
| 同提交 `rollout/src/policy.rs`、`core/src/session/rollout_reconstruction.rs` | 持久化筛选、压缩与 rollback 重建；不能以 JSONL 存在推导精确请求留存 |
| Claude SDK `2146f9d…` 的 `session_mutations.py` | 离线和 store fork 共用转换、UUID/父链/压缩关联；三个实际合成探针 |
| 同提交 `session_import.py`、`session_resume.py`、`session_store.py` | 原生记录导入与镜像；远端恢复先物化本地原生布局；未做远端后端接入 |
| [Claude CLI 提示词规则](https://code.claude.com/docs/en/cli-reference#system-prompt-flags-in-resumed-conversations) | 当前默认 system prompt 快照及版本/模式例外，不能套用到所有旧版样本 |
| [Claude 环境变量](https://code.claude.com/docs/en/env-vars#variables) | TRANSCRIPT_LOCAL_GC 可在保留恢复能力的同时删除压缩前原历史；v2.1.287 起的可选能力 |
| [Codex App Server](https://learn.chatgpt.com/docs/app-server) | 官方 thread resume/fork 的使用入口；字段应以固定二进制 schema 和实际接入验收为准 |
| Pi `babe30a…` 的 `session-manager.ts`、`messages.ts`、`api/transform-messages.ts` | 四个实际合成探针；不是跨 harness 导入验收 |
| Pi 同提交 `agent-session.ts` | structured prompt / tool loadout 记录、forced prompt 请求投影、工具 registry 恢复的边界 |

具体文件的固定提交链接与结论对应关系见[原生复核](native-storage.md#9-原生完整性与生命周期复核)。本轮没有引入新的通用协议依赖，也没有修改真实 Agent 会话。
