# 07 · Web 管理面板（Panel Client）

> 面板是 DSH Web 客户端里的一个**插件页面**：一个侧边栏图标 + 一个主面板 + 一个插件管理配置视图。它只读数据、发命令，不承载任何领域逻辑。
>
> 关键文件：[index.tsx](file:///workspace/src/client/index.tsx)、[app.tsx](file:///workspace/src/client/app.tsx)、[provider.tsx](file:///workspace/src/client/provider.tsx)、[route.ts](file:///workspace/src/client/route.ts)、[api.ts](file:///workspace/src/client/api.ts)。

## 一句话结论

前端是**同源轮询式 SPA**：每 5 秒拉一次 `GET /orchestrator/api/state`，各页面按需拉自己的数据；所有写操作走 `POST/PUT`，成功后 `reload()`。没有 WebSocket，也没有本地缓存层。

## 1. 入口与注册（[index.tsx](file:///workspace/src/client/index.tsx)）

```ts
export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']
export function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), '...')
  ctx.slots.inject('main', ...)                 // 主面板
  ctx.slots.inject('sidebar.panellist', ...)    // 侧边栏图标（锤子，order 10）
  ctx.slots.inject('plugins.row.config', ...)   // 插件管理页的配置卡片
}
```

- `NS = 'dshSuperagent'`：国际化命名空间。
- `PANEL_ID = 'dsh-superagent'`：面板稳定 ID。
- `configForms` 是**可选**依赖：没有它时机器配置只读（`usePageForm(...)` 返回 undefined 的处理在 `deployment.tsx`）。
- `openSession(id)` 通过 `openKnownSession` 跳到对应的 DSH 会话；`SessionNavigationError` 会被翻译成用户可读文案（`sessionListNotReady` / `sessionNotListed`）。

构建成 `client.js` 时由 tsdown 包成：

```js
window.__ModuleLoader__.load({ id: "dsh-superagent", ... })
```

这是 DSH Web 客户端的模块加载约定；`react`、`react-dom` 被标记为 external，由宿主提供。

## 2. 页面结构（[route.ts](file:///workspace/src/client/route.ts)）

### 六个 Tab

```ts
TABS = ['overview', 'source', 'trigger', 'eval', 'execution', 'settings']
```

| Tab | 页面 | 看什么 |
| --- | --- | --- |
| Overview | `overview.tsx` | 总览指标、问题清单、负载 |
| Source | `source.tsx` | 来源实例状态、健康位、丢弃回复 |
| Trigger | `thread.tsx` | 线程列表 / 线程详情（时间线） |
| Eval | `eval.tsx` | 评估决策列表与状态 |
| Execution | `execution.tsx` | 工单列表 / 工单详情 |
| Settings | `settings.tsx` | 五个设置分组 |

### 路由模型

```ts
type Route =
  | { page: 'overview' | 'source' }
  | { page: 'trigger'; id?: string; query?: { filter?: ThreadFilter; trigger?: string } }
  | { page: 'eval'; query?: { filter?: DecisionFilter; window?: '24h' } }
  | { page: 'execution'; id?: string; query?: { filter?: TicketFilter } }
  | { page: 'settings'; query: { group: SettingsGroup; source?: string; version?: string } }
```

- **列表页**无 `id`，**详情页**有 `id`。
- `parseRoute(value)` 会校验并丢弃非法筛选项，也兼容删掉的旧 tab（如 `policy`）。
- 路由记忆写在 `sessionStorage` 的 `dsh-superagent/route`，含 `route`、`stack`（返回栈）、`group`。解析失败静默回首页——路由只是便利功能，不应因坏数据白屏。
- `settingsRoute(group, query)` 与 `setupPage(place)` 把 setup 问题直接跳到对应设置分组。
- `routeLabel(t, route)` 生成面包屑文案（详情页显示“线程/工单”而不是 tab 名）。

### 筛选项

| 常量 | 取值 |
| --- | --- |
| `TICKET_FILTERS` | `open / person / working / idle / ended` |
| `THREAD_FILTERS` | `subscribed / evaluating / recent / all` |
| `DECISION_FILTERS` | `work / stop / ignore / unavailable / all` |
| `DECISION_KINDS` | 把 UI 筛选映射成后端 `kind` 参数（`work → accept,reopen`） |
| `SETTINGS_GROUPS` | `source / eval / execution / prompts / deployment` |

## 3. 数据层（[api.ts](file:///workspace/src/client/api.ts)）

### `api()` 与 `ApiError`

所有请求都打到 `/orchestrator/api/<path>`，并带：

```ts
headers: { 'x-orchestrator-request': '1' }
```

这个头是宿主的同源校验标记。请求失败时按优先级解析错误：

1. 有 `setup` → 生成 setup 问题文案；
2. 有结构化 `code`（`USER_ERRORS` 里的用户错误码）→ 按码翻译；
3. 有 `error` 字符串 → 原样；
4. 空 body + 404 → “host 未运行”（**重启期间 DSH 会先卸载路由**，不能当成“记录不存在”）；
5. 5xx → 服务器错误；
6. 其余 → 请求失败。

`ApiError` 关键属性：

- `issues`：字段级校验错误
- `missing`：`404 && !unreachable`，才能判定“记录真的不存在”
- `details.unreachable`：网络层失败或空响应

### `caller(messages)`

类型安全的路由调用器：

```ts
call('GET tickets/:id', { id })
call('PUT settings/:block', { block, body, revision })
```

运行时把 `:id` 用 `encodeURIComponent` 替换，把 `query` 过滤掉 `undefined` 与空字符串后拼成查询串，`body` 走 JSON。

`Api` 契约定义在 [app/api.ts](file:///workspace/src/app/api.ts)，是**纯类型文件**：前端 import 它不会把宿主代码打进 bundle。

### `usePoll(load, deps, intervalMs = 5000)`

轮询 Hook，细节值得记住：

- **串行化**：用 Promise 链把请求排队，手动 `reload()` 一定排在当前轮询之后。
- **保留旧值**：依赖变化或出错时不丢上一次成功的 `data`。
- **响应去重**：`JSON.stringify` 相同则不触发 setState（减少无意义重渲染）。
- **页面隐藏降频**：`document.hidden` 时把间隔乘以 `HIDDEN_FACTOR = 6`（5 秒 → 30 秒）。
- **可见即刷新**：监听 `visibilitychange`，回到前台立刻拉一次。
- **丢弃过期响应**：依赖变化会重建订阅，旧的 `active` 标记阻止写入。

`usePoll` 只负责轮询，不做错误 UI；错误由各页面决定展示方式。

## 4. 全局上下文（[provider.tsx](file:///workspace/src/client/provider.tsx)）

两个 Context：

| Context | 内容 |
| --- | --- |
| `PanelContext` | `t`、`call`、`navigate`、`back`、`backLabel`、`openSession`、`notify`、`restart` |
| `PanelData` | `state`、`error`、`reload`、`setup`、`running`、`restarts` |

`PanelProvider` 做的事：

1. 用 ref 保存当前 `t`，避免语言切换重建 `call`、重启轮询。
2. 默认 5 秒轮询 `GET state`。
3. **重启检测**：用户点重启后进入 `restarting` 状态，改为 1 秒轮询；先看到 error（服务下线）再看到恢复（error 消失），`restarts++`，依赖它的视图会重新取数；30 秒兜底退出。
4. `useAction(action, { reload })`：并发保护 + `busy` + 成功后 reload + 失败 toast。
5. `Toast` 用 `createPortal` 挂到 `body`，3 秒后消失。
6. 样式通过 `import STYLES from './client.css?raw'` 注入 `<style>`——`?raw` 由 tsdown 的 `raw` 插件处理。

`messages(t)` 把 `ApiError` 的各类信息映射成本地化文案，其中 `userError.<code>` 的 `part` 值会先用 `valueLabel` 翻译成可读名。

## 5. 组件清单

| 文件 | 职责 |
| --- | --- |
| `app.tsx` | 外壳：顶栏、全局搜索、术语表弹窗、Tab 切换、路由分发 |
| `overview.tsx` | 总览卡片与问题列表 |
| `source.tsx` | 来源卡片、健康状态、丢弃回复 |
| `thread.tsx` / `trigger.tsx` | 线程/触发详情与时间线 |
| `eval.tsx` | 评估决策视图 |
| `execution.tsx` / `ticket.tsx` | 工单列表与工单详情 |
| `settings.tsx` / `settings-kit.tsx` | 设置页与表单套件 |
| `prompts.tsx` / `prompt-config.ts` | 提示词配置与预览 |
| `deployment.tsx` | 机器配置表单与 `PluginConfig` 卡片 |
| `draft.tsx` | 表单草稿状态（脏检查、冲突处理） |
| `controls.tsx` / `rows.tsx` / `widgets.tsx` | 基础控件、行表、通用小部件 |
| `marks.ts` | 状态点/标记的映射 |
| `text.ts` / `locales.ts` | 文案工具与中英词典 |
| `markdown.ts` | 轻量 Markdown 渲染 |

`app.tsx` 里两个值得注意的实现：

- **全局搜索**：调 `GET search`，同时搜工单、线程、决策条目，命中处用 `<mark class="dt-mark">` 高亮。
- **术语表**：中英双语对照 + 状态图例（done/ongoing/warning/error/idle）+ 枚举值说明，直接用 `locales.ts` 的 `GLOSSARY` / `GLOSSARY_VALUES` 数据驱动。

## 6. 国际化

- 命名空间 `dshSuperagent`，词典在 `locales.ts`（`zh` / `en`）。
- `t(key, values?)` 支持插值；`DshSuperagentKey` 是 key 的联合类型，拼错会编译报错。
- 领域枚举（决策 kind、工单阶段、错误码）都有对应的 `term.*` / `meaning.*` / `userError.*` 条目。
- 面板中文/英文由 DSH 客户端语言决定，无需自己维护开关。

## 7. 后端契约（[app/api.ts](file:///workspace/src/app/api.ts)）

25 条路由，按用途分组：

| 分组 | 路由 |
| --- | --- |
| 状态 | `GET state`、`GET overview`、`GET search`、`GET sources`、`GET models` |
| 设置 | `GET settings`、`PUT settings/:block`、`POST sources/:id/labels`、`POST policy-sync/:id`、`GET policy/history` |
| 线程 | `GET threads`、`GET threads/:key`、`POST threads/:key/unsubscribe` |
| 触发 | `POST triggers/:id/requeue` |
| 评估 | `GET decisions`、`POST decisions/:id/dismiss` |
| 工单 | `GET tickets`、`GET tickets/:id`、`POST tickets/:id/retry`、`POST tickets/:id/stop`、`POST executor/pause` |
| 提示词 | `GET prompts`、`PUT prompts`、`POST prompts/preview` |
| 部署 | `POST setup/check` |

类型工具 `RouteParams` / `ApiRequest` / `ApiResponse` 从路由字符串里推导参数，所以 `call()` 的参数是编译期校验的。

## 8. 样式与约束

- 单文件 `client.css`，类名前缀统一 `dt-`，避免与宿主样式冲突。
- 使用 CSS 变量跟随宿主主题；不引入 UI 框架。
- 无独立路由库：路由就是内存对象 + `sessionStorage`。
- 不做乐观更新：写操作成功后统一 `reload()`，保证看到的是服务端真实状态。
- 不直接请求 GitHub/飞书：前端只跟自己的宿主通信。

## 9. 加一个新页面/新面板的步骤

1. 在 `TABS` 与 `Route` union 里加页面，并更新 `parseRoute`、`routeLabel`。
2. 在 `app/api.ts` 加路由类型，在 `app/http.ts` 加实际处理函数与视图。
3. 在 `client/api.ts` 补类型别名（`ApiResponse<...>`）。
4. 新建 `xxx.tsx`，用 `usePoll(() => call('GET ...'), [call])` 取数。
5. 在 `app.tsx` 的 switch 里挂载。
6. 在 `locales.ts` 补 `tab.*`、`term.*`、`meaning.*` 文案。
7. 写操作统一走 `useAction`，别自己写 toast。

## 10. 常见坑

- **404 不等于不存在**：重启期间路由被卸载，`ApiError.missing` 已封装这个判断，别自己写 `status === 404`。
- **轮询依赖数组写错会无限重建**：`call` 是稳定引用，可以直接放依赖；不要放每次渲染新建的对象。
- **不要在前端复制领域判断**：比如“工单是否在等人”应由后端视图算好，前端只展示。
- **样式用 `?raw` 导入**，只在 tsdown 的 `raw` 插件配置下有效；直接 `import './client.css'` 在浏览器构建里不成立。
