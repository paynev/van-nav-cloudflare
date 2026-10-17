# van-nav — Cloudflare Pages 版

轻量导航站（React SPA + 后端 API），由 EdgeOne Makers 版迁移到 Cloudflare：

| 项 | EdgeOne 旧版 | Cloudflare 新版 |
|---|---|---|
| 静态前端 | Pages 静态资源 | Pages 静态资源（同一份构建产物，未改动） |
| 后端 | `cloud-functions/` Express 云函数 | `functions/` Pages Functions（Workers 运行时） |
| 存储 | EdgeOne Blob（`van-nav-db`） | Cloudflare **D1**（SQLite） |
| 后台登录 | 用户名/密码（ADMIN_USER / ADMIN_PASSWORD） | **Cloudflare Zero Trust（Access）**，账号密码已彻底移除 |
| 图标缓存 | Blob 存 base64 | Cache API（边缘缓存，无需存储绑定） |

前端构建产物（`index.html` + `static/`）原样保留，一行没改；后台页面由
Pages Function 在服务端注入一段会话引导脚本，把 Zero Trust 身份换成的
token 写进 `localStorage._token`，前端即可无感知工作。

## 目录结构

```
├─ index.html / static/        前端构建产物（未改动）
├─ favicon.ico                 新增的站点图标
├─ functions/
│  ├─ api/[[path]].js          全部 API（原 Express 版逐条对应改写）
│  ├─ admin/[[path]].js        /admin 页面：Zero Trust 门禁 + 注入引导脚本
│  └─ login.js                 /login 页面：同上，并自动跳回 /admin
├─ lib/
│  ├─ store.js                 D1 文档存储
│  ├─ jwt.js                   HS256 JWT（Web Crypto 实现，无第三方依赖）
│  ├─ access.js                Zero Trust JWT 验签（JWKS）
│  └─ spa.js                   后台页面渲染与门禁
├─ wrangler.toml               D1 绑定与环境变量声明
├─ _routes.json                哪些路径走 Functions
├─ _headers                    静态资源安全响应头
└─ schema.sql                  D1 建表语句
```

## 部署步骤

> 全程只需要 Cloudflare 免费套餐（Zero Trust Free 计划支持 50 个用户）。

### 1. 准备

```bash
npm install            # 安装 wrangler
npx wrangler login     # 浏览器授权登录 Cloudflare
```

### 2. 创建 D1 数据库

```bash
npm run d1:create      # 输出 database_id，复制它
```

把 `database_id` 填进 `wrangler.toml`（替换 `REPLACE_WITH_YOUR_D1_ID`），然后建表：

```bash
npm run d1:init
```

不需要手动插数据：接口首次访问发现文档不存在会自动写入默认值。

### 3. 创建 Pages 项目

Cloudflare 控制台 → **Workers & Pages → Create → Pages → Connect to Git**：

| 配置项 | 值 |
|---|---|
| 仓库 | 本仓库 |
| Framework preset | **None** |
| Build command | 留空 |
| Build output directory | `/`（即仓库根目录） |

绑定量已在 `wrangler.toml` 里声明（D1 绑定 `DB`），连接后部署会自动带上。
若控制台里也手动配置过绑定，以 `wrangler.toml` 为准。

### 4. 配置 Zero Trust（Access）

Zero Trust 控制台 → **Access → Applications → Add an application → Self-hosted**，
建 **两个** 应用（同一个 Access 应用只能写一条路径规则）：

| 应用 | Application domain | 说明 |
|---|---|---|
| `van-nav-admin` | `你的域名/admin*` | 后台所有页面 |
| `van-nav-login` | `你的域名/login` | 401 时前端的跳转落点 |

- 没有自有域名时，直接用 `<项目名>.pages.dev` 也可以建 Access 应用。
- Policy 建一条 **Allow**：Include → `Emails` → 填你自己的邮箱。
- 登录方法保持默认的 **One-time PIN**（邮箱验证码）即可，需要的话再加 Google/GitHub 等。

建好后进入应用详情页，复制 **AUD（Application Audience）** 标签。

### 5. 配置环境变量

Pages 项目 → **Settings → Environment variables → Production**：

| 变量 | 值 |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | `你的团队名.cloudflareaccess.com`（Zero Trust 首页能看到） |
| `CF_ACCESS_AUD` | 上一步复制的 Audience Tag |

`wrangler.toml` 里也有这两个变量的占位（空值），以控制台配置为准。
配完后 **重新部署一次**（Deployments → Retry deployment）让变量生效。

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

本地没有 Access 证书链时，`/admin` 会返回 401 说明页；调试 API 可以直接
用 `curl` 带一个本地签发的 token（`/api/login` 在本地会同样要求 Access cookie）。

## 安全设计

- `/admin`、`/login` 页面有 **双重门禁**：Cloudflare 边缘的 Access 策略 +
  Function 内部对 `CF_Authorization` cookie 的 JWKS 验签（RS256）。
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
