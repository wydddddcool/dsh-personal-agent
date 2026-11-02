# 08 · 部署与运行

> 这一篇面向“把它真正跑起来”的人。核心是三件事：装成 DSH bundle、写好 profile 配置、用管理脚本管进程。
>
> 参考：[SETUP.md](file:///workspace/SETUP.md)、[docs/006-deployment.md](file:///workspace/docs/006-deployment.md)、[examples/profile.cordis.patch.yml](file:///workspace/examples/profile.cordis.patch.yml)、[scripts/dsh-superagent](file:///workspace/scripts/dsh-superagent)。

## 一句话结论

`dsh-superagent` **不是独立服务**，而是装进某个 DSH profile 的 bundle。生命周期 = 一个 `dsh --profile superagent` 进程；`scripts/dsh-superagent` 只是用 tmux 和 HTTP 健康检查把它包了一层。

## 1. 先决条件

| 组件 | 要求 | 用途 |
| --- | --- | --- |
| Node.js | `^22.19.0 \|\| >=24.0.0` | 运行时；SQLite 用内置 `node:sqlite` |
| pnpm | 11.x | 依赖安装与构建 |
| git | ≥ 2.32 | 工作区与 worktree |
| tmux | 任意较新版本 | 管理脚本托管进程 |
| Python | ≥ 3.8 | `scripts/dsh-superagent` |
| GitHub CLI | ≥ 2.48 | 智能体身份与 API 调用 |
| DSH | 满足 `engines.dsh`（`^0.2.1-alpha.2`） | 宿主框架 |
| 模型提供方 | DSH 内配置 | 评估与 worker 都要用 |

可选：`lark-cli`（飞书机器人身份，必须是 strict mode bot 配置）。

`SETUP.md` 里的探测命令：

```sh
node -v; pnpm -v; git --version; tmux -V; python3 --version; gh --version | head -1; dsh --version
gh api user --jq .login
command -v lark-cli
```

## 2. 安装

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <repo> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

- 第 4 条命令从 DSH Web 模板创建 `~/.dsh/profiles/superagent`。
- 第 5 条把本仓库以 **link** 方式装进该 profile。
- `DSH_HOME` 可改写默认的 `~/.dsh`。

⚠️ **只有全新安装才执行 `--from-default-profile`**。已有 profile 再执行会覆盖它并删掉 `cordis.patch.yml`（包括机器配置）。升级时只改 `cordis.patch.yml`。

## 3. profile 配置

把 [examples/profile.cordis.patch.yml](file:///workspace/examples/profile.cordis.patch.yml) 复制到 `~/.dsh/profiles/superagent/cordis.patch.yml`，替换占位符：

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082
- id: dsh-superagent
  config:
    stateDir: /absolute/path/to/state/superagent
# 飞书可选：取消注释后，再到面板里填机器人 lark-cli
# - id: dsh-superagent-feishu
#   disabled: false
```

### 机器配置键

| 键 | 必填 | 含义 |
| --- | --- | --- |
| `stateDir` | 是 | 绝对路径：数据库、锁、`worker-bin` 命令垫片、worker 的 git 配置、默认工单目录 `work`。**升级前必须备份** |
| `promptMaxChars` | 否 | 保存的提示词配置最大字符数 |
| `admissionContextMaxPages` | 否 | 一次评估最多读多少页线程 |
| `admissionContextTimeoutMs` | 否 | 一次评估读上下文的时限 |

首次启动后，这几个限制可在 **Settings → Deployment** 或 DSH Plugin Manager 改，**无需重启**；`stateDir` 不能在那里改。非法值或未知键会导致启动失败，日志会指出具体键。

## 4. 启动与停止

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
scripts/dsh-superagent restart
scripts/dsh-superagent stop
```

- `start`：在 tmux 会话 `dsh-<profile>`（默认 `dsh-superagent`）里跑 `dsh --profile superagent`，最多等 60 秒到 runtime ready 或报出 setup 需求；会拒绝重复实例（包括脚本外启动的）。
- `stop` / `restart`：请求优雅停机，最多等 5 分钟让 Executor 收尾；**绝不强杀，也不碰其他 tmux 会话**。
- `--profile` / `--url` 可改目标；也可用环境变量 `DSH_SUPERAGENT_PROFILE`、`DSH_SUPERAGENT_URL`。
- 健康检查打的是 `GET /orchestrator/api/state`，带 `x-orchestrator-request: 1`。

### 退出码（`status` / `start` / `restart` 共用）

| 码 | 含义 | restart 能修好吗 |
| --- | --- | --- |
| `0` | 正常运行 | — |
| `1` | 没跑 / 跑了两个 / 不可达 / runtime 报错 | 通常可以 |
| `2` | 跑着，但某个组件（Source、`sync:<id>`）报错 | 不可以，要人处理 |
| `3` | 跑着，但等待 setup | 不可以，要人处理 |

补充：Source 仍处于 `starting` 算正常；飞书机器人 setup 时没检查到也算正常。只有**主动 stop** 才会暂停自动恢复（`manually-stopped` 标记）。

### 脚本内部机制（读源码才有）

- 状态目录：`.artifacts/control/profiles/<profile>/`，含 `operation.lock`（`fcntl` 文件锁）、`manually-stopped`、`service.pid`。
- 日志：`.artifacts/dsh-superagent-<profile>-<date>-<time>-<pid>.log`，保留最近 20 个。
- 识别“本 profile 的主服务进程”：扫 `ps`，要求参数里出现 `--profile <profile>` 且命令里没有 `plugin` 子命令——避免把 `dsh plugin add` 误判成服务。
- `stop` 时先写停止标记，再发信号；`start` 会清掉标记，恢复自动恢复。
- 一个 profile 同时只允许一个操作（文件锁）。

## 5. 状态目录布局

`stateDir` 是整套系统的“家”：

| 路径 | 内容 |
| --- | --- |
| `orchestrator.sqlite` | 主库（WAL 模式） |
| `*.lock` | `proper-lockfile` 进程锁 |
| `worker-bin/` | 命令垫片，`PATH` 最前面：`gh` 指向智能体 CLI，`lark-cli` 指向机器人 CLI，被禁命令直接失败 |
| `worker-gitconfig` | 替换全局/系统 git 配置：GitHub 凭据助手、SSH→HTTPS 重写、LFS 过滤器；**不设提交身份**，也移除 `GH_TOKEN`/`GITHUB_TOKEN` |
| `work/` | 默认工单工作目录（可被 `executor.prepare` 改到别处） |

命令垫片会先把自身目录从 `PATH` 移除再执行目标，防止递归。

## 6. 面板设置顺序

首次配置建议按依赖顺序：

1. **Source**：GitHub（仓库、智能体 CLI）→ 可选飞书（机器人 CLI、群、私聊）。
2. **Policy**：各来源的 `allowed[]`、可选 `bots[]`、飞书名单同步。
3. **Execution**：`maxWorkers`、`executor.prepare`、分支前缀等。
4. **Prompts**：交付要求（提交身份、自动合并、分支约定）。
5. **Deployment**：机器限制。

保存 `stateDir` 之外的东西时，若返回 `restarting: true`，说明服务会重启。等待 `scripts/dsh-superagent status` 不再返回 1，再继续下一次保存。设置带**乐观并发**：`PUT` 必须带上次读到的 `revision`，冲突会拒绝。

## 7. 升级

```sh
git pull && pnpm install && pnpm build
# 备份 <stateDir>/orchestrator.sqlite
scripts/dsh-superagent restart
scripts/dsh-superagent status
```

数据库 schema 从 10 升到 11 有一次性迁移（`src/app/migration.ts`），迁移前**务必备份 sqlite 文件**。如果 profile 已存在，不要重新执行 `--from-default-profile`。

## 8. 排障速查

| 现象 | 处理 |
| --- | --- |
| `status` 退出 1 | 服务没跑/重复/不可达/runtime 报错；看输出与最新日志 |
| `status` 退出 2 | `errors` 里点名某个组件；重启无效，按组件修 |
| `status` 退出 3 | `setup` 说明缺什么；总览页会直接链到对应设置 |
| `… was not written by dsh-superagent` | `worker-bin` / `worker-gitconfig` 里有外来文件，移走或换 `stateDir` |
| `… timed out after 90 s` / `exited with code …` | 某个 CLI 失败且没打印原因；用操作者身份手动跑一次那个程序 |
| 面板 404 且无 body | 服务正在重启，路由被卸载，不是“记录不存在” |
| 工单一直不启动 | 检查 `paused` 状态、`maxWorkers`、`prepare` 命令、以及工单是否在 `waitsForPerson` |
| 飞书没反应 | 机器人 CLI 是否 strict mode bot；Source 是否 enabled；事件消费者是否 45 秒内 ready |

## 9. 开发模式

```sh
pnpm install
pnpm build        # lib/ + client.js
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm check        # 三者串起来
```

本地调试通常走同一个 profile：`pnpm build` 后 `scripts/dsh-superagent restart`。因为 bundle 是 link 安装，构建产物会立即生效，但进程需要重启才会重新加载。

## 10. 安全边界

- Web 面板**只监听 loopback**（`127.0.0.1`），并校验 `x-orchestrator-request` 头与同源。
- 智能体的 GitHub 身份是独立账号，**不要用操作者本人账号**。
- 执行器环境里没有 `GH_TOKEN` / `GITHUB_TOKEN`，也不会交互式询问凭据。
- 所有命令垫片都是白名单式转发；被禁命令直接失败。
- 面板与 API 不做公网暴露；需要远程访问请自行加反向代理与鉴权，这不在本项目范围内。
