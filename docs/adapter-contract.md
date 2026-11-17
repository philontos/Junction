# 原件、阅读投影与 Agent 适配器

2026-11-17。实现对应 v0.2；目前正式安装的适配器只有 Claude Code 和 Codex。

## 长期保持的边界

1. **原件是事实底稿。** 上传字节不可变，解析失败也保存；不通过反向序列化“重建原文”。
2. **原生记录索引负责追溯。** 记录不强行等同于消息；未知事件、坏行、多个展示记录都可以定位。原字段按原件权限读取，不在公共索引中展开。
3. **统一格式负责阅读和查询。** Session / Turn / Message / Block 是投影。轮次推导、工具配对、压缩及分叉的不确定性必须记录。它不声称等于模型实际收到的输入。
4. **环境仍是扩展。** 仓库、worktree、skills 和执行权限不进入核心语义。历史字段不能授予当前执行权限。

当前保留模型与 usage 等原生信息时，用有来源行号的 message_metadata 标记，不把不同厂商的 token 数硬算成同一指标。未知字段不自动变成统一字段，但可以沿记录索引逐字节回查。内嵌附件和不透明 reasoning 仍在原件；没有附件复制、解密或自动工具重放。

## 新增适配器的最小改动

适配器只接受已读取的 `(line, object)` 列表与 ParseState，输出 Candidate、诊断和会话元信息。无需改 SQLite、查询接口或统一消息结构。

1. 新增一个解析模块；沿用 Candidate / Block，保留原生 session、message、parent、turn、role 和来源行号。
2. 在 `parsers/registry.py` 注册 `Adapter(id, version, source_format, parse)`。id 表示日志格式来源，不表示模型厂商；Pi 调用 Anthropic 时来源仍是 pi。
3. 用合成 / 脱敏样例覆盖消息、工具、元信息、未知块、截断行、重复记录、分叉和压缩。运行导入、分页、完整导出、原件回查与重复导入测试。
4. 解释规则变化时提升适配器版本；公共投影规则变化时提升投影版本。组合后的 parser_version 参与版本指纹，旧投影不覆盖。

注册是受信任的服务代码配置；不从上传 JSONL 动态加载插件或执行模块。未注册的 Agent 明确返回错误。`GET /v1/providers` 和 `junction providers` 报告真实安装能力。已用临时测试适配器验证：注册新来源及提升其版本，无须修改模型枚举、API、CLI 或存储代码。

## 用 Kimi / Pi 核对边界

这里只审阅原生格式，不宣称已经完成适配器或真实任务交接。固定来源如下：

| 来源 | 原生特点 | 对 Junction 的要求 |
| --- | --- | --- |
| [Pi 会话格式，1f6f319…](https://github.com/earendil-works/pi/blob/1f6f319bb28992a40b99c147fffb23b65a23129d/packages/coding-agent/docs/session-format.md) | id / parentId 构成树；model_change、usage、compaction、context_edit、custom 等不都是模型消息 | 保留原生记录与父关系；不能把文件顺序当作唯一活跃分支，也不能把 custom 状态伪装成用户消息。格式中的 model provider 与 Agent 来源分别处理 |
| [Kimi Context，9ab1286…](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/soul/context.py) | 普通消息之外有 _system_prompt、_checkpoint、_usage；恢复和回退由 Context 自身解释，回退会轮转文件 | 特殊记录保留为元事件；仅上传当前文件不能推断所有旧历史仍存在。以后若支持多个文件，应显式携带来源清单，不能偷偷读取旁边的日志或假装已经合并 |

这些差异支持“原生记录保真 + 有限统一语义”的取舍。现在不实现通用执行引擎、自动分支恢复或庞大事件分类表；真实接入时再提升对应适配器的识别范围。

## 演进约束

- v1 内只能新增字段或能力，不能悄悄改变已有字段含义；读取器保留未知新增字段，拒绝未知主版本。
- record ID、message ID、turn ID 都限定在固定 Revision；跨版本引用必须带 Context / Revision。
- `projected` 不代表原生记录的每个字段都理解了；`ready` 不代表原 Agent 内存或模型请求完整。
- 源格式版本、适配器版本、统一协议版本和数据库版本分开管理。
- 升级存储表不重写历史投影。需要新的解释时重新导入，形成新 Revision，仍引用同一原件。
