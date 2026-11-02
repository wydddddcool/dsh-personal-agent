# 06 · 执行器（Executor）

> 执行器把“工单派工”变成真实的 DSH worker Session：准备目录、启动会话、投递消息、监听事件、收敛后台任务、把结果回报给 Engine。
>
> 关键文件：[dsh.ts](file:///workspace/src/executor/dsh.ts)、[background.ts](file:///workspace/src/executor/background.ts)、[sessions.ts](file:///workspace/src/app/sessions.ts)。

## 一句话结论

`DshExecutor` 是 `Executor` 端口的唯一实现。它**不决定该不该派工**，只负责把已派出的 `Assignment` 安全地跑起来，并在任何意外（网络抖动、进程重启、后台任务失控）下保持可恢复。

## 1. `Executor` 端口（[ports.ts](file:///workspace/src/core/ports.ts)）

```ts
interface Executor {
  start(ticket: Ticket, assignment: Assignment): void           // 排队启动
  deliver(ticket: Ticket, assignment: Assignment): void         // 投递待处理输入
  stop(ticket: Ticket, assignment: Assignment, reason: string): void
}
```

端口只有三个方法。`prepare(ticket, outcome)` 属于 `DshExecutor` 的扩展能力，Runtime 以 `EngineOptions.prepareTicket` 回调的形式交给 Engine（[runtime.ts](file:///workspace/src/app/runtime.ts#L138)），用来补全 `execution` 元数据。

顺序是：**评估接受 → Engine 建工单与派工（期间调 `prepareTicket`）→ `start` 入队 → Effects 消费 launch → worker 跑起来**。`deliver` 只负责把 `ticket.undelivered` 里的输入喂给已在运行的会话，不负责启动。

## 2. `DshExecutor` 的结构

### 依赖（`ExecutorHost`）

| 依赖 | 用途 |
| --- | --- |
| `context: Context` | Cordis 上下文：`agents`、`subprocess`、事件总线 |
| `engine: EngineForExecutor` | 回报 `assignmentStarted / inputsDelivered / inputsRead / turnEnded / deliveryFailed / report / assignmentInterrupted` |
| `store` | 读工单与触发、写设置、`atomic` 与 `afterCommit` |
| `effects` | `launch` / `delivery` 两个持久副作用 |
| `health` | `worker` 健康位（后台事件处理失败） |
| `machine.stateDir` | 状态目录 |
| `lifetime: AbortSignal` | 宿主生命期 |
| `sessions` | `ensure / prompt / promptedId / relay / holds` |
| `closing() / paused()` | 停机与暂停 |
| `environment(ticket)` | 工单执行环境变量 |
| `sourceLink(trigger)` | 来源消息链接 |
| `repliedTo(trigger)` | 回复关系 |

### 关键常量

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `PREPARE_TIMEOUT_MS` | 10 分钟 | `executor.prepare` 命令的最长运行时间 |
| `TRANSIENT_TRIES` | 3 | 瞬时失败最多重试次数 |
| `TRANSIENT_BACKOFF_MS` | 15 秒 | 首次退避，之后 `15s × 2^(n-1)` |
| `BACKGROUND_LIMIT_MS` | 30 分钟 | worker 回合结束后，后台任务还能跑多久 |
| `SHUTDOWN_STOP_MS` | 10 秒 | 停机时等待后台任务停止的上限 |
| `SLOT_WAIT_MS` | 5 秒 | 无空槽或暂停时的轮询等待 |
| `ASSIGNMENT_CHARS` / `TRIGGER_CHARS` | 1500 / 600 | 内联派工与触发文本的截断长度，超出改读资源 |

### 会话命名

- `workerSessionId(ticketId) = worker-<ticketId>`
- `ticketOfSession(sessionId)`：反向解析，非 `worker-` 前缀返回 `undefined`

这是执行器识别“事件是不是我的 worker 发的”的唯一依据，简单且不会冲突。

## 3. 目录准备（`prepareDirectory`）

```
1. mkdir(dirname(directory))            // 父目录
2. 若配置了 executor.prepare：在父目录执行 sh -c <command>
   - 带上工单执行环境变量
   - AbortSignal.any([lifetime, timeout(10min)])
3. 失败 → 尝试 rmdir(directory)（只删空目录）→ 抛 PrepareFailed
4. mkdir(directory)                     // 保证目录存在
5. verifyDirectory(...)                 // 以 worker 视角验证
```

为什么 `PrepareFailed` 不自动重试：**“目录已存在”就算已准备好**。如果 prepare 命令失败后残留半成品目录，自动重试会把它当成可用工作区，结果更糟。因此失败直接标记工单 `failed`，等人工输入或显式 retry。

`ticketExecution()` 生成：

- `name`：`<worktree 名>-<ticketId 前 12 位>`（`WorktreeNameSchema` 校验）
- `directory`：`executionRoot(settings, stateDir)/name`
- `assignment`：显式请求只写路由备注；规则推断则写“Proactively accepted under <ruleIds>”+ 范围 + 规则指令

## 4. 启动流程（`launch`）

`launchQueued` 先做**幂等守卫**：工单还在、还活着、且当前派工 id 与队列里的 id 一致、状态仍是 `pending`，否则直接返回。然后 `slots.reserve(ticketId, 'launch')`，再进入 `launch`：

1. 检查 `closing / paused / 派工是否被替换`。
2. 目录不存在则 `prepareDirectory`。
3. `sessions.ensure(workerSessionId, workspace, title, 'worker')`。
4. 等待上一轮后台任务停完（`stopped`）。
5. 清掉 inbox 里残留的未投递消息（避免与本次投递重复）。
6. 组装第一条消息：
   - 第一次派工：`{ ticket_id, title, assignment, assignment_chars/read, trigger, batch, note? }`
   - 后续派工：只发增量 `{ ticket_id, assignment: n, note? }`
   - 会话丢失了第一条（`holds` 为 false）时，重新发完整版。
7. `sessions.prompt(sessionId, requestId, text, 'queue', guard, started)`，`started` 回调里调 `engine.assignmentStarted`。
8. 成功后清空该派工的瞬时失败计数。

`requestId` 规则：首次 `assignment:<ticketId>`，后续 `assignment:<ticketId>:<assignmentId>`。这保证重启或重试时不会重复投递同一条。

### 派工消息里的“批次”

一个工单可能合并多条 Trigger（`origin.triggerIds`）。`batchOf` 取除主触发外的其余触发，`batchLine` 只给 160 字预览 + `trigger/<id>` 读取路径，避免首条消息过大。

## 5. 输入投递（`deliverQueued` / `deliverInput`）

`delivery` effect 的并发上限是 4，且 `quiet: true`（失败不单独报健康位，而是记到工单上）。流程：

1. 若该工单正在停止后台任务，先等待（`stopped`），否则投递会被 cancel 吞掉。
2. 取当前运行中的派工；没有就返回。
3. 循环投递 `undelivered[0]`，每次都**重新读库**，防止中途工单结束或被新派工接管。
4. 若 worker 没在跑，先 `slots.reserve`：人类的输入用 `'person'`（额外一个槽），否则 `'wake'`。
5. 会话被外部删除时用 `sessions.ensure` 重建。
6. `deliverInput`：
   - 组装 trigger 卡片（含被回复消息的预览，若 worker 没见过）
   - `inputMessage()` 生成文本：trigger JSON / policy-changed / resumed / note / text
   - 超过 1500 字 → JSON 包裹 `{ text, chars, read }`
   - `sessions.prompt(sessionId, input.id, text, 'steer', live)`
7. 成功后 `engine.inputsDelivered(ticketId, assignmentId, [inputId])`。
8. 失败 → 若工单仍有效，`engine.deliveryFailed(...)` 后抛出，交给 Effects 退避重试。

### 五种输入

| 类型 | 内容 |
| --- | --- |
| `trigger` | 触发卡片 JSON；`context: true` 标记“只是上下文，不是给你的请求” |
| `policy-changed` | 规则被禁用/修改、不再自动接受、请求者被移出名单时的具体指令 |
| `resumed` | 工单结束后被同一线程的消息续上：先检查工作区与 PR 状态，再决定继续/交回 |
| `note` | 主 Session 的上下文备注，明确“仅参考” |
| `text` | 原样文本（状态请求、人工 retry 等） |

`reopen` 是历史类型，schema 11 迁移已把它转成 `text`，`inputMessage` 对其返回 `undefined`。

## 6. 并发控制（`WorkerSlots`）

核心规则：**一个工单占一个槽，条件是它的 worker 回合在跑，或回合结束后 shell 任务/子代理仍在跑，或正在启动**。

| 方法 | 行为 |
| --- | --- |
| `used()` | 运行中 + 启动中的去重计数 |
| `launches()` | `max - (运行中 + wake 预留)`，决定 `launch` effect 的并发上限 |
| `reserve(ticketId, by)` | 同步预留；`by === 'person'` 允许超出 `max` 一个槽；无槽抛 `Later` |
| `free(ticketId)` | 启动结束或回合已跑起来后释放 |

为什么“人”能多占一个槽：人类的追问不应排在新工单后面。这是产品层面的优先级选择。

`Later` 不是错误，而是一种**“现在不行，稍后再来”**的信号：Effects 收到后不会记为失败，也不会消耗重试次数。

## 7. 事件驱动（`install`）

执行器订阅四类 DSH 事件：

| 事件 | 处理 |
| --- | --- |
| `agent/status` | `running` → 中止“静默观察”；`idle` → 若不是被取消的子代理回合、且未停机，进入 `workerIdle` |
| `agent/inbox/claimed` | 记录“人在 worker 会话里亲手发了消息”的时间（`personal`） |
| `session/event` | 只处理 `user/message` 且来源是 `dsh-superagent` 的消息：把对应 trigger 输入标记为已读（`inputsRead`） |
| `agent/error` | 瞬时错误 → 安排退避重试；否则标 `failed` 并中继给主 Session |

`background(work)` 是统一兜底：成功时若健康位是 error 则恢复为 ready，失败则写 error。因为**未处理的 rejection 会杀进程**，所有 fire-and-forget 都必须包在这里。

## 8. 回合结束与后台收敛（`workerIdle`）

这是执行器最复杂的部分，目标只有一句：**worker 说完了，但它可能还有后台任务在跑；要么等它们自然结束，要么超时杀掉**。

流程：

1. `await agent.whenIdle()`；若正在瞬时重试则直接返回。
2. 清空该派工的瞬时失败计数。
3. 判断是否“已交接给人”：
   - 最后一次报告是 `ready`，或工单有 `attention`，且之后没有新输入；
   - 或工单本身在等人（`waitsForPerson`）。
   - 若是 → `engine.turnEnded` + `handOff`：停子代理，把 shell 任务留给“人”，并逐个收集它们的结束，下次回合再告知 worker。
4. 否则建立两个控制器：`look`（新一轮消息/派工变化会中止）与 `limit`（30 分钟超时）。
5. `untilQuiet(...)`：等所有 shell 任务与子代理安静。
6. 安静 → `engine.turnEnded`。
7. 超时 → 杀掉超限 shell 任务，提示 worker；子代理不杀（杀了会唤醒 worker）。
8. 重新读库；若已交接给人则返回。
9. 取最后一条 assistant 文本 + 超时说明，`engine.report({ state: 'waiting', summary })`；有新内容才中继给主 Session，否则若此前也没有摘要，发一条“worker 结束但没报告，请用 orchestrator_ticket_request_status”。

### `handOff` 的语义

worker 把活交给真人时（比如“请你在本地跑一下”），它的 shell 任务（例如给用户起的本地服务）**不占槽、不受并发限制**，可以一直跑；执行器只负责收集它们的结束事件，避免在槽外唤醒 worker。

## 9. 失败与恢复

### 瞬时失败（`transient`）

判定：`status` 为 408/429/5xx，或文本匹配 `ECONNRESET / ETIMEDOUT / EAI_AGAIN / fetch failed / overloaded / rate limit / socket hang up` 等。

- `retries(key, error)`：最多 3 次，超过或非瞬时则清理计数并返回 false。
- worker 回合失败：`resumeAfter` 按 `15s × 2^(n-1)` 退避，向会话投递一条“上次回合因可恢复原因失败，请继续”的消息。等待期间遇到暂停或无空槽，每 5 秒再看一次。
- 启动失败：`launchQueued` 中先 `retries('launch:<id>')`，仍失败才 `launchFailed`。

### 非瞬时失败

`failed(ticketId, summary)` 在一个事务里：

```ts
engine.report(ticketId, { state: 'failed', summary })
relay(resultRelay(updated, 'failed', summary))
```

之后工单进入 `waitsForPerson`，等人工输入或显式 `retryTicket`。

### 重启恢复（`resume`）

按 `createdAt` 升序扫描开启的工单：

- 有运行中的派工 → 取消该 worker 回合（`keepInbox: true`）、停后台任务、`engine.assignmentInterrupted`。
- 最新派工是 `pending` 且不在等人 → 重新 `start`。

保留 inbox 是为了不丢已经交接但尚未被读到的输入。

## 10. 停止（`stop` / `stopWork` / `shutdown`）

`stop` 先判断“这次派工是不是自己好好说完的”：最后报告是 `ready`/`dropped` 且之后没有新输入。若是，则不取消回合（它已经结束了）。

所有实际动作都放到 `afterCommit`：**先提交事务，再动会话**。这样事务回滚不会造成“库里还在跑、实际已停”的不一致。

`shutdown` 在 10 秒预算内：停所有已加载 worker 的后台任务（保留 inbox）、中止“留给人的任务”的收集、取消仍在跑的回合。

## 11. `background.ts` 的职责

DSH 的后台工作分两类：Session 拥有的 **shell jobs**（`ctx.jobs`）与 **subagents**（`ctx.subagents`）。

| 函数 | 作用 |
| --- | --- |
| `until(work, signal?, ms?)` | Promise 与中止/超时的竞速 |
| `runningJobs(ctx, sessionId, except?)` | 仍在跑的 shell 任务（排除指定 id），带可读名 |
| `untilQuiet(ctx, agent, signal, except?)` | 等到子代理与 shell 任务都安静，或 worker 又跑起来 |
| `killJobs(ctx, sessionId, reason, except?)` | 杀掉 shell 任务，并**先挂等待再杀**，把结束事件收走 |
| `collectJob(...)` | 收集某个“留给人”的任务的结束，最多等 10 分钟一轮 |
| `stopSubagents(ctx, agent, keepInbox?)` | 释放子代理，带上限 10 秒；必要时取消回合 |
| `stopBackground(ctx, sessionId, reason, keepInbox?)` | 组合：杀 jobs + 停 subagents，失败聚合上报 |

`cancelled`（WeakSet）与 `joins`（WeakMap）解决两个棘手问题：

- 因停子代理而被取消的回合，它的 `idle` 不应被当成 worker 正常结束；
- `waitForChildren` 不可取消，重复调用要复用同一个 Promise。

## 12. 改执行链路时的检查清单

- 新增事件订阅记得放进 `disposers`，`dispose()` 必须能清干净。
- 所有异步入口都要经过 `background()` 或显式 `.catch`，否则会杀进程。
- 任何“先改库、再动会话”的顺序，一律用 `afterCommit`。
- 新增阻塞等待要考虑 `Later` 语义与暂停/停机。
- 改并发规则时同步改 `WorkerSlots.launches()`，否则 launch effect 的并发上限会对不上。
- 别在 `stop` 里直接 cancel 一个已经自己说完的回合——会把它最后的报告打断。
