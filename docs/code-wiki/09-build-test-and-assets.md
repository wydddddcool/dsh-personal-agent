# 09 · 构建、测试与静态资产

> 这一篇讲“代码怎么变成能跑的东西”，以及那些不是代码但同样重要的资产：提示词、技能、词典、Cordis patch。
>
> 关键文件：[package.json](file:///workspace/package.json)、[tsdown.config.ts](file:///workspace/tsdown.config.ts)、[vitest.config.ts](file:///workspace/vitest.config.ts)、[tsconfig.json](file:///workspace/tsconfig.json)。

## 一句话结论

两条构建线：**服务端 ESM**（`lib/index.js` + 两个 watch 入口 + `.d.ts`）与**浏览器 CJS**（`lib/client.js`，包装成 DSH 模块加载器格式）。测试是 Vitest + jsdom，共 59 个 spec。

## 1. 构建（[tsdown.config.ts](file:///workspace/tsdown.config.ts)）

```ts
defineConfig([
  { entry: { index, 'github-watch', 'feishu-watch' }, outDir: 'lib', format: 'esm', platform: 'node',
    target: 'es2024', dts: true, clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//, 'zod', 'proper-lockfile'] } },
  { entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser',
    dts: false, clean: false, plugins: [raw],
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: { entryFileNames: 'client.js', banner, footer, intro } },
])
```

### 服务端

| 入口 | 产物 | 用途 |
| --- | --- | --- |
| `src/index.ts` | `lib/index.js` + `.d.ts` | 主 bundle 插件 |
| `src/sources/github.ts` | `lib/github-watch.js` | 独立 GitHub watch 插件 |
| `src/sources/feishu.ts` | `lib/feishu-watch.js` | 独立飞书 watch 插件 |

- `neverBundle` 保证 DSH 生态包、`zod`、`proper-lockfile` 不被打进产物，由宿主或依赖提供。这既是体积考虑，也避免同一框架被加载两份导致类型/单例问题。
- `dts: true` 生成声明文件，`package.json` 的 `types` 指向它。
- `target: es2024` 与 `tsconfig` 一致。

### 客户端

- 格式是 **CJS**，因为 DSH Web 的模块加载器用 `require` 注入宿主模块。
- `platform: 'browser'`，React 全部 external。
- `entryFileNames: 'client.js'` 固定文件名，`package.json` 的 `./client` 导出直接指它。
- **banner/footer/intro** 把它包成：

```js
window.__ModuleLoader__.load({ id: "dsh-superagent", factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  /* … 打包后的代码 … */
  return module.exports;
} });
```

- `raw` 插件（文件内自定义）实现 `?raw` 导入：把 CSS 文件读成字符串导出。tsdown 默认拒绝 `.css` id，所以必须自己处理。`client.css` 就是这样进 `<style>` 的。

### `package.json` 的 DSH 元数据

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "inject": [...六个客户端包...] },
  "manifestVersion": 1
}
```

`inject` 告诉宿主客户端在加载本插件前先准备好这些包（locale、settings、renderer、layout、sidebar、workspace）。

`files` 白名单只发布 `lib`、`cordis.patch.yml`、`locale/*.json`、`README.md`、`prompts`、`skills`——这些是运行时真正要读的资产。

## 2. TypeScript 配置

| 选项 | 值 | 影响 |
| --- | --- | --- |
| `target` | `ES2024` | 可用新语法 |
| `module` / `moduleResolution` | `NodeNext` | 与 ESM + `.ts` 后缀导入一致 |
| `strict` | true | 严格模式 |
| `noUncheckedIndexedAccess` | true | 数组/字典索引返回 `T \| undefined`，逼着处理边界 |
| `verbatimModuleSyntax` | true | 类型导入必须 `import type` |
| `allowImportingTsExtensions` / `rewriteRelativeImportExtensions` | true | 源码写 `./x.ts`，构建时改写成 `.js` |
| `jsx` | `react-jsx` | 新版 JSX 转换，无需 `import React` |
| `declaration` | true | 生成 `.d.ts` |

### 重要导入约定

- 所有相对导入**带 `.ts` / `.tsx` 后缀**。
- `src/client/*` 与 `src/app/api.ts` 是**纯类型桥**：`api.ts` 只导出类型与常量，前端 import 它不会拖入宿主代码。
- `src/sources/host.ts` 被面板 import，因此**不能引用 Node 专用模块**（文件头注释明确写了这一点）。

## 3. 测试

### 配置（[vitest.config.ts](file:///workspace/vitest.config.ts)）

- `include: tests/**/*.spec.{ts,tsx}`
- `dedupe: ['react', 'react-dom']`：避免多份 React 导致 Hook 报错
- 环境默认为 node；面板测试用 `jsdom`（通过文件内注释或 `@vitest-environment` 指定）

### 59 个 spec 的分组

| 组别 | 代表文件 | 测什么 |
| --- | --- | --- |
| 领域内核 | `core-engine`、`stage`、`model-surface`、`role-models`、`followups` | 状态机、不变量、角色化接口 |
| 应用层 | `runtime`、`runtime-concurrency`、`passes`、`effects`、`queue`、`outbox`、`delivery`、`store`、`cache`、`settings` | 组合根、并发、副作用队列、幂等投递、SQLite |
| 来源 | `sources`、`registry`、`github-read`、`feishu-read`、`feishu-image`、`admission-context` | 契约、scope、分页、图像 |
| 执行器 | `background`、`retry-health` | 后台任务收敛、瞬时重试 |
| 评估/策略 | `assessment`、`policy`、`prompts`、`prompt-config` | 决策、准入矩阵、提示词版本 |
| 面板 | `panel-*.spec.tsx`（9 个）、`client`、`controls`、`draft`、`views`、`styles`、`marks`、`markdown`、`locales`、`timeline` | 渲染、交互、词典完整性 |
| 基础设施 | `commands`、`environment`、`health`、`index`、`http`、`navigation`、`deployment`、`service-script`、`migration`、`bundle-patch`、`class-docs`、`docs` | CLI 封装、健康位、HTTP 校验、迁移、文档/类注释一致性 |

有两类“元测试”值得注意：

- `bundle-patch.spec.ts`：校验 `cordis.patch.yml` 的 preset 与插件 ID 是否与代码常量一致。
- `class-docs.spec.ts` / `docs.spec.ts`：校验源码类注释与设计文档没有漂移，防止文档腐化。

### fixtures

`tests/fixtures/` 提供假实现：host、panel、git、deployment 等。原则是**用内存替身替代真实副作用**，让 Engine 与 Runtime 能在毫秒级跑完整流程。

### 测试风格

- 领域层尽量纯函数化，测试不需要数据库。
- 应用层用真实 `Store`（临时目录）验证 SQL、事务与迁移。
- 面板测试用 Testing Library 风格断言可见文案与交互，不测实现细节。
- 时间相关逻辑普遍支持注入 `now` 或使用假定时器。

## 4. Cordis patch（[cordis.patch.yml](file:///workspace/cordis.patch.yml)）

这是 bundle 的“装配清单”，分两类内容：

### insert：插件

| id | name | 说明 |
| --- | --- | --- |
| `dsh-superagent` | `dsh-superagent` | 主插件，必须配 `stateDir` |
| `dsh-superagent-github` | `dsh-superagent/github-watch` | GitHub 来源 |
| `dsh-superagent-feishu` | `dsh-superagent/feishu-watch` | 飞书来源，默认 `disabled: true` |

### preset：两种 Agent 预设

| preset id | order | 用途 |
| --- | --- | --- |
| `dsh-superagent-worker` | 90 | 执行器 Session 专用 |
| `dsh-superagent-router` | 91 | 主 Session 专用 |

两者都是 DSH `standard` 的裁剪版：

- **shell 超时 5 秒**：前台命令 5 秒后转后台，避免长命令挡住人的消息。
- **jobs 等待 5 秒**：等待任务也很快让出。
- **worker** 保留：fs 读写、fs-search、jobs、skill、compaction、subagent（spawn，跑 `standard` 预设）、todo、web search（不 fetch）。
- **worker 去掉**：向人提问、presenting、plan mode、plugin manager、调度、goals、workflows、forked subagent。
- **router** 去掉得更多：无 subagent、无 web、fs 只读（`write: false, edit: false`）、无 todo、无 persona（主 Session 提示词已完整）。

为什么 worker 的子代理跑 `standard` 而不是 worker 预设：子代理结束时它的 job 会被杀掉，所以用 60 秒转后台的 `standard` 更合适。

## 5. 提示词资产（`prompts/`）

| 文件 | 内容 |
| --- | --- |
| `shared.md` | 两个 Session 共享的基础约定 |
| `orchestrator.md` | 主 Session 角色 |
| `worker.md` | worker 角色 |
| `dispatch.md` / `work.md` | 派工与工作流程 |
| `handoff.md` / `handoff-orchestrator.md` / `handoff-worker.md` | 交接给人的不同视角 |
| `admission.md` | 准入评估指令 |
| `replies.md` | 回复口径 |
| `subscriptions.md` | 订阅与上下文 |
| `cli.md` | CLI 使用约定 |
| `team/` | 团队自定义段落 |

组装规则（[app/prompts.ts](file:///workspace/src/app/prompts.ts)）：

- `TEAM_SECTIONS` + `TEAM_HEADINGS`：团队段落的位置与标题。
- `PART_KEYS`：15 个可编辑片段。
- `builtInParts` / `builtInBase`：内置默认文本。
- `composePrompt` / `composeSkill`：把基础 + 团队段落 + 内置片段 + 技能拼成最终提示词。
- **版本化保存**：每次保存生成 revision；worker Session 使用创建时的 revision，避免改提示词影响正在跑的工单。
- `PromptConfigSchema` 校验保存内容，上限由 `promptMaxChars` 控制。

## 6. 技能资产（`skills/`）

| 目录 | 内容 |
| --- | --- |
| `dsh-superagent-github/SKILL.md` | 教 worker 用 `gh` 正确操作仓库、开 PR、遵守分支约定 |
| `dsh-superagent-feishu/SKILL.md` | 教 worker 读取飞书线程上下文、图片 |

这些技能在 worker 启动时按来源挂载（`Sessions.bindSkills`），技能名有固定前缀 `SKILL_PREFIX`，避免与用户技能冲突。

## 7. 词典资产（`locale/`）

`locale/zh.json` 与 `locale/en.json` 是给**宿主/CLI 侧**用的词典（`package.json` 的 `./locale/*.json` 导出）。面板自己的词典在 `src/client/locales.ts`，两者用途不同：

- `locale/*.json`：随包发布的静态本地化资源。
- `client/locales.ts`：编译进 `client.js` 的运行时词典，类型更强（`DshSuperagentKey`）。

`locales.spec.ts` 校验中英文 key 齐全、无遗漏。

## 8. 常用命令与产物

```bash
pnpm install       # 安装
pnpm build         # tsdown：lib/（ESM + d.ts）与 lib/client.js
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest run（59 个 spec）
pnpm check         # typecheck → test → build
```

产物结构：

```
lib/
├── index.js / index.d.ts
├── github-watch.js
├── feishu-watch.js
└── client.js
```

`clean: true` 只作用于第一个配置；客户端配置是 `clean: false`，避免把服务端产物删掉。

## 9. 改构建/资产时的检查清单

- 新增服务端入口 → 同步改 `tsdown.config.ts` 的 `entry`、`package.json` 的 `exports` 与 `files`。
- 新增 `?raw` 导入 → 确认 `raw` 插件仍匹配该后缀。
- 新增客户端依赖 → 若由宿主提供，加进 `neverBundle` 与 `dsh.client.inject`。
- 改预设 → 跑 `bundle-patch.spec.ts`，它会校验 ID 与代码常量。
- 改提示词 → 注意版本化语义：正在跑的工单不应被新版本影响。
- 改词典 → 跑 `locales.spec.ts`，中英文必须成对。
