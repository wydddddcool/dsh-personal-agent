# 03 · 领域内核 Engine

> 对应源码：`src/core/engine.ts`、`part.ts`、`intake.ts`、`evals.ts`、`tickets.ts`、`assignments.ts`、`replies.ts`、`ports.ts`、`model.ts`。

## 1. 设计要点

`Engine` 是领域层**唯一的写入口**。所有对 Trigger、Thread、Decision、Ticket、Assignment 的修改都必须经过它；每个公开方法内部用 `repo.atomic(...)` 包成一个同步事务。

它把复杂逻辑拆成五个内部 part：

| Part | 职责 | 主要数据 |
| --- | --- | --- |
| `Intake` | 接收 Trigger、去重、scope 过滤、Thread 相关、订阅扇出、排队评估 | Trigger、Thread、TriggerDisposition |
| `Evals` | Gate 准入、评估生命周期、决策记录、接受建单 | Evaluation、Decision、Mandate |
| `Tickets` | 工单创建/结束/恢复、附件、输入、订阅、策略变化 | Ticket、Thread |
| `Assignments` | 派工生命周期、输入投递、报告处理 | Assignment、Report、Attention |
| `Replies` | 按用途向 Outbox 排队回复，幂等 | OutboundMessage、Reply |

Part 之间不直接跨层调用，而是通过 `Engine` 注入的兄弟 part 在同一个事务内协作。

## 2. Engine 公开方法

### 2.1 Sources 调用

| 方法 | 作用 | 返回 |
| --- | --- | --- |
| `receive(trigger)` | 接收一条 Trigger：去重、过滤、写 Thread、扇出、排队评估 | `'stored' \| 'duplicate' \| 'filtered'` |
| `bindThread(ticketId, thread, own)` | 让工单跟随某个 Thread（如自己开的 PR） | `Ticket` |
| `threadClosed(thread, outcome, at)` | 标记 Thread 关闭（merged/closed），可能结束工单 | `void` |

### 2.2 时钟调用

| 方法 | 作用 |
| --- | --- |
| `evaluateDue()` | 处理过期 Eval、启动等待中的评估、恢复暂停期间到达的工单 |

### 2.3 主 Session 调用

| 方法 | 作用 |
| --- | --- |
| `candidate(triggerId)` | 查看持有该 Trigger 的评估候选 |
| `decide(triggerId, outcome)` | 记录 accept/stop/ignore/unavailable；accept 会建单 |
| `attach(ticketId, triggerId, note?)` | 把消息挂到指定工单并结束相关评估 |
| `requestStatus(ticketId)` | 仅对 `waiting` 状态的 worker 请求状态 |
| `reply(request)` | 按用途排队回复（ack/answer/result/attention） |
| `candidateDelivered(evalId)` | 候选送达 Assessor，开始计算截止时间 |
| `note(ticketId, text)` | 主 Session 给工单补充上下文（不授予权限） |

### 2.4 人（面板/主 Session）调用

| 方法 | 作用 |
| --- | --- |
| `reevaluate(triggerId)` | 重新评估某条 Trigger |
| `dismiss(decisionId)` | 忽略某个 unavailable 问题 |
| `unsubscribe(thread)` | 删除某 Thread 上所有工单订阅 |
| `stopTicket(ticketId, reason?)` | 人停止工单，撤销授权 |
| `retryTicket(ticketId)` | 重试 blocked/failed/投递失败的工单 |

### 2.5 Executor 调用

| 方法 | 作用 |
| --- | --- |
| `assignmentStarted(ticketId, assignmentId)` | 派工开始，投递等待中的 Input |
| `inputsDelivered(ticketId, assignmentId, ids)` | 输入已送达 |
| `inputsRead(ticketId, ids)` | worker 的 Session 已把消息纳入一轮 |
| `turnEnded(ticketId, assignmentId)` | 一轮结束 |
| `deliveryFailed(ticketId, assignmentId, error)` | 输入投递失败 |
| `markUnrelated(ticketId, thread, reason)` | worker 判定某 Thread 与本工单无关 |
| `followForContext(ticketId, thread)` | 只读跟随某 Thread 作为上下文 |
| `handback(ticketId, triggerId, reason)` | worker 交回不属于本工单的消息 |
| `report(ticketId, report)` | 记录报告，可能触发结束/等待/问题 |
| `assignmentInterrupted(ticketId, assignmentId)` | 宿主停止后恢复派工 |

### 2.6 Settings 调用

| 方法 | 作用 |
| --- | --- |
| `policyChanged(from, to, effects)` | 通知工单与进行中的评估策略已变化 |

## 3. 角色化接口（最小权限）

调用方拿到的不是完整 Engine，而是 `Pick` 后的窄接口：

| 类型 | 允许的方法 | 调用方 |
| --- | --- | --- |
| `EngineForSources` | `receive`、`bindThread`、`threadClosed` | Source 插件 |
| `EngineForMainSession` | `candidate`、`candidateDelivered`、`decide`、`attach`、`reply`、`requestStatus`、`note` | 主 Session 工具 |
| `EngineForPeople` | `stopTicket`、`retryTicket`、`reevaluate`、`unsubscribe`、`dismiss` | 面板 HTTP |
| `EngineForSettings` | `policyChanged` | Settings |
| `EngineForExecutor` | 执行相关 11 个方法 | DshExecutor |

这种设计让“谁能改什么”在编译期就受限，而不是只靠约定。

## 4. 端口（Ports）

`src/core/ports.ts` 定义核心依赖的外部能力：

| 端口 | 作用 | 实现 |
| --- | --- | --- |
| `Repositories` | 同步持久化接口：triggers/threads/tickets/decisions | `src/app/store.ts`、`src/core/memory.ts` |
| `Policy` | `gate`、`revalidate`、`admitsInferred`、`evalTimeoutMs` | `src/policy.ts` |
| `SourceScope` | 判断某来源是否监听某 Trigger | `SourceRegistry` |
| `Assessor` | `request(candidate)`、`release(evalId)` | `MasterAssessor` |
| `Executor` | `start`、`deliver`、`stop` | `DshExecutor` |
| `Outbox` | `send`、`status`、`withdraw` | `src/app/outbox.ts` |
| `DomainEvents` | 领域事件类型表 | Runtime 订阅 |

关键类型：

- `GateResult`：`{admissible:false, reason}` 或 `{admissible:true, strength, basis}`。
- `ScopeResult`：`{listened:true, observed, row?}` 或 `{listened:false, reason}`。
- `AssessmentOutcome`：`ignore | unavailable | accept | stop`。
- `Candidate`：评估者能看到的边界事实，不含权限。
- `OutboundMessage`：`id/channel/text/kind/ticketId?`。

## 5. 五个 part 的关键行为

### 5.1 Intake

`receive(trigger)` 的步骤：

1. `isoTime` 归一 `at`。
2. 必须有至少一个 Thread。
3. 按 `trigger.id` 去重；已存在返回 `duplicate`。
4. `scope.scope(trigger)`：不监听则保存并写 `filtered` disposition，返回 `filtered`。
5. 保存 Trigger；对每个 Thread 更新 `lastAt`、`correlated`。
6. 对每个订阅工单：
   - 已结束的工单只有在“人的消息 + 非 context 订阅 + 不是人停止”时才恢复；
   - 其余写入 `TicketInput`。
7. 写 `TriggerDisposition`：`fanout`、`context`。
8. 如果没有工单 owner，`queueForEval`。
9. `wake` 所有扇出到的工单。
10. 发出 `trigger.received`。

### 5.2 Evals

关键概念：

- `due(thread, policy)`：处理进行中的评估——暂停时顺延 deadline；超时则重排或产生 `unavailable`。
- `start(threadKey, policy)`：把 `pending` 的 Trigger 并批，经 Gate 选出最强 primary。
- `decide(triggerId, outcome)`：记录 Decision；accept 时创建 Mandate + Ticket。
- `reevaluate` / `handback` / `dismiss` / `withdraw` / `routed` / `policyChanged` / `reassess`。

重试策略：`REQUEUES = 2`，第三次超时直接 `unavailable`。

### 5.3 Tickets

关键方法：

| 方法 | 说明 |
| --- | --- |
| `create` | 从 accept 结果建 Ticket，设置 `origin`、`mandate`、`channels` |
| `bind` | 绑定 Thread，`own` 表示工单自己开的 |
| `threadClosed` | 记录关闭；满足 `followsDone` 时结束 |
| `followsDone` | 判断跟随的 Thread 是否全部关闭 |
| `attach` | 把 Trigger 作为 Input 挂到工单 |
| `requestStatus` | 只对 waiting 的 worker 发请求 |
| `stop` / `retry` | 人的停止/重试 |
| `markUnrelated` | 删除该工单对某 Thread 的订阅 |
| `policyChanged` | 把策略影响写成 Input |
| `addInput` / `wake` | 追加输入 / 恢复工单 |
| `end` | 结束工单，处理 letGo/readBefore |
| `note` | 主 Session 备注 |
| `followForContext` | 只读订阅 |
| `subscribe` | 新决策重新订阅 |

### 5.4 Assignments

| 方法 | 说明 |
| --- | --- |
| `started` | Assignment → running，投递等待输入 |
| `delivered` | 记录输入送达，清除投递失败 |
| `read` | 记录 worker 已读取 |
| `turnEnded` | 记录 `idleAt` |
| `deliveryFailed` | 记录 `ticket.delivery` |
| `interrupted` | 宿主停止后的恢复；写 `RECOVERY_NOTE` |
| `report` | 处理 attention/answers/blocked hold/ready 结束 |

报告状态语义：

| Report | 领域影响 |
| --- | --- |
| `progress` | 仅更新，不结束 |
| `waiting` | 工单进入 idle，等待输入 |
| `ready` | 进入 `person/review`；按 `followsDone` 决定是否结束 |
| `blocked` | 进入 `person/blocked`，暂停自动输入直到人来 |
| `failed` | 进入 `person/failed`，可人工重试 |
| `dropped` | 结束工单（`dropped`） |

### 5.5 Replies

回复按用途有不同规则：

| Purpose | 目标渠道 | 约束 |
| --- | --- | --- |
| `acknowledgement` | 触发消息所在渠道 | 必须是人的消息、工单未结束、非 context 线程 |
| `answer` | 人的问题所在渠道 | 必须对应一个已报告的回答 |
| `result` | 工单起始会话 | 仅 `ready`/`completed`/`merged`/`dropped` |
| `attention` | 提问消息所在渠道 | 必须匹配当前 open question |

幂等 ID：`ack:<triggerId>`、`reply:<triggerId>:<text>`、`attention-reply:<attentionId>`。

## 6. 事件

`EngineOptions.emit` 发出的事件由 `Runtime` 转成通知/中继：

| 事件 | 用途 |
| --- | --- |
| `trigger.received` | 主 Session 收到新消息通知 |
| `eval.started` / `decision.recorded` | 审计与展示 |
| `ticket.created` / `ticket.ended` / `ticket.resumed` | 工单生命周期 |
| `assignment.started` / `assignment.ended` | 执行进度 |
| `thread.subscribed` / `thread.unsubscribed` | 订阅变化 |
| `trigger.requeued` / `trigger.followup` | 重新评估 / 人的后续消息中继 |
| `policy.changed` | 策略版本变化 |

## 7. 辅助模块

| 模块 | 内容 |
| --- | --- |
| `model.ts` | 类型、状态判定、`followupOwners`、`reached`、`waitsForPerson` |
| `stage.ts` | `ticketStage`、`canRetry` |
| `errors.ts` | `UserError` 与 47 个错误码 |
| `reasons.ts` | `REASONS` 理由模板、`reasonText` |
| `ids.ts` | `key(...)` 生成稳定短 ID |
| `memory.ts` | `MemoryRepositories`，测试用内存仓库 |

## 8. 修改领域逻辑的检查清单

1. 新字段先加到 `model.ts`，再改 `store` 的列/迁移。
2. 新状态转换必须有唯一入口（某个 part 的方法），并由 `Engine` 暴露。
3. 跨聚合操作放进同一个 `Engine` 方法，保证单事务。
4. 需要异步副作用时，只通过端口排队，不在事务里直接 await。
5. 新增对外能力时，优先加到角色化 `Pick` 接口，而不是暴露完整 Engine。
6. 同步更新 `views`、`client` 类型、测试与 `docs/001`。
