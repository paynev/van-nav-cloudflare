# van-nav — Cloudflare Worker 版

轻量导航站（React SPA + 后端 API），由 EdgeOne Makers 版迁移到 Cloudflare：

| 项 | EdgeOne 旧版 | Cloudflare 新版 |
|---|---|---|
| 运行形态 | `cloud-functions/` Express 云函数 | **Cloudflare Worker**（`src/worker.js`）+ 静态资源 |
| 静态前端 | Pages 静态资源 | Worker 的 assets 绑定（`public/`），同一份构建产物未改动 |
| 存储 | EdgeOne Blob（`van-nav-db`） | Cloudflare **D1**（SQLite），**首次部署自动创建并绑定** |
| 后台登录 | 用户名/密码（ADMIN_USER / ADMIN_PASSWORD） | **Cloudflare Zero Trust（Access）**，账号密码已彻底移除 |
| 图标缓存 | Blob 存 base64 | Cache API（边缘缓存，无需存储绑定） |

前端构建产物（`index.html` + `static/`）原样保留，一行没改；后台页面由 Worker
在服务端注入一段会话引导脚本，把 Zero Trust 身份换成的 token 写进
`localStorage._token`，前端即可无感知工作。

## 目录结构

```
├─ public/                     前端构建产物（index.html、static/、图标，未改动）
│  └─ _headers                 静态资源安全响应头
├─ src/
│  ├─ worker.js                Worker 入口：路由分发（API / 后台门禁 / 静态资源）
│  └─ api.js                   全部 API（原 Express 版逐条对应改写）
├─ lib/
│  ├─ store.js                 D1 文档存储（首次读写时自动建表）
│  ├─ jwt.js                   HS256 JWT（Web Crypto 实现，无第三方依赖）
│  ├─ access.js                Zero Trust JWT 验签（JWKS）
│  └─ spa.js                   /admin 与 /login 的门禁与页面渲染
├─ wrangler.toml               assets + D1 绑定 + 环境变量声明
└─ schema.sql                  D1 建表语句（可选，代码里会自动执行）
```

## 部署步骤

> 全程只需要 Cloudflare 免费套餐（Zero Trust Free 计划支持 50 个用户）。

### 1. 准备

```bash
npm install            # 安装 wrangler
npx wrangler login     # 浏览器授权登录 Cloudflare
```

### 2. 部署（D1 会自动创建并绑定）

```bash
npm run deploy         # = npx wrangler deploy
```

`wrangler.toml` 里刻意**只写了 `database_name`、没写 `database_id`**：

```toml
[[d1_databases]]
binding = "DB"
database_name = "van-nav-db"
```

部署时 wrangler 会按名字查找数据库：存在就绑定，不存在就自动创建再绑定
（wrangler 4.45+ 的 automatic resource provisioning，默认开启，
对应隐藏开关 `--x-provision`）。**不需要手工建库、也不需要回填任何 ID。**

表结构同样无需手动执行 `schema.sql`：`lib/store.js` 在首次读写文档时会执行
`CREATE TABLE IF NOT EXISTS docs (...)`，空库也能直接工作。

两个注意点：

- `database_name` 必须显式写出。只写 `binding` 的话 wrangler 会拿 binding 名当数据库名
  （workers-sdk #11870），与预期不符。
- 自动生成的 `database_id` 只会写进部署产物，不会回写 GitHub 仓库。因为按
  `database_name` 匹配，后续部署会复用同一个库，不会重复创建。

### 3. 配置 Zero Trust（Access）

Zero Trust 控制台 → **Settings → WARP/Team domain** 确认团队域名；
再进 **Access → Applications → Add an application → Self-hosted**，
建 **两个** 应用（同一个 Access 应用只能写一条路径规则）：

| 应用 | Application domain | 说明 |
|---|---|---|
| `van-nav-admin` | `你的域名/admin*` | 后台所有页面 |
| `van-nav-login` | `你的域名/login` | 401 时前端的跳转落点 |

- 没有自有域名时，直接用 `<项目名>.workers.dev` 也可以建 Access 应用。
- Policy 建一条 **Allow**：Include → `Emails` → 填你自己的邮箱。
- 登录方法保持默认的 **One-time PIN**（邮箱验证码）即可，需要的话再加 Google/GitHub 等。

建好后进入应用详情页，复制 **AUD（Application Audience）** 标签。

### 4. 配置环境变量

Worker → **Settings → Variables and Secrets → Add**：

| 变量 | 值 |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | `你的团队名.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | 上一步复制的 Audience Tag |

`wrangler.toml` 的 `[vars]` 里也有这两个变量的占位（空值）。
配完后重新部署一次让变量生效；不想让每次部署清掉控制台配的变量，加 `--keep-vars`。

### 5.（可选）接 GitHub 自动部署

Workers & Pages → **Create → Workers → Import a repository**，选本仓库即可。
Workers Builds 的 CI 里跑的同样是 `npx wrangler deploy`，所以第 2 步的
自动建库/绑定在 CI 里也一样生效 —— push 上去就是全自动的。

### 6. 验证

| 检查项 | 预期 |
|---|---|
| 打开 `https://站点/` | 导航首页正常，无需登录 |
| 打开 `https://站点/admin` | 跳 Zero Trust 登录页 → 输邮箱收验证码 → 进入后台 |
| 后台增删工具 | 保存后首页立刻可见（D1 强一致） |
| 直接 `curl /api/admin/all`（无 cookie） | 返回 401 |

## 数据迁移（从 EdgeOne 版）

1. 打开旧站后台 → API Token 页 → **导出工具**（`/api/admin/exportTools`），保存 JSON。
2. 新站进后台 → 导入工具，粘贴 JSON。
3. 搜索引擎、站点设置等需要在后台重新配一遍（量很小）。

## 本地开发

```bash
cp .dev.vars.example .dev.vars    # 填入你的 Zero Trust 配置
npm run dev                       # http://localhost:8788
```

本地 dev 会把 D1 落在 `.wrangler/state` 的 SQLite 里，同样不需要 `database_id`，
也不需要先建库。本地没有 Access 证书链时，`/admin` 会返回 500 的配置提示页；
调试公开接口可以直接 curl `/api/`。

## 安全设计

- `/admin`、`/login` 页面有 **双重门禁**：Cloudflare 边缘的 Access 策略 +
  Worker 内部对 `CF_Authorization` cookie 的 JWKS 验签（RS256）。
  即使 Access 路径规则配错，函数层也会拒绝。
- API 层校验会话 token（HS256）或 Access cookie，二者都验 `exp`，
  Access token 额外校验 `iss` 和 `aud`（Audience Tag 不匹配一律拒绝）。
- Access cookie 是 HttpOnly 的，前端脚本读不到，只能由服务端换取会话 token。
- 旧的 `admin/admin`、`ADMIN_USER/ADMIN_PASSWORD` 体系已完全删除，
  不存在弱口令默认值。

## 已知差异

- `/api/admin/user`（改账号密码）保留接口但只返回提示，因为凭据归 Zero Trust 管。
- 「退出登录」只会清掉本站 token；Zero Trust 的会话在 Cloudflare 侧，
  需要在 Access 的登录页选择 Log out 或等它自然过期。
- 早期版本是 Pages Functions（`functions/` 目录）。Pages 不会自动创建 D1，
  必须预先建库并回填 `database_id`；改成 Worker 后这一步被省掉。
  旧结构仍在 git 历史里。
