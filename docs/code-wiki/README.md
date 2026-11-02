# dsh-superagent Code Wiki

> 面向维护者与二次开发者的源码级说明。以 `src/` 源码为准，官方设计文档 `docs/000-008` 作为背景补充。

## 一句话结论

`dsh-superagent` 是打包成 **DSH（DeepSeek Harness）bundle** 的主动式编码 Agent：它监听一个 GitHub 仓库（可选接入飞书），把收到的消息经 **确定性准入 + 模型研判** 转成工单（Ticket），每个工单在独立的 DSH Session 与独立目录中执行，再把结果回写到来源会话。

## 文档地图

| 文档 | 内容 | 适合谁 |
| --- | --- | --- |
| [01-overview.md](./01-overview.md) | 项目定位、能力边界、技术栈、分层架构、端到端主流程 | 所有人，先读这篇 |
| [02-domain-model.md](./02-domain-model.md) | Source/Trigger/Thread/Eval/Decision/Mandate/Ticket/Assignment 等概念、状态机、不变量 | 想改业务逻辑的人 |
| [03-core-engine.md](./03-core-engine.md) | 领域内核：`Engine`、五个内部 part、`ports`、`model`、`stage` | 想理解状态流转的人 |
| [04-application-layer.md](./04-application-layer.md) | `Runtime` 组合根、Passes、Store、Effects、Outbox、Sessions、Assessment、Settings、Prompts、HTTP、Tools | 想改宿主行为的人 |
| [05-sources.md](./05-sources.md) | SourceKind 插件契约、Registry、GitHub Source、飞书 Source、轮询与上下文读取 | 想接新来源的人 |
| [06-executor.md](./06-executor.md) | `DshExecutor`、worker Session、目录准备、并发槽、后台任务、失败恢复 | 想改执行链路的人 |
| [07-panel-client.md](./07-panel-client.md) | Web 管理面板入口、六个 tab、组件、API 类型、国际化、样式 | 想改前端的人 |
| [08-deployment-and-run.md](./08-deployment-and-run.md) | 依赖、安装、profile 配置、启动停止、退出码、状态目录、排障 | 运维与首次部署 |
| [09-build-test-and-assets.md](./09-build-test-and-assets.md) | tsdown 双构建、Vitest、tsconfig、cordis patch、prompts/skills/locale | 想跑通开发与发布的人 |
| [10-dependency-map.md](./10-dependency-map.md) | 模块依赖矩阵、运行时对象图、外部依赖、耦合风险、文件索引 | 做架构评审的人 |

## 推荐阅读路径

- **第一次接触**：01 → 02 → 03 → 04
- **接手运维**：08 → 04（Runtime/Settings/Setup）→ 05（账号与 Source）
- **开发新来源**：05 → 03（Engine 入口）→ 04（Registry 装配）
- **开发执行器**：06 → 04（Sessions/Effects）→ 02（Assignment 状态）
- **开发面板**：07 → 04（HTTP/Views）→ 02（状态展示口径）

## 仓库速览

```
src/
├── index.ts              # 插件入口：apply(ctx, config)，装配 Runtime
├── core/                 # 纯领域层：模型、端口、Engine 及五个内部 part
├── app/                  # 应用层：Runtime、Store、Effects、Sessions、Assessment、HTTP、Views、Tools
├── sources/              # 来源插件：SourceKind 契约、Registry、GitHub、飞书
├── executor/             # 执行器：DshExecutor 与后台任务控制
├── client/               # Web 管理面板（React/TSX）
├── infra/                # 命令执行、环境、健康、路径、文本等基础设施
├── policy.ts             # 策略/设置 Schema、策略版本与效果计算
├── deployment.ts         # 机器配置与部署账号解析
├── admission.ts          # 准入矩阵
└── kv.ts                 # 类型化 KV key 定义
```

关键命令：

```bash
pnpm install
pnpm build       # tsdown：构建 lib/ 与面板 client.js
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run（59 个 spec）
pnpm check       # typecheck + test + build
```

运行入口见 [08-deployment-and-run.md](./08-deployment-and-run.md)。

## 术语速查

| 英文 | 中文 | 一句话解释 |
| --- | --- | --- |
| Source | 来源 | 外部消息的接入点，如 GitHub 账号、飞书机器人 |
| Trigger | 触发 | 来源产生的一条规范化消息 |
| Thread | 线程 | 消息的会话载体，如一个 Issue、PR、飞书话题 |
| Eval / Assessment | 评估 | 判定 Trigger 是否值得成为工单的过程 |
| Decision | 决策 | 评估的审计记录（accept/stop/ignore/unavailable） |
| Mandate | 授权依据 | 工单成立的授权来源（显式请求或规则推断） |
| Ticket | 工单 | 一项被接管的工作，有明确的生命周期 |
| Assignment | 派工 | 工单的一次执行尝试 |
| Executor | 执行器 | 真正运行 worker Session 的组件 |
| Channel | 渠道 | 把回复发回来源的适配器 |
| Policy | 策略 | 谁可以发起工作、哪些消息可成为候选的规则 |
| Effects | 副作用队列 | 持久化的异步任务队列（评估/启动/投递/中继/通知/回复） |

## 文档口径

- 代码版本：`package.json` 中 `dsh-superagent@0.1.0`，DSH 引擎要求 `^0.2.1-alpha.2`。
- 文中所有类名、方法名、配置键均以当前源码为准；若与 `docs/000-008` 冲突，以源码为准。
- 为控制篇幅，文档只摘录关键签名与行为，不整段复制源码。阅读时建议对照文件路径跳转。
