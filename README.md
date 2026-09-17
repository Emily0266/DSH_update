# dsh-version-panel

DeepSeek Harness（DSH）的**版本面板**插件 —— 看清当前版本、检查上游更新、一键本地升级。

DSH 的 Web 界面本身没有版本查看入口，源码部署时更难确认「我到底在跑哪个版本」。这个插件把版本信息和更新能力直接放进「设置」，补上这一环。

> 已在 **DSH `0.1.5-rc.2`** 上开发与验证。仓库地址：<https://github.com/Emily0266/DSH_update>

---

## 目录

- [功能特性](#功能特性)
- [界面](#界面)
- [安装](#安装)
- [使用说明](#使用说明)
- [HTTP 接口](#http-接口)
- [工作原理](#工作原理)
- [常见问题](#常见问题)
- [已知限制](#已知限制)
- [开发](#开发)

---

## 功能特性

| 能力 | 说明 |
| --- | --- |
| **当前版本** | 从真实运行入口（`process.argv[1]`）向上定位 `package.json`。**源码部署**（`pnpm dsh web` → `apps/cli/src/bin.ts`）同样能读到正确版本，不依赖 `dsh --version` 是否在 `PATH` 上 |
| **上游最新版本** | 读取 GitHub releases，失败自动回退 tags，并在候选里取**最大语义化版本**（正确处理 `rc` / `alpha` 等预发布后缀） |
| **本地更新** | 仅对 git 源码仓库开放，按 `preflight` → `git pull --ff-only` → 重放受管补丁 → `corepack pnpm install` → `corepack pnpm run build` → 产物校验 → 隔离冒烟自检 顺序执行，**分步实时进度** |
| **规范构建** | 走仓库唯一的规范入口 `pnpm run build`（`scripts/build.ts`），它还会先删构建记录、跑 `build:native-system`、最后写回记录，避免只跑 `build:lib` / `build:web` 导致的客户端 bundle 缺失 |
| **包管理器把关** | 统一走 `corepack pnpm`（解析到 `package.json` 声明的版本）；解析不到时回退 `npx -y pnpm@<版本>`；两者都拿不到声明版本则**拒绝更新** |
| **产物校验** | 遍历 `packages/*/*/package.json`，凡声明 `exports['./client']` 者断言其 `default`（或 `types`）文件存在，缺失逐个点名「包名 + 期望路径」 |
| **构建记录检查** | `.dsh-build/client-build-environment.json` 缺失或 `formatVersion !== 1` ⇒ 暴露「上次构建未完成」，纯读状态时也会显示 |
| **隔离冒烟自检** | 用临时 `DSH_HOME` + 相同 `dsh.profile.bundles` + `--port 0` 独立启动一次，提前暴露插件/typert 不兼容；超时只告警，不阻塞更新 |
| **手动更新命令** | 一键复制完整命令，便于在终端自行执行 |
| **变更说明** | 展开查看上游 release notes |
| **安全防护** | 更新接口必须携带 `confirm: true`；未受管的受跟踪改动会**拒绝启动更新**并点名文件；失败时给出可执行的回滚指引；上游检查带 5 分钟缓存 |

## 界面

安装并重启后，打开 **设置 → 版本**，会看到：

```
版本与更新
┌────────────────────────────────────────────────┐
│ 状态            [已是最新] / [有新版本可用]      │
│ 当前版本        0.1.5-rc.2    D:\...\apps\cli   │
│ 最新版本        0.1.5-rc.2    dsh-v0.1.5-rc.2   │
│ 检查来源        GitHub releases                  │
│ 部署方式        源码仓库      D:\deepseek-harness│
│ 构建产物        客户端 bundle 完整（72 个）      │
│ pnpm            11.7.0        corepack          │
│ [检查更新] [一键本地更新]      查看上游发布 ›    │
└────────────────────────────────────────────────┘
┌ 手动更新命令 ──────────────────────────────────┐
│ git -C <repo> pull --ff-only && git -C <repo>   │
│   apply --3way <dsh-patches/*.patch> &&         │
│   corepack pnpm install && corepack pnpm run build│
└────────────────────────────────────────────────┘
```

- 「一键本地更新」**只在识别到 git 源码仓库时出现**；npm 包安装的环境不显示该按钮。
- 更新执行期间，下方会出现「更新进度」卡片，逐条显示每个步骤的状态与输出尾部。

## 安装

### 前提

| 项目 | 要求 |
| --- | --- |
| DSH 版本 | `0.1.5-rc.2`（已验证；其他版本可能需调整 API 调用） |
| 网络 | 需能访问 `github.com`（安装时）与 `api.github.com` / GitHub releases（运行时） |
| 平台 | Windows / macOS / Linux（host 端只用 Node 内置模块） |

### 步骤

```sh
# 从 GitHub 安装
dsh plugin --profile web add github:Emily0266/DSH_update

# 重启 DSH 后生效
pnpm dsh web
```

刷新浏览器，打开 **设置 → 版本**。

> **免构建**：本插件的 `lib/` 是预置产物（host 端为纯 JS，客户端为手写的 ModuleLoader bundle），`package.json` **不含任何 `scripts`**。因此不会触发 pnpm 对 git 依赖 `prepare` 脚本的阻断，装完即用。

## 使用说明

### 查看版本

打开「设置 → 版本」即自动读取，无需操作。各字段含义：

| 字段 | 含义 |
| --- | --- |
| 当前版本 | 实际运行中的 DSH 版本，来源为运行入口旁的 `package.json` |
| 最新版本 | GitHub 上游发布的最新版本号（含预发布） |
| 检查来源 | 本次上游数据来自 `releases` 还是回退的 `tags` |
| 部署方式 | `源码仓库`（存在 `.git`）或 `npm 包` |
| 状态 | `已是最新` / `有新版本可用` / `无法确认当前版本` / `上游检查失败` |

### 检查更新

点击 **「检查更新」** 会忽略缓存，重新请求 GitHub 上游并刷新全部字段。

正常情况下上游结果缓存 5 分钟，页面打开与手动检查都不会每次都打 GitHub。

### 本地更新（源码部署）

点击 **「一键本地更新」**：

1. 弹出确认框，明确列出将要执行的步骤、本次解析到的 pnpm 版本，以及「上次构建未完成」等提示；
2. 确认后依次执行：

   | 步骤 | 说明 |
   | --- | --- |
   | `preflight` | 记录基线 `HEAD`、收集 `git status --porcelain`；未跟踪条目仅记录；受跟踪改动**只允许落在受管补丁触及的路径上**，否则直接拒绝并点名文件 |
   | `git pull --ff-only` | 快进拉取上游 |
   | 重放受管本地补丁 | 逐个处理补丁目录里的 `NNNN-*.patch`；`git apply --reverse --check` 通过 ⇒ 判定「已上游化」并跳过；否则 `git apply --3way`，冲突则中止整个更新并列出冲突文件 |
   | `corepack pnpm install` | 用 corepack 解析出的 pnpm（`packageManager` 版本）安装依赖 |
   | `corepack pnpm run build` | 唯一规范构建入口（`scripts/build.ts`）：删构建记录 → `build:native-system` → `build:lib` → `build:web` → 写回记录 |
   | 产物校验 | 客户端 bundle 存在性 + 构建记录存在性与 `formatVersion === 1` |
   | 隔离冒烟自检 | 临时 `DSH_HOME` + 相同 bundles + `--port 0` 独立启动一次，观测到「已在 127.0.0.1:<port> 监听」即通过 |

3. 每步的实时输出（末尾若干行）显示在进度卡片中，失败步骤会额外保留**最后 40 行真实输出**；
4. 全部完成后提示：**请重启 `dsh web` 使新版本生效**；
5. 任一步失败都会给出「哪一步 / 退出码 / 输出尾部 / 回滚指引（基线 commit + 重装 + 重建命令）」。

> ⚠️ 该操作会**真实修改源码目录**。不打算升级时请不要点击，只用它查看版本即可。

### 受管本地补丁

补丁目录默认是 `D:\DSH_all\Emily_Daily\dsh-patches\`（可用环境变量 `DSH_VERSION_PANEL_PATCH_DIR` 覆盖），文件名形如 `0001-*.patch`，按文件名升序应用。目录不存在等于「没有补丁」，是正常情况。

- 补丁目录**不在 DSH 检出目录内**，插件不会往 `D:\deepseek-harness` 里写任何补丁文件；
- preflight 需要的「受管路径集合」直接由补丁头部的 `+++ b/<path>` / `--- a/<path>` 解析得出，不依赖 git 自省；
- 补丁已被上游吸收时（反向检查通过）会被自动跳过并记为「已上游化」，便于逐步退役补丁。

### 手动更新

「手动更新命令」卡片提供完整命令，可直接复制到终端执行。执行后同样需要重启 `dsh web`。

## HTTP 接口

host 端在 `ctx.webServer` 上注册精确路由 `/dsh-version/api`：

| 方法 | 请求体 | 说明 |
| --- | --- | --- |
| `GET` | — | 读取状态（当前版本 + 上游版本，带缓存）。可加 `?force=1` 跳过缓存 |
| `POST` | `{ "action": "check" }` | 强制重新检查上游 |
| `POST` | `{ "action": "progress" }` | 读取更新进度 |
| `POST` | `{ "action": "update", "confirm": true }` | 启动本地更新（缺少 `confirm` 会被拒绝） |

`GET` 响应示例：

```json
{
  "ok": true,
  "current": "0.1.5-rc.2",
  "latest": "0.1.5-rc.2",
  "latestTag": "dsh-v0.1.5-rc.2",
  "updateAvailable": false,
  "installType": "source-repo",
  "repoRoot": "D:\\deepseek-harness",
  "upstreamSource": "releases",
  "upstreamError": null,
  "updateCommand": "git -C <repo> pull --ff-only && git -C <repo> apply --3way <dsh-patches/*.patch> && corepack pnpm install && corepack pnpm run build",
  "packageManager": "pnpm@11.7.0",
  "pnpmVersion": "11.7.0",
  "pnpmMismatch": false,
  "patchDir": "D:\\DSH_all\\Emily_Daily\\dsh-patches",
  "buildState": {
    "packageManager": "pnpm@11.7.0",
    "pnpmVersion": "11.7.0",
    "pnpmMismatch": false,
    "pnpmSource": "corepack",
    "corepackAvailable": true,
    "clientBundles": { "ok": true, "checked": 72, "missing": [], "errors": [] },
    "buildRecord": { "present": true, "formatVersion": 1, "formatOk": true, "lastBuildIncomplete": false, "message": null },
    "lastBuildIncomplete": false,
    "smoke": null,
    "warnings": []
  },
  "checkedAt": "2026-09-11T12:00:00.000Z"
}
```

`POST { "action": "progress" }` 与 `GET` 里的 `update` 字段形状一致，除既有字段外还包含：`baseCommit`、`patches`（逐补丁的 `已上游化` / `已应用` / `冲突`）、`patchDir`、`packageManager`、`guidance`（回滚指引）、`currentStep`、`failure`、`smoke`。每个 step 记录在既有的 `name/status/code/error/lines` 之外追加 `tail`（最后 40 行真实输出）、`timedOut`、`outputLines`、`durationMs`。

## 工作原理

```
┌─ 浏览器 ────────────────────────────────┐
│ lib/client.js                           │
│  手写 ModuleLoader bundle（无需构建）    │
│  注册 settings.section →「版本」页       │
└───────────────┬─────────────────────────┘
                │ 同源 fetch
                ▼
┌─ Host ──────────────────────────────────┐
│ lib/index.js                            │
│  ctx.webServer.register(exact route)    │
│   ├─ 当前版本：argv[1] 向上找 package.json│
│   ├─ 上游版本：api.github.com            │
│   └─ 本地更新：spawn git / pnpm          │
└─────────────────────────────────────────┘
```

设计上刻意避开了两类常见坑：

1. **通信走最朴素的方式** —— host 端直接注册 `webServer` 精确路由，客户端用普通同源 `fetch`。不依赖 Connection RPC 的 Host/Origin 与浏览器认证链路，出问题时可以直接用 `curl` 定位。
2. **当前版本不依赖外部命令** —— 通过运行入口向上定位 `package.json`，而不是执行 `dsh --version`（源码部署时该命令往往不在 `PATH` 上）。

## 常见问题

### 当前版本显示「未知」

说明无法从运行入口向上找到带 `version` 的 `package.json`。可检查：

- DSH 是否以非常规方式启动（例如被包装脚本转发）；
- 运行入口所在目录链上是否存在可读的 `package.json`。

### 上游检查失败 / 最新版本显示为空

多为网络问题。该插件请求 `api.github.com`。若所在网络阻断 GitHub：

- 为 DSH 进程配置代理（`HTTPS_PROXY`），或
- 让代理软件接管系统流量。

字段「检查来源」与「上游检查提示」会给出本次失败原因。

### 安装时 `git` 连不上 GitHub

若 `github.com` 被阻断但代理可用，`git` **默认不读 Windows 系统代理**，需显式配置：

```sh
git config --global http.proxy http://127.0.0.1:<端口>
git config --global https.proxy http://127.0.0.1:<端口>
```

或用 `-c` 临时指定：

```sh
dsh plugin --profile web add github:Emily0266/DSH_update
# 若失败，可先在临时目录用带代理的 git 克隆，再以本地路径安装
```

### 没有「一键本地更新」按钮

该按钮仅在识别到 **git 源码仓库**时出现。若 DSH 来自 npm 包安装，请使用 `npm install -g @deepseek-ai/dsh@<版本>` 之类的方式升级。

### 更新完成后界面没变化

需要**重启 `dsh web`**。插件本身不会自动重启宿主进程。

## 已知限制

- **更新仅支持 git 源码仓库**：npm 全局安装或 npx 缓存运行的环境不提供一键更新。
- **需要重启生效**：无论一键更新还是手动更新，完成后都必须重启 `dsh web`。
- **上游检查依赖 GitHub 可达性**：网络受限环境下需要代理。
- **本地更新不做分支校验**：使用 `git pull --ff-only`，若本地有分叉提交会失败并保留原状。
- **冒烟自检是 best-effort**：临时 `DSH_HOME` 里的 profile 依赖真实 profile 的 `node_modules`；找不到 profile 或无法启动时只记录原因并继续，不阻塞更新。超时按告警处理。
- **产物校验只查存在性**：构建记录的 SHA-256 摘要逻辑仍由 DSH 自己的构建负责，插件只检查存在性 + `formatVersion === 1`。
- **版本兼容性**：当前针对 DSH `0.1.5-rc.2` 验证；DSH 客户端 slot 或 `webServer` API 变更可能导致界面不挂载（host 端检查通常仍可用）。

## 开发

```sh
# host 端逻辑回归测试（会真实访问 GitHub API）
node tests/host.test.mjs

# 语法检查
node --check lib/index.js
node --check lib/client.js
```

该脚本会 mock 一个最小的 cordis `ctx`，驱动真实的 host 逻辑，并断言：

- 路由注册成功；
- 当前版本 / 上游版本读取正确；
- 未知 action 返回 400；
- 未带 `confirm: true` 的更新请求被拒绝。

> 测试通过设置 `process.argv[1]` 模拟真实 DSH 启动入口。

## 目录结构

```
.
├── lib/
│   ├── index.js        # host 半：版本读取、GitHub 查询、本地更新、HTTP 路由
│   └── client.js       # 客户端半：设置页 UI（手写 ModuleLoader bundle）
├── tests/
│   └── host.test.mjs   # host 端回归测试
├── cordis.patch.yml    # bundle patch：把插件插入 profile 层栈
├── package.json        # dsh.bundle + dsh.client 声明
└── README.md
```

## License

MIT
