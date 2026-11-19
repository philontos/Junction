# Junction

一个仓库，两个运行环境：云端管理账号、设备和 Context，本机运行 Switchyard 工作台与 Agent。当前电脑使用本机直连；远程设备保留云端中转。

## 本地开发

需要 Node.js 22+、Python 3.11+；运行任务还需要 Git、tmux、zsh 和对应 Agent CLI。

```sh
git clone https://github.com/philontos/Junction.git
cd Junction
npm run setup
npm run dev
```

打开 **http://127.0.0.1:3100**。同时启动的 Context 服务位于 `127.0.0.1:8768`，开发账号和连接自动配置。数据独立保存在 `.local/dev/`，再次启动会复用。端口冲突时设置 `WORKBENCH_PORT` 和 `JUNCTION_PORT`。Ctrl+C 只停止本次服务，不关闭已有 tmux 任务。

## 目录

| 路径 | 职责 |
| --- | --- |
| `apps/workbench` | Switchyard 界面、本机节点、任务与工作环境 |
| `services/junction` | Python Context 服务；`gateway/` 管理账号、设备和中转 |
| `packages/agent-adapters` | Node Agent 启动/日志定位与 Python JSONL 归一化 |
| `packages/node-transport` | 本机和云端复用的传输原语 |
| `deploy` | 开发启动、发布打包、云端部署与节点安装 |

目录统一，运行边界不变；节点凭据、数据库、工作目录和 Agent 安装不进仓库。两份旧仓库的提交历史均保留；Switchyard 的旧导入路径只作兼容转发，不维护第二份实现。

## 常用命令

```sh
npm run typecheck
npm run test:targeted
npm run test:context
npm run build
```

构建产生 `dist/node.tar.gz`、`dist/junction.tar.gz`、SHA-256 和共同的源提交号。分别用于节点/云端网关与 Context 服务，无需把 Python 服务安装到每个节点。

- [部署与升级](deploy/README.md)
- [架构与依赖方向](docs/architecture.md)
- [Agent 接入](packages/agent-adapters/README.md)
- [云端、本机工作台与设备接入](apps/workbench/docs/cloud-workspace.md)
- [Context 协议](services/junction/docs/protocol-v1.md)
- [原 Switchyard 使用说明](apps/workbench/README.md)
