# Junction

研究并实现跨 Agent 的 Context 持久化、接续与协作。先覆盖 Codex 和 Claude Code，以 Pi 作为扩展研究对象。

目前处于研究与功能确认阶段，已有产品草案、固定版本源码分析及合成验证脚本，尚未实现存储服务或确定通用协议。

## 当前方向

- 原生会话档案作为持久化原件，保留来源版本和必要依赖。
- 优先复用官方 resume、fork、导入和外部存储能力。
- 先验证直接转换，再决定是否需要薄的通用内容层。
- Context 与 Worktree、仓库、终端等执行环境分开管理。
- 协作目标是租户隔离、选择分享、引用和独立派生；具体实现待验证。

本项目可配合 Agent 工具独立使用。Switchyard 是未来可选的接入方：复用其任务、终端和工作环境管理，在同一界面中选择 Context、继续工作并回存历史。本项目先专注 Context，不承担完整工作台的建设。

## 阅读顺序

1. [功能清单](docs/product/context-collaboration.md)
2. [原生结构、完整性与 fork 研究](docs/research/context-sharing/native-storage.md#9-原生完整性与生命周期复核)
3. [行业实践调研](docs/research/context-sharing/README.md)
4. [来源与版本](docs/research/context-sharing/sources.md)
5. [合成验证与复现](docs/research/context-sharing/evidence/README.md)

[架构](docs/research/context-sharing/architecture.md)和[协议契约](docs/research/context-sharing/protocol-contract.md)保留为待验证候选，尚未选定，不作为实现前提。

## 下一步

1. 固定 Agent / SDK 版本与会话样本范围。
2. 验证原生归档后能否通过官方能力恢复和 fork。
3. 验证跨 Agent 转换，明确哪些内容保留、降级或无法使用。
4. 根据实验结果收敛存储边界及必要的公共结构。

后续用 Switchyard 验证一次“保存 → 恢复 → 继续 → 回存”的接入流程，再根据实际需要决定产品整合方式。

## 验证材料

`docs/research/context-sharing/evidence/` 包含合成输入、纯函数探针和脱敏结构统计，不包含真实会话正文。已有 ASP 六个解析案例、Claude 官方 fork 三个案例、Pi 官方投影与模型转换四个案例；这些不是端到端恢复验收。

验证脚本的运行环境、上游固定提交和复现命令见[证据说明](docs/research/context-sharing/evidence/README.md)。上游源码需另行获取，不随本仓库分发。
