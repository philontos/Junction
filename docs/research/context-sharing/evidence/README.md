# 运行证据与复现

本目录只包含人工合成输入、固定版本纯函数的输出，以及不含正文的本机结构观察。不含真实 prompt、私有 session ID、工具输出、认证信息或 memory 内容。

## 文件

- [asp-probes.json](asp-probes.json)：六个合成案例，每个保留输入与实际序列化输出。
- [probe-asp.mjs](probe-asp.mjs)：对固定 ASP 提交复现这些输出的脚本。
- [asp-probe-metadata.json](asp-probe-metadata.json)：实际复现使用的 Node 版本、提交和源码摘要。
- [local-observations.json](local-observations.json)：本次本机 CLI/原生数据结构的有限观察；不是可恢复的备份。
- [local-session-samples.json](local-session-samples.json)：后续六份原生 JSONL 样本的脱敏数量、类型和版本；没有文件路径或原始正文。
- [claude-fork-probes.json](claude-fork-probes.json)与[探针](probe-claude-fork.py)：官方 SDK fork 纯函数的三个案例。
- [pi-context-probes.json](pi-context-probes.json)与[探针](probe-pi-context.mjs)：官方历史投影、跨模型转换纯函数的四个案例。

## 复现方式

需要 Node.js 24 和 Git。为固定依赖，使用独立 checkout；脚本不安装 npm 依赖，不启动 Agent，不请求模型服务，也不读真实会话目录。

```sh
git clone https://github.com/kevin-dp/agent-session-protocol.git ./asp-context-research
git -C ./asp-context-research checkout 470b9242d8c5eb5a35b6b330405b8edd52756a06
node docs/research/context-sharing/evidence/probe-asp.mjs ./asp-context-research ./asp-probe-output.json
```

最后一个输出路径必须尚不存在。脚本确认提交和相关源码未修改，使用 Node 内置的 TypeScript 类型移除功能加载三个解析模块，将新结果写到指定文件，并与保存的观察结果比较。它还写出 `<output>.meta.json`。这项比较只验证观察可以复现，不将已记录的有损输出定义为我们未来协议的正确行为。

## 案例的实际含义

| 案例 | 观察点 |
|---|---|
| `claude_rewind` | parent 相同的兄弟分支都进入文本输出，关系未保留 |
| `claude_image_unknown_block` | 文本保留，image 与未知块不进入归一输出 |
| `codex_rollback` | rollback 事件不进入输出，之前文本仍被输出 |
| `codex_paginated_user_only` | 单个 paginated UserMessage 事件未被识别为用户消息 |
| `codex_future_event` | 未知顶层事件被跳过 |
| `codex_compacted_replacement` | 默认从最后压缩点开始；replacement history 未进入输出 |

这是最小事件覆盖/保留探针，**不是六份完整、经 CLI 原生验证的生产会话**。例如图片的 base64 是合成占位，未验证图片解码；rollback 案例用于观察 normalizer 是否处理该控制事件，未构造完整运行生命周期。这些结果不能用来断言所有真实会话都会失败，也不是对第三方项目整体质量的评分。

它们支持的结论较窄但重要：当前输出不足以作为我们设想的完整资产档案，不能单独承担有效分支重建，且必须对新旧版本事件做显式覆盖验证。

没有对 txcript、Moirai、SCTXX、TUTTI 或官方迁移执行同等运行探针；对应结论分别标为源码或文档分析。没有上传或迁移本机真实会话。

## 官方原生函数探针

2026-11-01 补充七个合成案例，全部通过。与前面的第三方 normalizer 探针分开计数；两组都不构成 CLI 原生恢复验收。

| 案例 | 运行的官方代码 | 验证内容 |
|---|---|---|
| Claude 身份及关联 | `_parse_fork_transcript`、`_build_fork_lines` | 新会话/消息 UUID，跳过 progress 修复父链，压缩 logical parent 重映射；工具调用 ID、未知字段保留 |
| Claude 覆盖及原件 | 同上 | 不带 sidechain / progress / file-history snapshot，保留 isMeta；原输入不变 |
| Claude 截止位置 | 同上 | 截止点包含在所复制前缀中 |
| Pi 分支与压缩 | `buildContextEntries`、`buildSessionContext` | 只选择指定 leaf 的路径；checkpoint、summary、保留消息和后续消息进入上下文 |
| Pi context edit | 同上 | 只改变分支中的模型投影，不改原件或兄弟分支 |
| Pi 跨模型转换 | `transformMessages` | 外部模型的 thinking / signatures 丢弃；调用与结果 ID 一起变换；同模型签名保留 |
| Pi 缺失工具结果 | 同上 | 插入合成错误结果，而不是声称工具实际执行成功 |

Python 脚本用 AST 选择原始纯函数；Node 脚本用内置 TypeScript 类型移除加载原始纯函数与消息构造器。两者先核验固定源码 SHA-256，函数行为未重写，均不启动 CLI、读取真实会话或访问模型服务。它们未执行官方完整测试套件，也未测试存储镜像、网络中断或持久化一致性。

复现需要 Python 3.12、Node.js 24、Git；以下输出路径必须尚不存在：

```sh
git clone https://github.com/anthropics/claude-agent-sdk-python.git ./claude-sdk-review
git -C ./claude-sdk-review checkout 2146f9d8985513053e904b13200c8f744b36785a
python3.12 docs/research/context-sharing/evidence/probe-claude-fork.py ./claude-sdk-review/src/claude_agent_sdk/_internal/session_mutations.py ./claude-fork-output.json

git clone https://github.com/earendil-works/pi.git ./pi-review
git -C ./pi-review checkout babe30a7e6c185346c85859da30b58183e5964f0
node docs/research/context-sharing/evidence/probe-pi-context.mjs ./pi-review/packages/coding-agent/src/core/session-manager.ts ./pi-review/packages/coding-agent/src/core/messages.ts ./pi-review/packages/ai/src/api/transform-messages.ts ./pi-context-output.json
```

本次实际运行环境是 Python 3.12 与 Node 24.15.0；具体 patch 版本及源文件摘要见结果 JSON。返回码非零或缺少结果文件均不能视为通过。随机生成的 fork UUID 不写入汇总结果；结果只保留对应关系的断言和合成样本标签。

`local-session-samples.json` 是此前只读检查报告的白名单字段提取，保存源报告摘要用于区分观察批次；它不是可重新导入的档案。`file_changed_during_read=false` 仅反映一次读取检查，不证明跨文件/数据库一致，也不说明会话已结束。调用与结果相差一条可能只是采集时仍有在途调用。
