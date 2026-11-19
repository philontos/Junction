# Agent 接入

接入分两端，按能力组合，使用显式注册。Agent 来源与模型厂商分开：Pi 调用 Anthropic，Context 来源仍是 `pi`。

| 模块 | 职责 | 接口 |
| --- | --- | --- |
| Switchyard 本机适配器 | 启动／恢复、定位原生会话、阅读视图、图片输入 | `server/agents/types.ts` 的 `AgentAdapter` |
| Junction 格式适配器 | 原生 JSONL → 统一 Context、来源追踪、诊断 | Junction 的 `parsers/registry.py` |
| 通用交接层 | 下载固定版本、生成查询脚本和交接 skill | `server/junction/handoff.ts`，所有 Agent 共用 |

本机适配器位于 `server/agents/{claude,codex,kimi,pi}.ts`，在 `index.ts` 注册。任务、tmux、会话分页和图片服务只调用接口；网页通过 `/api/tasks/options` 获取 Agent 列表，不维护独立选项表。SSH 节点通过 `tdsp list --json` 暴露相同描述。旧节点保留原有选项，新 Agent 不会被悄悄降级成 Claude。

`nativeFormat: null` 表示可运行／阅读，但尚不能共享原生文件。当前 Kimi 属于这一情况。格式解析可以独立升级，无需改变任务调度或数据库；Junction 的适配器版本参与不可变 Context 版本指纹。

新增 Agent：实现一个本机适配器、一个 Junction 解析器并分别注册；如果只需要运行，先不实现共享。验证启动参数、精确会话绑定、消息／工具配对、未知记录、重复导入和完整导出。不从 Context 动态安装或执行适配器。

## Pi

已验证 CLI：`@earendil-works/pi-coding-agent@1.5.2`，需要 Node.js ≥ 22.19。安装后在该设备运行 `pi`，用 `/login` 登录并选择模型。网页模型字段可填 `provider/model`，留空使用 Pi 本机默认值。

```sh
npm install -g @earendil-works/pi-coding-agent
pi
```

新任务／Context 接续窗口选择 **Pi**。本机保存到 `DATA_DIR/agent-sessions/pi/<task-session>/`，由 Pi 自己写 JSONL；恢复使用该任务目录中、工作目录匹配的确切文件。模型凭证和权限由本机 Pi 管理。

共享上传原始 JSONL；Junction 保留字节与索引，并解析消息、工具调用／结果、图片引用、system 配置、模型和 usage、压缩、分支及 context_edit。父子关系保留；不推断活跃分支或恢复原进程状态。内嵌图片标记 `raw_only`，普通共享不会自动传输图片本体。旧文件可通过 Junction CLI 指定 `--provider pi` 导入。

验证包括隔离的真实 Pi TUI：本地模拟模型调用 `read` 读取交接 skill，再调用 `bash` 运行 Context 查询脚本；生成的真实 JSONL 经 Junction 解析，工具配对正常。此检查不等同于真实模型完成开发任务。

格式依据：[Pi 会话规范，固定版本](https://github.com/earendil-works/pi/blob/653f332b6fe22e2e927dd3d553d20234a3de27f0/packages/coding-agent/docs/session-format.md)。
