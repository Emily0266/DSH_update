# dsh-version-panel

DeepSeek Harness（DSH）的**版本面板**插件：显示当前运行版本、检查 GitHub 上游最新版本，并支持源码部署的本地更新。

## 功能

| 功能 | 说明 |
| --- | --- |
| **当前版本** | 从真实运行入口（`process.argv[1]`）向上定位 `package.json`，源码部署（`apps/cli/src/bin.ts`）也能读到正确版本 |
| **上游最新版本** | 读取 GitHub releases，失败时回退 tags，并按语义化版本（含 prerelease）取最大值 |
| **一键本地更新** | 仅对 git 源码仓库开放：`git pull` → `pnpm install` → `pnpm run build:lib` → `pnpm run build:web`，带分步实时进度 |
| **安全防护** | 更新请求必须携带 `confirm: true`，否则拒绝执行 |

## 工作原理

- **host 端**（`lib/index.js`）在 `ctx.webServer` 上注册一个精确 HTTP 路由 `/dsh-version/api`，只依赖 `webServer` 服务，不依赖 Connection RPC。
- **客户端**（`lib/client.js`）是手写的 ModuleLoader bundle（无需构建工具），在「设置」里注册一个「版本」页，通过同源 `fetch` 调用 host 接口。

### HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/dsh-version/api` | 读取状态（当前版本 + 上游最新版本，5 分钟缓存） |
| `POST` | `/dsh-version/api` | `{ action: "check" }` 强制重新检查上游 |
| `POST` | `/dsh-version/api` | `{ action: "progress" }` 读取更新进度 |
| `POST` | `/dsh-version/api` | `{ action: "update", confirm: true }` 启动本地更新 |

## 安装

```sh
dsh plugin --profile web add <本仓库路径或 git 地址>
```

安装后**重启 dsh web**，在 **设置 → 版本** 中查看。

## 开发

```sh
# host 端逻辑回归测试（会真实访问 GitHub API）
node tests/host.test.mjs
```

## 目录结构

```
.
├── lib/
│   ├── index.js        # host 半：版本读取、GitHub 查询、本地更新
│   └── client.js       # 客户端半：设置页 UI
├── tests/
│   └── host.test.mjs   # host 端回归测试
├── cordis.patch.yml    # bundle patch
└── package.json        # dsh.bundle + dsh.client 声明
```

## License

MIT
