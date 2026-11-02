# 04 · 应用层：装配、持久化与运行时服务

> 对应源码：`src/app/*`、`src/index.ts`、`src/policy.ts`、`src/deployment.ts`、`src/setup.ts`、`src/kv.ts`。

应用层是“把领域内核接到真实世界”的地方：它负责进程生命周期、SQLite、异步队列、DSH Session、模型评估、设置、Prompt、HTTP、工具和视图。核心原则是 **组合根集中装配，其他模块只依赖端口**。

## 1. 插件入口与 Runtime

### 1.1 `src/index.ts`

```ts
export const name = 'dsh-superagent'
export const inject = ['agents','sessionController','sessionPersistence','workspaceRegistry',
  'permissionPresets','tools','systemPrompt','skills','webServer','llm','subprocess']
export function apply(ctx, config) { ... }
```

- `machineOf(config)` 解析机器配置（`stateDir` 必填）。
- 关闭 DSH 默认 settings UI，避免与自带面板冲突。
- 定义 `restart()`（通过 DSH 重启插件）。
- 创建 `Runtime(ctx, machine, restart)`。
- `ctx.effect(...)` 注册停止逻辑。
- 返回 `runtime.ready`。

### 1.2 `Runtime` 构造顺序

`Runtime extends Service implements SourceHost`，是唯一组合根。

1. `mkdirSync(stateDir, {recursive:true, mode:0o700})`。
2. `lockSync(stateDir, {stale:30_000})`：单实例锁；锁失效会触发 `runtime` 健康错误并 abort lifetime。
3. `new Store(<stateDir>/orchestrator.sqlite)`。
4. `new Setup(...)`。
5. `new Prompts(...)`。
6. `masterId = KV.runtime.masterId ?? orchestrator-<key(stateDir)>`，写回 KV。
7. `new Commands(...)`、`new Effects(store, board)`。
8. `new SourceRegistry(...)`。
9. 构造链接、资源宿主、`Sessions`、`Settings`、`DshExecutor`、`MasterAssessor`、`Outbox`。
10. `new Engine({ repo, scope, policy, assessor, executor, outbox, prepareTicket, emit })`。
11. `new Passes(...)`。
12. `toolHost`。
13. `this.ready = this.initialize()`。

初始化失败时会关闭数据库并释放锁，允许同进程重启后重新获取。

### 1.3 `initialize()`

1. 先注册 HTTP 路由（这样 setup 失败时面板仍可修复）。
2. `setup.run(settings)`：
   - 失败 → `runtime` 健康状态 `paused/setupPending`，等待人工处理。
3. `sessions.install()`、`executor.install()`。
4. `sessions.ensure(masterId, stateDir, 'dsh-superagent orchestrator', 'orchestrator')`。
5. 对可同步的 Source 执行 `settings.sync(id)`。
6. 若期间已停止则直接返回。
7. `executor.resume()`、`passes.start()`、`effects.start()`。
8. `runtime` 健康状态改为 `ready`。

### 1.4 `emit` 事件桥接

Engine 发出的领域事件在这里转换成会话消息：

| 事件 | 动作 |
| --- | --- |
| 其他需通知事件 | `eventNotice` → `sessions.notify` |
| `trigger.received` / `ticket.resumed` / `trigger.followup` | `followupNotice` → `sessions.relay` |
| `ticket.ended` | `pullEndNotices` → `outbox.send` |

`quiet` 计数器在主 Session 工具执行期间抑制“自己触发自己的通知”。

### 1.5 `shutdown()`

1. `closingFlag = true`，停止 Passes，abort lifetime。
2. `assessor.stop()`。
3. 取消主 Session 与所有 worker Agent（`keepInbox: true`）。
4. 等待 passes、effects drain、agents idle。
5. `executor.shutdown()` + `dispose()`，`sessions.dispose()`。
6. 逆序执行 disposers。
7. `sessionPersistence.flush()`。
8. `setup.restore()` → `store.close()` → 释放目录锁。

## 2. Passes：驱动时钟

`src/app/passes.ts`

- 每 2 秒 `setInterval` 触发一次 `request()`。
- `receive(trigger)` 调 `engine.receive`，返回 `'stored'` 时立即请求一次 pass。
- `pump()` 合并并发调用：同一时间只跑一个 pass，后续请求合并成一次 follow-up。
- `pumpOnce()`：`effects.kick()` + `engine.evaluateDue()`。
- `idle()`：等待当前 pass 与 effects 空闲。
- 失败时把 `runtime` 健康状态置为 `error`，下一次成功恢复 `ready`。
- 未完成 setup 或正在关闭时直接跳过。

## 3. Store：SQLite 持久化

`src/app/store.ts`

### 3.1 连接与迁移

- `node:sqlite` 的 `DatabaseSync`。
- `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL`。
- 文件权限 `0600`，目录 `0700`。
- Schema 版本：`OLDEST_SCHEMA = 10`，`SCHEMA_VERSION = 11`。
- 启动时自动 `migrateTo11`；失败会回滚并关闭连接，保证文件不变。
- 比 11 新或比 10 旧都拒绝启动。

### 3.2 表

| 表 | 内容 |
| --- | --- |
| `kv` | 所有键值状态（设置版本、Prompt 版本、游标等） |
| `trigger` | Trigger JSON + `at` |
| `disposition` | Trigger 去向 |
| `thread` | Thread JSON |
| `ticket` | Ticket JSON |
| `decision` | Decision JSON + `thread` |
| `outbox` | 发送回执 |
| `trigger_thread` | Trigger ↔ Thread 索引（含 `human`） |
| `effect` | 持久化副作用队列 |

### 3.3 生成列与索引

`SETS` 定义常用查询的生成列与部分索引：

- `ticket.open`、`ticket.active`
- `thread.active`、`thread.subscribed`
- `outbox.dropped`、`outbox.pending`（`ticketId + channel.thread` 排序键）

### 3.4 事务

- `atomic(work)`：嵌套 savepoint；最外层提交后才执行 `afterCommit` 回调。
- 回调抛错只上报，不影响已提交事务。
- `afterCommit` 用于内存态即时动作；需要跨重启的副作用走 `Effects`。

### 3.5 其他接口

- `KV` get/set/delete/keys。
- `settingsVersions` / `saveSettings` / `settingsHistory` / `blockRevision`。
- `triggers` / `threads` / `tickets` / `decisions` 仓库。
- `read`（`storeReads`）：分页/搜索/邻接消息。
- `receipts`：`get/waiting/behind/add/settle/withdraw`。

## 4. Effects：可靠副作用队列

`src/app/effects.ts`

### 4.1 为什么需要

很多动作不能放在领域事务里 await：调模型、启动 Session、发 HTTP 请求。Effects 把“要做的事”写进 SQLite，提交后异步执行，崩溃后可恢复。

### 4.2 语义

- `enqueue(kind, key, payload)`：同 kind+key 合并，保留队列位置，`generation++`。
- `handle(kind, run, options)`：注册处理器；每种 kind 只能注册一次。
- `ordered`：严格按 `seq` 串行；失败会阻塞后续同 kind。
- `limit()`：当前允许并发数；返回 0 表示暂停。
- `retry: [initial, max]`：指数退避，最大 60s（不同 kind 可覆盖）。
- `Later`：表示“现在不能跑”，按初始延迟重排，不增加失败计数。
- `quiet`：连续失败不在健康面板报错（失败已显示在工单上）。
- `drain()`：停止接新任务，等待运行中的完成；未完成行留给下次启动。

### 4.3 已注册的 kind

| kind | 注册位置 | 并发/顺序 | 重试 | 说明 |
| --- | --- | --- | --- | --- |
| `assessment` | `assessment.ts` | 最多 4，暂停为 0 | 默认 2s→60s | 组装候选卡并投递给主 Session |
| `launch` | `executor/dsh.ts` | 由并发槽控制，暂停为 0 | 5s→300s | 启动工单 |
| `delivery` | `executor/dsh.ts` | 最多 4，暂停为 0，`quiet` | 默认 | 投递输入；失败记录在工单上 |
| `relay` | `sessions.ts` | ordered，1 | 默认 | 把报告/候选 steer 进主 Session |
| `notice` | `sessions.ts` | ordered，1 | 默认 | 不唤醒地注入通知 |
| `reply` | `outbox.ts` | 1，暂停为 0 | 5s→300s | 通过 Source 渠道发送回复 |

### 4.4 健康

连续失败 ≥ `FAILURES_BEFORE_ERROR = 3` 时，该 kind 的健康项变为 `error`；成功一次后恢复。

## 5. Outbox：幂等外发

`src/app/outbox.ts`

- `send(message)`：在同一事务里写 receipt 并入队 `reply` effect；重复 ID 忽略。
- `status(id)`：`pending | sent | dropped`。
- `withdraw(id)`：撤回未发送消息。
- `sent()`：等待 `reply` 队列空闲。
- 投递时：
  1. Source 未启用/未安装 → `Later`。
  2. 同工单同会话有更早 pending 消息且未超过失败阈值 → `Later`（保序）。
  3. 渠道不再允许 → `settle(channelIgnored)`。
  4. 发送返回 `gone` → `settle(channelGone)`；`waiting` → `Later`；成功 → `sent`。

## 6. Sessions：DSH Agent 管理

`src/app/sessions.ts`

### 6.1 职责

- 创建/解析 Agent Session。
- 绑定系统 Prompt 与 skills。
- 工具注册（主 Session 或 worker）。
- 模型健康与重试状态。
- 向 Session 投递消息（queue/steer/inject）。

### 6.2 关键方法

| 方法 | 说明 |
| --- | --- |
| `install()` | 订阅 agent 事件、纠正 preset、初始化健康 |
| `ensure(id, cwd, title, role)` | 创建或解析 Agent；设置 role model、装饰、`danger-full-access`、重命名 |
| `holds(sessionId, requestId)` | 该请求是否已投递 |
| `prompt(sessionId, requestId, text, mode, authorize?)` | 幂等投递 |
| `promptedId(requestId)` | 生成 `dsh-superagent:<requestId>` 消息 ID |
| `relay(requestId, text)` | 入队 `relay` |
| `notify(name, value, summary)` | 入队 `notice` |
| `delivery(name)` | 判断上下文是否已注入或仍 pending |
| `status()` | Prompt 版本、通知状态、各 Session 版本 |
| `promptVersion(sessionId)` / `mayRead(...)` | Prompt 版本绑定与可见性 |
| `modelRetry(sessionId)` | 模型重试健康 |
| `dispose()` | 释放所有绑定 |

### 6.3 Delivery 幂等

`src/app/delivery.ts`

- 消息 ID：`dsh-superagent:<requestId>`。
- 从 live 事件、持久化历史、pending inbox 三处收集已投递 ID。
- 支持旧来源（`plugin`、`user.rpcId`）兼容。
- 保证“同一个 requestId 最多投递一次”，即使 Session 重启。

## 7. MasterAssessor：模型研判

`src/app/assessment.ts`

- `request(candidate)`：按 `evalId` 幂等入队 `assessment`。
- `context(...)`：通过 Source 的 `threadContext` 读取有界线程窗口（受 `admissionContextMaxPages` / `admissionContextTimeoutMs` 限制）。
- `read(...)`：把上下文资源格式化给模型。
- `decide(...)`：把 `AssessmentOutcome` 交回 `Engine.decide`。
- `stop()`：停止所有进行中的评估。
- `release(evalId)`：清理缓存的候选。
- 候选卡通过 `sessions.prompt(masterId, requestId, text, 'steer')` 投递。
- `candidateDelivered` 由 effect 处理器调用，开始计算截止时间。
- 接受结果可带 `name`（worktree 名）、`note`（路由备注）、`rules`（命中的规则）。

## 8. Settings / Setup / Prompts

### 8.1 Settings

`src/app/settings.ts`

块级设置与 revision：

| 块 | 内容 | 特殊约束 |
| --- | --- | --- |
| `policy` | 规则、各 Source 的允许发送者、准入表 | 由 Source kind 校验各自部分 |
| `eval` | 评估模型、超时、accept mode | 改模型需先验证可用 |
| `executor` | 执行目录、prepare 命令、blockedCommands、worker 模型、并发 | 只能从面板修改执行环境 |
| `pause` | `{ paused }` | 独立块，避免与 executor 并发冲突 |
| `source:<id>` | `{ enabled, config }` | 只能从面板修改账号 CLI |

保存流程：

1. 检查 revision（乐观并发），过期抛 `SettingsConflict`。
2. 解析 + 合并。
3. 模型变化先 `resolveRoleModel`。
4. 非面板来源的执行环境/账号变更被拒绝（`panelOnlyEnvironment` / `panelOnlyAccounts`）。
5. `setupChanged` 时重新校验账号。
6. 再次检查 revision。
7. 计算 `policyVersion` 与 `policyEffects`。
8. 事务内 `saveSettings` + `sessions.notify` + `engine.policyChanged`。
9. 若 `blockedCommands` 变了，重写 shim。
10. 需要重启时 `setup.restart()`，否则 `requestPass()`。

`sync(id)`：从 Source 的外部名册同步 policy 部分，失败按 1 分钟起、最长 1 小时指数退避重试。

### 8.2 Setup

`src/app/setup.ts`

- 探测 `gh` / `lark-cli`，解析 GitHub 仓库、账号、Feishu bot。
- 写入隔离的 git 配置与命令 shim 环境。
- `configured()` 决定编排是否可启动。
- `checkAccounts(block, settings)`：保存前验证指定来源账号。
- `blockCommands(blocked)`：重写 worker 命令 shim。
- `restore()`：恢复宿主环境变量。
- `check()`：已配置且飞书无问题时拒绝重复 setup。

### 8.3 Prompts

`src/app/prompts.ts`

- 版本化保存 `PromptConfig`（team sections + skills + built-in overrides）。
- `compose(config, role)`：按固定顺序拼装 System Prompt。
- `skills(config)`：注册内置 Source skills + 团队 skills。
- `validate`：检查 override 是否合法、占位符是否保留、总长度是否超限。
- `preview`：返回 orchestrator/worker 的完整文本与分段。
- `save`：乐观并发；首次保存会把默认配置固化为 revision 0。
- `history`：分页比较每个 revision 的变化字段。
- `defaultChanged`：提示内置文本已变化或已移除的 override。

内置 part key 与组装顺序详见 [09-build-test-and-assets.md](./09-build-test-and-assets.md#4-prompt-体系)。

## 9. HTTP、Views 与 Tools

### 9.1 HTTP

`src/app/http.ts`

- 只允许 `ctx.webServer.host === '127.0.0.1'`。
- 注册前缀 `/orchestrator`。
- 请求头必须 `x-orchestrator-request: 1`，且 `origin` 未设置或等于本机 host（同源）。
- 错误映射：`UserError.missing → 404`，其他 `UserError → 400`，冲突 → 409，未知 → 500。

路由表：

| 方法 | 路径 |
| --- | --- |
| GET | `/orchestrator/api/state` |
| GET | `/orchestrator/api/overview` |
| GET | `/orchestrator/api/search?q=` |
| GET | `/orchestrator/api/sources` |
| GET | `/orchestrator/api/settings` |
| POST | `/orchestrator/api/sources/:id/labels` |
| GET | `/orchestrator/api/threads` |
| GET | `/orchestrator/api/threads/:key` |
| POST | `/orchestrator/api/threads/:key/unsubscribe` |
| POST | `/orchestrator/api/triggers/:id/requeue` |
| GET | `/orchestrator/api/decisions` |
| POST | `/orchestrator/api/decisions/:id/dismiss` |
| GET | `/orchestrator/api/tickets` |
| GET | `/orchestrator/api/tickets/:id` |
| POST | `/orchestrator/api/tickets/:id/retry` |
| POST | `/orchestrator/api/tickets/:id/stop` |
| POST | `/orchestrator/api/executor/pause` |
| PUT | `/orchestrator/api/settings/:block` |
| GET | `/orchestrator/api/policy/history` |
| POST | `/orchestrator/api/policy-sync/:id` |
| POST | `/orchestrator/api/setup/check` |
| GET | `/orchestrator/api/models` |
| GET | `/orchestrator/api/prompts` |
| PUT | `/orchestrator/api/prompts` |
| POST | `/orchestrator/api/prompts/preview` |

类型契约在 `src/app/api.ts`，面板只 import type，不打包宿主代码。

### 9.2 Views

`src/app/views/*` 把领域状态转成面板稳定结构：

| 文件 | 内容 |
| --- | --- |
| `overview.ts` | 总览、健康、评估异常统计 |
| `records.ts` | 工单/线程/触发/决策的通用卡片与详情 |
| `settings.ts` | 设置视图 |
| `sources.ts` | 来源状态 |
| `threads.ts` | 线程列表/详情/搜索/决策列表 |
| `tickets.ts` | 工单列表/分页 |
| `text.ts` | 文本截断与预览 |

`src/app/cards.ts` 提供卡片、行、分页的底层格式化。

### 9.3 Tools

主 Session 工具（`src/app/tools/main.ts`）：

| 工具 | 用途 |
| --- | --- |
| `orchestrator_route` | 路由显式请求/停止到工单 |
| `orchestrator_ticket_retry` | 重试工单 |
| `orchestrator_ticket_request_status` | 向 waiting worker 请求状态 |
| `orchestrator_ticket_note` | 给工单补充上下文 |
| `orchestrator_trigger_requeue` | 重新评估 |
| `orchestrator_eval` / `orchestrator_eval_read` / `orchestrator_eval_decide` | 评估候选/读上下文/决策 |
| `orchestrator_reply` | 回复（ack/answer/result/attention） |
| `orchestrator_thread_unsubscribe` | 取消线程订阅 |
| `orchestrator_settings_save` | 保存设置 |
| `orchestrator_policy_sync` | 同步来源策略 |
| `orchestrator_prompts_save` | 保存 Prompt |
| `orchestrator_read` | 读取分页上下文资源 |

Worker 工具（`src/app/tools/executor.ts`）：

| 工具 | 用途 |
| --- | --- |
| `orchestrator_ack` | 确认人的请求 |
| `orchestrator_thread_unrelated` | 标记线程无关 |
| `orchestrator_thread_follow` | 只读跟随线程 |
| `orchestrator_trigger_handback` | 交回不属于本工单的消息 |
| `orchestrator_report` | 汇报进度/结果/阻塞/失败/放弃 |

### 9.4 Resources

`src/app/resources.ts` 为 `orchestrator_read` 提供分页资源：

- 列表：`tickets`、`triggers`、`threads`、`decisions`。
- 详情：`thread/<key>`、`decision/<id>`、`ticket/<id>`、`trigger/<id>`。
- worker 可读：`ticket/<id>/assignment|assignments|inputs|result|report/<id>|transcript|message/<n>`、`thread/<key>`、`trigger/<id>`、`prompts/<revision>`、GitHub/飞书原始资源。
- 主 Session 独有：`settings*`、`models*`、`prompts/defaults`、`prompt-preview/<id>`。
- 大文本按 `offset/limit` 分页；GitHub/飞书资源首次读取后缓存在 `TextCache`。

## 10. 其他模块

| 模块 | 作用 |
| --- | --- |
| `src/app/links.ts` | 来源链接、候选卡、回复对象解析 |
| `src/app/notices.ts` | 通知/中继格式、`eventNotice`、`followupNotice`、`reportRelay` |
| `src/app/cards.ts` | 卡片与分页格式化 |
| `src/app/cache.ts` | `TextCache`，按字符数淘汰 |
| `src/app/retry-health.ts` | 模型重试健康 |
| `src/app/role-models.ts` | 角色模型解析 |
| `src/app/versions.ts` | 通用版本存储 |
| `src/app/settings-history.ts` | 设置历史视图 |
| `src/app/migration.ts` | schema 10→11 迁移（616 行，含大量历史数据修复） |
| `src/app/skill-files.ts` | 读取打包的 skills |
| `src/app/source-context.ts` | 构造 `SourceContext` |
| `src/app/store-read.ts` | 只读查询集合 |
| `src/app/views/records.ts` | 记录卡片/标题/链接 |
| `src/infra/commands.ts` | 子进程命令执行与错误分类 |
| `src/infra/environment.ts` | 隔离 git 环境、worker shim、目录校验 |
| `src/infra/health.ts` | `HealthBoard` 与 `HealthEntry` |
| `src/infra/paths.ts` / `text.ts` | 路径与文本工具 |

## 11. 应用层修改建议

- **新增副作用**：定义 kind → 注册 handler → 在事务内 `enqueue`；不要在 Engine 内 await。
- **新增 HTTP 路由**：先加 `api.ts` 类型 → `http.ts` 路由 → `views` → 面板 fetch。
- **新增设置块**：`policy.ts` Schema → `Settings.BLOCKS` → `api.ts` → 面板表单 → 迁移/历史。
- **新增工具**：`tools/*.ts` → `Sessions.tools` 注册 → Prompt 说明 → 测试。
- **任何跨重启状态**：写 SQLite/KV，不要只放内存。
