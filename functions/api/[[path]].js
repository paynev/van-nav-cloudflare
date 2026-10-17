/**
 * van-nav —— Cloudflare Pages Functions 版后端
 *
 * 由 EdgeOne Makers 云函数（Express + Blob）改写而来：
 *   - 存储：EdgeOne Blob  →  Cloudflare D1（lib/store.js）
 *   - 鉴权：用户名密码 + JWT  →  Cloudflare Zero Trust（lib/access.js）
 *   - 图片缓存：Blob 存 base64  →  Cloudflare Cache API
 * API 响应结构保持与旧版一致：{ success, message?, data?, errorMessage? }
 */

import { readDoc, writeDoc, getJwtSecret } from "../../lib/store.js";
import { signJwt, verifyJwt } from "../../lib/jwt.js";
import {
  accessConfig,
  verifyAccessToken,
  readAccessCookie,
  identityFromAccess,
} from "../../lib/access.js";

const DEFAULT_SETTING = {
  id: 1,
  favicon: "favicon.ico",
  title: "Van Nav",
  govRecord: "",
  logo192: "logo192.png",
  logo512: "logo512.png",
  hideAdmin: false,
  hideGithub: false,
  hideToggleJumpTarget: false,
  jumpTargetBlank: true,
};

const DEFAULT_SITE_CONFIG = { id: 1, noImageMode: false, compactMode: false };

const DEFAULT_SEARCH_ENGINES = [
  { id: 1, name: "百度", baseUrl: "https://www.baidu.com/s", queryParam: "wd", logo: "baidu.ico", sort: 1, enabled: true },
  { id: 2, name: "Bing", baseUrl: "https://cn.bing.com/search", queryParam: "q", logo: "bing.ico", sort: 2, enabled: true },
  { id: 3, name: "Google", baseUrl: "https://www.google.com/search", queryParam: "q", logo: "google.ico", sort: 3, enabled: true },
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SESSION_TTL_SECONDS = 30 * 24 * 3600;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function nextId(existing) {
  let id = Math.floor(Date.now() / 1000);
  const ids = new Set((existing || []).map((x) => Number(x.id)));
  while (ids.has(id)) id += 1;
  return id;
}

function bySort(a, b) {
  return (a.sort || 0) - (b.sort || 0);
}

function filterHidden(tools, catelogs) {
  const hiddenCates = new Set(catelogs.filter((c) => c.hide).map((c) => c.name));
  return tools.filter((t) => !t.hide && !hiddenCates.has(t.catelog));
}

function imgContentType(url) {
  const u = String(url).toLowerCase();
  if (u.includes(".svg")) return "image/svg+xml";
  if (u.includes(".png")) return "image/png";
  if (u.includes(".jpg") || u.includes(".jpeg")) return "image/jpeg";
  if (u.includes(".gif")) return "image/gif";
  if (u.includes(".webp")) return "image/webp";
  return "image/x-icon";
}

function notConfiguredMessage(missing) {
  return (
    `尚未配置 Cloudflare Zero Trust（缺失：${missing.join("、")}）。` +
    `请在 Pages 项目 Settings → Environment variables 添加 CF_ACCESS_TEAM_DOMAIN（如 yourteam.cloudflareaccess.com）` +
    `与 CF_ACCESS_AUD（Access 应用的 Audience Tag），然后重新部署。`
  );
}

// ---------------- 鉴权 ----------------

/**
 * 判定当前请求是否为管理员。
 * 两条通路：
 *   1. Authorization 头里的本站会话 token（HS256，由 /api/session 或 /api/login 签发）
 *   2. Zero Trust 下发的 CF_Authorization cookie（RS256，用团队 JWKS 验签）
 */
async function requireAdmin(request, env, db) {
  const cfg = accessConfig(env);

  const headerToken = (request.headers.get("authorization") || "").trim();
  if (headerToken) {
    const secret = await getJwtSecret(db);
    const payload = await verifyJwt(headerToken, secret);
    if (payload) {
      return { ok: true, identity: { name: payload.name, id: payload.id, source: "session" } };
    }
  }

  const cookieToken = readAccessCookie(request);
  if (cookieToken) {
    const payload = await verifyAccessToken(cookieToken, cfg);
    if (payload && !payload.error) {
      return { ok: true, identity: identityFromAccess(payload) };
    }
    if (payload && payload.error === "not_configured") {
      return { ok: false, status: 500, errorMessage: notConfiguredMessage(cfg.missing) };
    }
  }

  if (!cfg.ready) {
    return { ok: false, status: 500, errorMessage: notConfiguredMessage(cfg.missing) };
  }
  return {
    ok: false,
    status: 401,
    errorMessage: "未通过 Cloudflare Zero Trust 认证，请先访问 /admin 完成登录",
  };
}

/** 只判断是否为管理员，不产生错误提示（用于首页决定要不要显示隐藏项） */
async function peekAdmin(request, env, db) {
  try {
    const g = await requireAdmin(request, env, db);
    return g.ok ? g.identity : null;
  } catch (e) {
    return null;
  }
}

// ---------------- 图标抓取 ----------------

function extractIconUrl(html) {
  const patterns = [
    /<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]*href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*apple-touch-icon[^"']*["']/i,
    /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*icon[^"']*["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1];
  }
  return "";
}

async function scrapeIconUrl(siteUrl) {
  try {
    const resp = await fetch(siteUrl, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    if (!resp.ok) return "";
    const html = await resp.text();
    const icon = extractIconUrl(html);
    if (!icon) return "";
    if (icon.startsWith("http")) return icon;
    const origin = new URL(siteUrl).origin;
    if (icon.startsWith("//")) return "https:" + icon;
    if (icon.startsWith("/")) return origin + icon;
    return origin + "/" + icon;
  } catch (e) {
    return "";
  }
}

/** 新增/更新工具时若没填 logo，后台补抓一次 */
async function lazyFetchLogo(db, toolId) {
  try {
    const tools = await readDoc(db, "tools.json", []);
    const tool = tools.find((t) => Number(t.id) === Number(toolId));
    if (!tool || !tool.url) return;
    const iconUrl = await scrapeIconUrl(tool.url);
    if (iconUrl) {
      tool.logo = iconUrl;
      await writeDoc(db, "tools.json", tools);
    }
  } catch (e) {
    /* 忽略 */
  }
}

// ---------------- 公开接口 ----------------

async function handleIndex({ request, env, db }) {
  const identity = await peekAdmin(request, env, db);
  let tools = await readDoc(db, "tools.json", []);
  let catelogs = await readDoc(db, "catelogs.json", []);
  const setting = await readDoc(db, "setting.json", DEFAULT_SETTING);
  const siteConfig = await readDoc(db, "siteConfig.json", DEFAULT_SITE_CONFIG);
  if (!identity) {
    tools = filterHidden(tools, catelogs);
    catelogs = catelogs.filter((c) => !c.hide);
  }
  return json({
    success: true,
    data: {
      tools: [...tools].sort(bySort),
      catelogs: [...catelogs].sort(bySort),
      setting,
      siteConfig,
    },
  });
}

async function handleSearchEngines({ db }) {
  const engines = await readDoc(db, "searchEngines.json", DEFAULT_SEARCH_ENGINES);
  return json({
    success: true,
    data: engines.filter((e) => e.enabled).sort(bySort),
  });
}

async function handleImg({ request, env, ctx, url }) {
  const target = url.searchParams.get("url");
  if (!target) return json({ success: false, errorMessage: "URL参数不能为空" }, 400);

  let parsed;
  try {
    parsed = new URL(target);
  } catch (e) {
    return json({ success: false, errorMessage: "URL 格式不正确" }, 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return json({ success: false, errorMessage: "只支持 http/https 地址" }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });

  const hit = await cache.match(cacheKey);
  if (hit) {
    const resp = new Response(hit.body, hit);
    resp.headers.set("Cache-Control", "public, max-age=86400");
    resp.headers.set("X-Image-Cache", "HIT");
    return resp;
  }

  try {
    const upstream = await fetch(parsed.toString(), {
      headers: { "User-Agent": UA, Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    if (!upstream.ok) return json({ success: false, errorMessage: "未找到图片" }, 404);
    const buf = await upstream.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > 5 * 1024 * 1024) {
      return json({ success: false, errorMessage: "图片为空或超过 5MB" }, 404);
    }
    const resp = new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || imgContentType(target),
        "Cache-Control": "public, max-age=86400",
        "X-Image-Cache": "MISS",
      },
    });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    return json({ success: false, errorMessage: "抓取图片失败" }, 404);
  }
}

/**
 * 用 Zero Trust 身份换取本站会话 token。
 * 页面级 Functions（/admin、/login）注入的 bootstrap 脚本会同步调用它，
 * 把 token 写进 localStorage._token，供 React 前端使用。
 */
async function handleSession({ request, env, db }) {
  const guard = await requireAdmin(request, env, db);
  if (!guard.ok) {
    return json({ success: false, errorMessage: guard.errorMessage }, guard.status);
  }
  const secret = await getJwtSecret(db);
  const token = await signJwt(
    {
      name: guard.identity.name,
      id: guard.identity.id,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    },
    secret
  );
  return json({
    success: true,
    data: { token, user: { name: guard.identity.name, id: guard.identity.id } },
  });
}

/**
 * 兼容旧前端登录页：账号密码不再校验，只要通过 Zero Trust 就发 token。
 * 注意这里失败时返回 HTTP 200 —— 前端 axios 拦截器遇到 401 会硬跳 /login，
 * 在 /login 页上再返回 401 会造成刷新死循环。
 */
async function handleLogin({ request, env, db }) {
  const guard = await requireAdmin(request, env, db);
  if (!guard.ok) {
    const status = guard.status === 500 ? 500 : 200;
    return json({ success: false, errorMessage: guard.errorMessage }, status);
  }
  const secret = await getJwtSecret(db);
  const token = await signJwt(
    {
      name: guard.identity.name,
      id: guard.identity.id,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    },
    secret
  );
  return json({
    success: true,
    message: "登录成功",
    data: { user: { name: guard.identity.name, id: guard.identity.id }, token },
  });
}

async function handleLogout() {
  return json({ success: true, message: "登出成功" });
}

// ---------------- 管理接口 ----------------

async function handleAdminAll({ guard, db }) {
  const tools = await readDoc(db, "tools.json", []);
  const catelogs = await readDoc(db, "catelogs.json", []);
  const setting = await readDoc(db, "setting.json", DEFAULT_SETTING);
  const siteConfig = await readDoc(db, "siteConfig.json", DEFAULT_SITE_CONFIG);
  const tokens = await readDoc(db, "tokens.json", []);
  return json({
    success: true,
    data: {
      tools: [...tools].sort(bySort),
      catelogs: [...catelogs].sort(bySort),
      setting,
      siteConfig,
      user: { name: guard.identity.name, id: guard.identity.id },
      tokens,
    },
  });
}

async function handleAdminCreateToken({ db, body }) {
  const name = body?.name;
  if (!name) return json({ success: false, errorMessage: "名称不能为空" }, 400);
  const tokens = await readDoc(db, "tokens.json", []);
  const id = nextId(tokens);
  const secret = await getJwtSecret(db);
  const value = await signJwt(
    { name, id, exp: Math.floor(Date.now() / 1000) + 100 * 365 * 24 * 3600 },
    secret
  );
  tokens.push({ id, name, value, disabled: 0 });
  await writeDoc(db, "tokens.json", tokens);
  return json({ success: true, data: { id, Value: value, Name: name }, message: "添加 Token 成功" });
}

async function handleAdminDeleteToken({ db, params }) {
  const tokens = await readDoc(db, "tokens.json", []);
  const t = tokens.find((x) => String(x.id) === params.id);
  if (t) {
    t.disabled = 1;
    await writeDoc(db, "tokens.json", tokens);
  }
  return json({ success: true, message: "删除 API Token 成功" });
}

async function handleAdminExportTools({ db }) {
  const tools = await readDoc(db, "tools.json", []);
  return json({ success: true, message: "导出工具成功", data: tools });
}

async function handleAdminImportTools({ db, body }) {
  if (!Array.isArray(body)) return json({ success: false, errorMessage: "数据格式错误" }, 400);
  const existing = await readDoc(db, "tools.json", []);
  const catelogs = await readDoc(db, "catelogs.json", []);
  const catNames = new Set(catelogs.map((c) => c.name));
  for (const v of body) {
    v.id = v.id || nextId(existing);
    existing.push({ sort: 0, hide: false, ...v });
    if (v.catelog && String(v.catelog).trim() && !catNames.has(v.catelog)) {
      catNames.add(v.catelog);
      catelogs.push({ id: nextId(catelogs), name: v.catelog, sort: catelogs.length + 1, hide: false });
    }
  }
  await writeDoc(db, "tools.json", existing);
  await writeDoc(db, "catelogs.json", catelogs);
  return json({ success: true, message: "导入工具成功" });
}

/** 账号密码已交由 Zero Trust 管理，这里只做提示，不再存任何凭据 */
async function handleAdminUpdateUser() {
  return json({
    success: true,
    message: "管理员身份由 Cloudflare Zero Trust 统一管理，无需在此设置账号密码",
  });
}

async function handleAdminUpdateSetting({ db, body }) {
  const setting = await readDoc(db, "setting.json", DEFAULT_SETTING);
  await writeDoc(db, "setting.json", { ...setting, ...(body || {}) });
  return json({ success: true, message: "更新配置成功" });
}

async function handleAdminUpdateSiteConfig({ db, body }) {
  const siteConfig = await readDoc(db, "siteConfig.json", DEFAULT_SITE_CONFIG);
  await writeDoc(db, "siteConfig.json", { ...siteConfig, ...(body || {}) });
  return json({ success: true, message: "更新网站配置成功" });
}

async function handleAdminCreateTool({ db, ctx, body }) {
  const data = body || {};
  if (!data.name || !data.url) {
    return json({ success: false, errorMessage: "名称和 URL 不能为空" }, 400);
  }
  const tools = await readDoc(db, "tools.json", []);
  const id = nextId(tools);
  tools.push({
    id,
    name: data.name,
    url: data.url,
    logo: data.logo || "",
    catelog: data.catelog || "",
    desc: data.desc || "",
    sort: data.sort || 0,
    hide: !!data.hide,
  });
  await writeDoc(db, "tools.json", tools);
  if (!data.logo) ctx.waitUntil(lazyFetchLogo(db, id).catch(() => {}));
  return json({ success: true, message: "添加成功" });
}

async function handleAdminDeleteTool({ db, params }) {
  const tools = await readDoc(db, "tools.json", []);
  const idx = tools.findIndex((t) => String(t.id) === params.id);
  if (idx >= 0) tools.splice(idx, 1);
  await writeDoc(db, "tools.json", tools);
  return json({ success: true, message: "删除成功" });
}

async function handleAdminUpdateTool({ db, ctx, body, params }) {
  const data = body || {};
  const tools = await readDoc(db, "tools.json", []);
  const tool = tools.find((t) => String(t.id) === String(params.id));
  if (tool) {
    Object.assign(tool, data);
    await writeDoc(db, "tools.json", tools);
    if (!data.logo) ctx.waitUntil(lazyFetchLogo(db, tool.id).catch(() => {}));
  }
  return json({ success: true, message: "更新成功" });
}

async function handleAdminSortTools({ db, body }) {
  if (!Array.isArray(body)) return json({ success: false, errorMessage: "数据格式错误" }, 400);
  const tools = await readDoc(db, "tools.json", []);
  const map = new Map(tools.map((t) => [Number(t.id), t]));
  for (const u of body) {
    const t = map.get(Number(u.id));
    if (t) t.sort = u.sort;
  }
  await writeDoc(db, "tools.json", tools);
  return json({ success: true, message: "更新排序成功" });
}

async function handleAdminCreateCatelog({ db, body }) {
  const data = body || {};
  if (!data.name) return json({ success: false, errorMessage: "名称不能为空" }, 400);
  const catelogs = await readDoc(db, "catelogs.json", []);
  catelogs.push({
    id: nextId(catelogs),
    name: data.name,
    sort: data.sort || catelogs.length + 1,
    hide: !!data.hide,
  });
  await writeDoc(db, "catelogs.json", catelogs);
  return json({ success: true, message: "增加分类成功" });
}

async function handleAdminDeleteCatelog({ db, params }) {
  const catelogs = await readDoc(db, "catelogs.json", []);
  const idx = catelogs.findIndex((c) => String(c.id) === params.id);
  if (idx >= 0) catelogs.splice(idx, 1);
  await writeDoc(db, "catelogs.json", catelogs);
  return json({ success: true, message: "删除分类成功" });
}

async function handleAdminUpdateCatelog({ db, body, params }) {
  const data = body || {};
  const catelogs = await readDoc(db, "catelogs.json", []);
  const cat = catelogs.find((c) => String(c.id) === String(params.id));
  if (cat) {
    Object.assign(cat, data);
    await writeDoc(db, "catelogs.json", catelogs);
  }
  return json({ success: true, message: "更新分类成功" });
}

async function handleAdminListSearchEngine({ db }) {
  const engines = await readDoc(db, "searchEngines.json", DEFAULT_SEARCH_ENGINES);
  return json({ success: true, data: engines });
}

async function handleAdminCreateSearchEngine({ db, body }) {
  const engines = await readDoc(db, "searchEngines.json", DEFAULT_SEARCH_ENGINES);
  const id = nextId(engines);
  engines.push({
    id,
    name: body?.name || "",
    baseUrl: body?.baseUrl || "",
    queryParam: body?.queryParam || "q",
    logo: body?.logo || "",
    sort: body?.sort || engines.length + 1,
    enabled: body?.enabled !== false,
  });
  await writeDoc(db, "searchEngines.json", engines);
  return json({ success: true, message: "添加搜索引擎成功", data: { id } });
}

async function handleAdminUpdateSearchEngine({ db, body, params }) {
  const engines = await readDoc(db, "searchEngines.json", DEFAULT_SEARCH_ENGINES);
  const engine = engines.find((e) => String(e.id) === String(params.id));
  if (engine) {
    Object.assign(engine, body, { id: engine.id });
    await writeDoc(db, "searchEngines.json", engines);
  }
  return json({ success: true, message: "更新搜索引擎成功" });
}

async function handleAdminDeleteSearchEngine({ db, params }) {
  const engines = await readDoc(db, "searchEngines.json", DEFAULT_SEARCH_ENGINES);
  const idx = engines.findIndex((e) => String(e.id) === String(params.id));
  if (idx >= 0) engines.splice(idx, 1);
  await writeDoc(db, "searchEngines.json", engines);
  return json({ success: true, message: "删除搜索引擎成功" });
}

async function handleAdminSortSearchEngines({ db, body }) {
  if (!Array.isArray(body)) return json({ success: false, errorMessage: "数据格式错误" }, 400);
  const engines = await readDoc(db, "searchEngines.json", DEFAULT_SEARCH_ENGINES);
  const map = new Map(engines.map((e) => [Number(e.id), e]));
  for (const u of body) {
    const e = map.get(Number(u.id));
    if (e) e.sort = u.sort;
  }
  await writeDoc(db, "searchEngines.json", engines);
  return json({ success: true, message: "更新排序成功" });
}

// ---------------- 路由 ----------------

// [方法, 路径模板, 处理函数, 是否需要管理员]
const ROUTES = [
  ["GET", "/", handleIndex, false],
  ["GET", "/session", handleSession, false],
  ["POST", "/login", handleLogin, false],
  ["GET", "/logout", handleLogout, false],
  ["GET", "/searchEngines", handleSearchEngines, false],
  ["GET", "/img", handleImg, false],

  ["GET", "/admin/all", handleAdminAll, true],
  ["POST", "/admin/apiToken", handleAdminCreateToken, true],
  ["DELETE", "/admin/apiToken/:id", handleAdminDeleteToken, true],
  ["GET", "/admin/exportTools", handleAdminExportTools, true],
  ["POST", "/admin/importTools", handleAdminImportTools, true],
  ["PUT", "/admin/user", handleAdminUpdateUser, true],
  ["PUT", "/admin/setting", handleAdminUpdateSetting, true],
  ["PUT", "/admin/siteConfig", handleAdminUpdateSiteConfig, true],
  ["POST", "/admin/tool", handleAdminCreateTool, true],
  ["DELETE", "/admin/tool/:id", handleAdminDeleteTool, true],
  ["PUT", "/admin/tool/:id", handleAdminUpdateTool, true],
  ["PUT", "/admin/tools/sort", handleAdminSortTools, true],
  ["POST", "/admin/catelog", handleAdminCreateCatelog, true],
  ["DELETE", "/admin/catelog/:id", handleAdminDeleteCatelog, true],
  ["PUT", "/admin/catelog/:id", handleAdminUpdateCatelog, true],
  ["GET", "/admin/searchEngine", handleAdminListSearchEngine, true],
  ["POST", "/admin/searchEngine", handleAdminCreateSearchEngine, true],
  ["PUT", "/admin/searchEngine/:id", handleAdminUpdateSearchEngine, true],
  ["DELETE", "/admin/searchEngine/:id", handleAdminDeleteSearchEngine, true],
  ["PUT", "/admin/searchEngines/sort", handleAdminSortSearchEngines, true],
];

function matchPath(path, pattern) {
  const a = path.split("/").filter(Boolean);
  const b = pattern.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < b.length; i += 1) {
    if (b[i].startsWith(":")) {
      params[b[i].slice(1)] = decodeURIComponent(a[i]);
    } else if (b[i] !== a[i]) {
      return null;
    }
  }
  return params;
}

async function readBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return null;
  try {
    return await request.json();
  } catch (e) {
    return null;
  }
}

export async function onRequest(context) {
  const { request, env, ctx } = context;
  const db = env.DB;
  const url = new URL(request.url);

  let path = url.pathname.replace(/^\/api/, "");
  if (!path.startsWith("/")) path = "/" + path;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  const method = request.method.toUpperCase();

  if (!db) {
    return json(
      {
        success: false,
        errorMessage:
          "D1 绑定 DB 不存在。请在 Pages 项目 Settings → Functions → D1 database bindings 添加绑定（变量名 DB），或填写 wrangler.toml 里的 database_id 后重新部署。",
      },
      500
    );
  }

  for (const [m, pattern, handler, needAdmin] of ROUTES) {
    if (m !== method) continue;
    const params = matchPath(path, pattern);
    if (!params) continue;

    let guard = null;
    if (needAdmin) {
      guard = await requireAdmin(request, env, db);
      if (!guard.ok) return json({ success: false, errorMessage: guard.errorMessage }, guard.status);
    }

    const body = method === "GET" || method === "HEAD" ? null : await readBody(request);
    return handler({ request, env, ctx, db, url, params, body, guard });
  }

  return json({ success: false, errorMessage: "接口不存在" }, 404);
}
