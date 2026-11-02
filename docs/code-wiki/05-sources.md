# 05 · 来源层（Sources）

> 来源层负责“把外部世界的消息翻译成领域对象 `Trigger`”。它不认识工单、不做决策，只做三件事：读懂配置、读消息、写回消息。
>
> 关键文件：[kind.ts](file:///workspace/src/sources/kind.ts)、[registry.ts](file:///workspace/src/sources/registry.ts)、[host.ts](file:///workspace/src/sources/host.ts)、[github.ts](file:///workspace/src/sources/github.ts)、[feishu.ts](file:///workspace/src/sources/feishu.ts)。

## 一句话结论

一个 Source = **一个 `SourceKind` 描述符** + **一份实例配置** + **若干后台循环**。`SourceRegistry` 统一保管所有描述符，`SourceContext` 是发给每个 Source 的“受限遥控器”，只能操作自己的线程、自己的健康位。

## 1. 三个核心概念

| 概念 | 是什么 | 类比 |
| --- | --- | --- |
| `SourceKind` | 某种来源的“插件说明书”：怎么校验配置、怎么画设置表单、怎么发消息、怎么读上下文 | 一个硬件驱动 |
| `SourceInstance` | 说明书 + 具体配置（如监听哪个仓库、哪个飞书群） | 插上驱动的一块设备 |
| `SourceContext` | 运行时发给 Source 的能力集合，全部经过白名单裁剪 | 只开必要权限的门禁卡 |

## 2. `SourceKind` 契约（[kind.ts](file:///workspace/src/sources/kind.ts)）

这是接入新来源时唯一需要实现的接口。逐字段说明：

| 字段 | 必填 | 作用 | 缺省行为 |
| --- | --- | --- | --- |
| `kind` | 是 | 稳定 ID，同时作为实例 ID（如 `github`、`feishu`） | — |
| `title` / `description` | 是 | 面板上的中英文名称与说明 | — |
| `schema` | 是 | zod schema，校验存储配置并补默认值 | — |
| `fields` | 是 | 面板配置表单的字段描述 | — |
| `health` | 是 | 本来源独占的健康位名称，其他部分不得占用 | — |
| `scope(meta, config)` | 否 | 判断一条消息是否**收听**、是否**观察** | 不实现 = 收全部、不观察 |
| `channel` | 否 | 出站适配器（`send` / `link` / 可选 `allowed`） | 不发消息、不检查地址 |
| `threadContext` | 否 | 评估期读取线程上下文（消息、根消息、父消息、图片） | 不提供上下文 |
| `policy` | 否 | 该来源的准入策略片段（允许名单、准入表行、名单同步） | 无独立策略 |
| `environment` | 否 | 注册给执行器的环境变量及取值函数 | 无变量 |
| `find` | 否 | 把搜索词映射到线程 key / 触发 ID | 搜不到 |
| `repliesTo` | 否 | 从 Trigger 推导它回复的是哪条 Trigger | 不推导 |
| `facts` | 否 | 面板展示的只读状态（如当前账号） | 无 |
| `refreshLabels` | 否 | 刷新可读名称（如群名）并写入 `KV.sources.labels(kind)` | 不刷新 |

### 收听 vs 观察（`ScopeResult`）

- `listened`：这条消息**要不要进系统**。为 false 时 `Intake` 直接记 `filtered`，不产生评估。
- `observed`：即使没人 @ 机器人，这条消息是否也算“仓库/群里的动静”，可以作为**推断候选**交给评估。
- `reason`：拒绝原因（`source_disabled`、`source_not_installed`、`chat_not_allowed` 等），只作审计与提示。

这个二元区分是整个准入模型的基础：**收听决定“能不能看见”，观察决定“看不看得懂”**，能否成为工单还要再过 Policy 的准入矩阵。

### 配置字段类型（`FieldSpec`）

`switch` / `select` / `number`（带 min/max）/ `text`（可带正则 `pattern`、`choose` 下拉来源、`readonly`）/ `fact`（只读展示）/ `rows`（可编辑记录表，首列作 key）。`advanced: true` 会把字段折叠到“高级”区。

## 3. `SourceHost` 与 `SourceContext`（[host.ts](file:///workspace/src/sources/host.ts)、[source-context.ts](file:///workspace/src/app/source-context.ts)）

`SourceHost` 只有两个能力：

```ts
interface SourceHost {
  readonly sources: SourceRegistry
  context(kind: { kind: string; health: readonly string[] }): SourceContext
}
```

`SourceContext` 是实际可用的全部能力，按职责分组：

| 分组 | 方法 | 说明 |
| --- | --- | --- |
| 生命周期 | `ready`、`configured()`、`problem`、`deployment` | 等 setup 完成；未配置时 Source 应暂停 |
| 配置 | `config<C>(kind)` | 仅在实例 enabled 时返回配置，否则 `undefined` |
| 入站 | `receive(trigger)` | 交给 Engine，并安排下一次评估；调用方应 await 后再推进游标 |
| 事务 | `atomic(work)` | Store 的 savepoint 包装 |
| 状态 | `state.get/set/keys` | 来源私有 KV（游标、已读集合、群名缓存） |
| 线程 | `threads.get/subscribed/describe/patch` | 只能读、只能描述、只能改 `meta` |
| 工单 | `tickets.get/open/bindThread/threadClosed` | 只暴露绑定与关闭，不能改工单状态 |
| 触发 | `triggers.get/latest` | 只读 |
| 出站 | `notify(message)` | 交给 Outbox，按渠道规则发送 |
| 健康 | `report(entry, health)` | 只能写本 kind `health[]` 里声明的位，写别的直接抛错 |

设计意图很明确：**Source 不能直接摸 Store、不能直接调 Engine 业务方法**，只能通过这层窄接口。`sourceContextOf` 还把健康位绑定到“当前这次注册”，插件卸载后旧引用写入会变成空操作。

### 健康文案

`HEALTH_TEXT` 固定为英文模板（`{name}` 占位），面板按界面语言把 `code` 本地化。当前模板：`setupPending`、`sourceOff`、`feishuCliUnset`、`feishuBotMissing`、`pollFailures`。`health(state, code, values)` 生成 `{ state, detail, code, values, at? }`。

## 4. `SourceRegistry`（[registry.ts](file:///workspace/src/sources/registry.ts)）

Registry 同时是 Engine 的 `SourceScope` 实现。主要方法：

| 方法 | 作用 |
| --- | --- |
| `register(kind)` | 注册描述符，抢占 `health[]` 健康位，返回注销函数 |
| `healthEntries(names)` | 取当前有效健康位（已注销的不会出现） |
| `kind(id)` / `instance(id)` / `instances()` | 查描述符 / 实例 / 全部实例（含未安装的“孤儿”配置） |
| `validate(id, value)` | 用 kind 的 schema 校验实例配置 |
| `validatePolicy(parts)` | 校验各来源的 policy 片段；`admission` 交给共享的准入表 schema |
| `policyPart(id)` | 取回校验后的 policy 片段（失败时退回默认值） |
| `channelAllowed(channel)` | 实例启用且 `channel.allowed` 通过才允许回复 |
| `declarations()` / `environments()` | 声明全部变量 / 取已启用实例的变量取值 |
| `send(message, commands)` | 通过 kind 的 channel 幂等发送；未安装 → `waiting`，无 channel → `gone` |
| `link(channel, links)` | 生成展示用链接 |
| `find(query)` | 汇总所有 kind 的搜索结果并去重 |
| `repliesTo(trigger)` | 推导回复关系 |
| `threadContext(trigger)` | 构造绑定当前配置的 `TriggerContext` |
| `scope(input)` | 实现 `SourceScope`：kind 未安装且已存配置 → 不听；实例停用 → 不听；否则问 kind |

两个容易忽略的细节：

1. `resolve()` 用 `safeParse` 兜底：存储配置校验失败时**退回 schema 默认值并禁用实例**，避免坏配置把进程带崩。
2. `instances()` 会保留“配置还在、插件没装”的孤儿实例，面板仍能展示，防止升级时丢配置。

## 5. GitHub Source

文件分工：[github.ts](file:///workspace/src/sources/github.ts)（描述符与轮询循环）、[github-trigger.ts](file:///workspace/src/sources/github-trigger.ts)（消息规范化）、[github-read.ts](file:///workspace/src/sources/github-read.ts)（只读检查与 CI）、[github-pull.ts](file:///workspace/src/sources/github-pull.ts)（PR 读取）、[github-channel.ts](file:///workspace/src/sources/github-channel.ts)（出站）。

### 配置

`GithubAccountsSchema` 扩展而来：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `repository` | — | `owner/name` |
| `cli` | — | 智能体账号的 `gh` 包装脚本 |
| `pollSeconds` | 60（60~3600） | 轮询间隔；GitHub 要求的更长间隔优先 |
| `failuresBeforeError` | 3（1~20） | 连续失败多少次才报异常 |
| `observeIssues` / `observePulls` / `observeComments` / `observeCi` | 全 `false` | 是否接收没人 @ 的动静 |

### 四条轮询通道

1. **通知**（`pollNotifications`）：拉取智能体账号的通知，`subject.url` 解析出仓库 Issue/PR 编号，只处理本仓库；`x-poll-interval` 决定下一次间隔（下限 60 秒）。失败的条目会记进重试表，下一轮先重试，24 小时仍失败则放弃（仅记在线程上）。
2. **仓库级事件流**（`pollRepository` + `readStream`）：`issues?state=all`（含 PR）、`issues/comments`、`pulls/comments`。按 `since` 增量读，游标用 `cursorAt` 回退 5 秒，靠 Trigger ID 去重。游标不动时带 `If-None-Match` 走 HTTP 304，不消耗速率。
3. **默认分支 CI**（`pollBranchCi`，也在 `pollRepository` 内）：首次观察建立基线，之后只在失败集合发生变化时产生 Trigger；关闭观察时保留 revision 计数、清空失败基线。
4. **工单 PR 与订阅线程**：`pollTicketPulls` 读已开工单关联的 PR；`pollThreads` 对已订阅 Thread 逐个拉取讨论、评论、检查，窗口 14 天。

失败处理：单次失败静默重试；连续 `failuresBeforeError` 次才 `report('github', pollFailures)`。HTTP 410（Gone）视为删除，不记失败；404 仍重试（可能是私有仓库权限被撤销）。线程读取失败写 `meta.pollError`。

### Trigger 规范化（[github-trigger.ts](file:///workspace/src/sources/github-trigger.ts)）

| 工厂 | 来源 | 关键字段 |
| --- | --- | --- |
| `issueTrigger` | 新 Issue | `meta.kind='issue'`、`number`、作者是否在名单 |
| `pullTrigger` | 新 PR | `meta.kind='pull'`、`isPr` |
| `commentTrigger` | 会话/内联/评审评论 | `meta.kind='conversation' \| 'inline' \| 'review'` |
| `branchCiTrigger` | 默认分支 CI 变化 | `meta.ci=true`、`branch` |
| `ciTrigger` | 某次提交的 CI | `meta.ci=true` |

要点：

- `githubChannel(number, url?)`：回复地址固定为 `github:<number>`，`url` 指向评审线程时回复落到对应讨论。
- `isHumanLogin`：登录名不以 `[bot]` 结尾且 `type` 缺失或为 `User` 才算人；机器人账号即使以普通用户身份运行也算“非人”，只能作推断候选。
- `mentions(login, text)` 判断是否 @ 智能体。
- `reviewPlace` 把内联评论整理成 `path:line` + diff 片段。
- `githubAddress` 严格校验 URL 属于本仓库，避免跨仓库注入。

### 策略

`policy.schema`：`allowed[]`（可发起工作的账号）、`bots[]`（评论可成为候选的机器人）。`policy.rows()` 生成准入表的四行：新 Issue、新 PR、评论、默认分支 CI。CI 没有发送者，所以只有“名单外且未 @”这一格有意义。

### 执行环境变量

| 变量 | 含义 |
| --- | --- |
| `DSH_SUPERAGENT_GITHUB_REPOSITORY` | 监听仓库 |
| `DSH_SUPERAGENT_GITHUB_ACCOUNT` | 智能体账号 |
| `DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL` | 提交邮箱（git 无身份时用） |
| `DSH_SUPERAGENT_GITHUB_NUMBER` | 工单来源 Issue/PR 编号 |
| `DSH_SUPERAGENT_GITHUB_PR_HEAD` | 来源 PR 的 `refs/pull/<n>/head` |

分支名最后一段等于 `DSH_SUPERAGENT_NAME` 时，智能体开的 PR 会自动关联到工单——这是执行器识别“我干的活”的约定。

### 插件入口

```ts
export const name = 'dsh-superagent-github'
export const inject = ['orchestrator']
export function apply(ctx: Context) {
  ctx.effect(() => ctx.orchestrator.sources.register(githubKind), 'github: source kind')
  ctx.effect(() => { /* 启动 watch(source, signal)，错误转健康位；返回时 abort */ })
}
```

注意 `watch` 的 rejection 被显式转成健康位——因为**未捕获的 Promise 拒绝会直接杀掉 DSH 进程**。

## 6. 飞书 Source

文件分工：[feishu.ts](file:///workspace/src/sources/feishu.ts)（描述符与策略）、[feishu-loops.ts](file:///workspace/src/sources/feishu-loops.ts)（三条后台循环）、[feishu-trigger.ts](file:///workspace/src/sources/feishu-trigger.ts)（事件规范化）、[feishu-read.ts](file:///workspace/src/sources/feishu-read.ts)（上下文读取）、[feishu-channel.ts](file:///workspace/src/sources/feishu-channel.ts)（出站）、[feishu-image.ts](file:///workspace/src/sources/feishu-image.ts)（图片）。

### 配置

`FeishuBotSchema` 扩展：`cli`（只允许机器人身份的 `lark-cli`，要求 strict mode bot）、`chats[]`（`chatId` + `listen: mentions|all`）、`directMessages`（默认 true）、`otherChats`（`none|mentions`）、`readPageSize`（默认 20，1~50）、`linkTimeoutMs`（默认 5000，1~90000）。

### 三条后台循环（`runFeishu` = `allSettled([watch, backfillLoop, chatNamesLoop])`）

| 循环 | 频率 | 作用 |
| --- | --- | --- |
| `watch` | 常驻 | `lark-cli event consume im.message.receive_v1 --as bot` 实时消费事件；45 秒内未 ready 视为失败；Source 关闭后 5 秒内停掉 |
| `backfillLoop` | 60 秒一轮 | 按群补收历史消息与话题回复；首轮只记录游标；每群游标推进到 `cursorAt(started)` |
| `chatNamesLoop` | 60 秒 | `im +chat-list` 刷新群名缓存，失败静默（群名只是展示辅助） |

`consumerRetry(previous, ranMs)`：上次运行 ≥60 秒则 1 秒后重启，否则指数退避到最多 60 秒。

### 事件与历史的归一化

所有路径（实时事件、历史 API、话题分页）最终都变成同一种事件形状，再由 `feishuTrigger` 产出 Trigger：

- `feishuTriggerId(messageId)` 确定性 ID（`key('feishu', messageId)`），保证不同读取路径的同一消息去重。
- 机器人自己发的消息直接丢弃。
- `addressed`：私聊 = `direct`，被 @ = `mention`，否则不设。
- `withMentionNames` 把 `@_user_1` 之类的占位替换成真实名字。
- `feishuTime` 兼容两种时间格式：纪元毫秒字符串 / 本地时间字符串。
- `historyEvent` 与 `topicEvent` 分别把历史消息、话题消息适配成实时事件 schema；话题消息缺 `root_id` 时回退到根消息。

### 历史补收的细节

`backfillChat`：

1. 先按 `chat` 容器扫 `[since, until)`，升序分页，`page_size=50`。
2. 记录每个话题的最后活跃时间；超过 14 天且没有仍被轮询的订阅线程时才遗忘。
3. 再逐个话题扫 `thread` 容器。
4. 分页不前进（`has_more` 但 `page_token` 重复/为空）直接抛错，宁可不完整也不静默截断。

### 订阅线程轮询

`pollThread` 以保留的源消息为锚点，从 `feishu/<triggerId>/thread` 读取；首次轮询把 root/parent 标记为已读，避免历史上下文被当成新触发；读到已知消息且已初始化时停止翻页。

### 策略与名单同步

`policy.schema`：`allowed[]`（能发起工作的用户 open_id）、`syncChat`（从群成员同步名单）、`bots[]`（消息可成为候选的机器人）。

`sync.run` 调 `im +chat-members-list --page-all`，若返回不完整（`has_more` 或 `truncations`）就抛错。为保证策略版本哈希稳定，**保留原有成员顺序**，只原地更新名字、追加新成员。

### 出站

`sendFeishu` 用 `im +messages-reply --reply-in-thread --idempotency-key <message.id>`。若飞书返回 230011 / withdrawn / 2300 段 not found，判定目标消息已撤回，返回 `'gone'`（不再重试）；其余错误抛出，交给 Effects 退避重试。

`feishuChannel` 显式记录 `direct`，因为群聊和私聊的 chat id 都以 `oc_` 开头，单看 ID 分不出来。

## 7. 共享轮询工具（[poll.ts](file:///workspace/src/sources/poll.ts)）

| 名称 | 作用 |
| --- | --- |
| `POLL_HORIZON_MS` | 14 天。无活跃工单的订阅线程只在这个窗口内继续轮询 |
| `polled(ctx, thread, now)` | 有活工单，或最近活动/结束在窗口内 → 继续轮询 |
| `cursorAt(started)` | 游标回退 5 秒，容忍迟到事件；靠确定性 Trigger ID 去重重叠部分 |
| `pollThreads(ctx, source, stopped, poll, skip)` | 遍历订阅线程逐个轮询；成功清 `pollError`，失败写 `pollError` |
| `pause(ms, signal)` | 可中断等待，使用全局 `setTimeout` 以兼容测试假定时器 |

## 8. 评估期上下文（[admission-context.ts](file:///workspace/src/sources/admission-context.ts)）

`admissionContext(context, commands, maxPages)`：

- 最多读 `maxPages` 页线程消息，去重，检测分页游标重复（重复即抛错）。
- `threadWindow(messages, sourceId)` 选“前 5 条 + 触发点前后各 5 条”，并记录每段被省略的条数；计数只描述**已加载的快照**，不代表历史总量。
- 返回 `{ messages, window, complete, next, status }`，`status` 可能是 `chat_neighbours` 这类回退模式。

这是给模型研判的“证据包”，页数与超时由 `LIMITS` 中的 `admissionContextMaxPages`（1~100）与 `admissionContextTimeoutMs`（1~90 秒）控制。

## 9. 接入一个新来源：最小步骤

1. 新建 `src/sources/<name>-trigger.ts`：定义确定性 Trigger ID、`ChannelRef`、事件 schema 与 `trigger()` 工厂。
2. 新建 `src/sources/<name>.ts`：实现 `SourceKind`（`schema`、`fields`、`health`、可选 `scope`/`channel`/`threadContext`/`policy`/`environment`）。
3. 建后台循环，通过 `SourceContext.receive()` 入站；游标写 `SourceContext.state`。
4. 在 Cordis 插件里 `sources.register(kind)`，并 `ctx.effect` 管理循环的 abort/dispose。
5. 在 `package.json` 与 `tsdown.config.ts` 增加入口（若作为独立 watch 插件）。
6. 补测试：trigger 归一化、scope 判定、分页、去重、失败健康位。

## 10. 常见误解

- **Source 不是“连接器”**：它不维护长连接语义，飞书的实时消费也是外部 CLI 子进程，断线由循环重启兜底。
- **`scope` 不是权限**：它只决定消息是否进入系统与是否算观察；真正的“谁能发起工作”在 Policy 准入矩阵。
- **`checkpoint/revision` 这类 KV 不是缓存**：它们是正确性的一部分（去重、基线），丢失会导致重复触发或漏触发。
- **别在 Source 里直接改工单**：接口故意没有暴露；要改状态只能经 `Engine`。
