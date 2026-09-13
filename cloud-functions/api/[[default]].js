import express from "express";
import jwt from "jsonwebtoken";
import { getStore } from "@edgeone/pages-blob";

/**
 * van-nav — EdgeOne Makers 版
 * 原 Go/Gin + SQLite 后端改写为 Node.js 云函数 + Blob 存储。
 * API 响应结构与原版保持一致：{ success, message?, data?, errorMessage? }
 */

const app = express();
app.use(express.json({ limit: "6mb" }));

const store = getStore({ name: "van-nav-db", consistency: "strong" });

// ---------------- 存储层 ----------------

async function readDoc(key, fallback) {
  try {
    const v = await store.get(key, { type: "json" });
    if (v === null || v === undefined) {
      await store.setJSON(key, fallback);
      return fallback;
    }
    return v;
  } catch (e) {
    return fallback;
  }
}

async function writeDoc(key, value) {
  await store.setJSON(key, value);
}

async function getJwtSecret() {
  const doc = await readDoc("secret.json", null);
  if (doc && doc.secret) return doc.secret;
  const secret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await writeDoc("secret.json", { secret });
  return secret;
}

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

function nextId(existing) {
  let id = Math.floor(Date.now() / 1000);
  const ids = new Set(existing.map((x) => Number(x.id)));
  while (ids.has(id)) id += 1;
  return id;
}

async function ensureUser() {
  const user = await readDoc("user.json", null);
  if (!user) {
    const u = { id: nextId([]), name: "admin", password: "admin" };
    await writeDoc("user.json", u);
    return u;
  }
  return user;
}

async function ensureSearchEngines() {
  return readDoc("searchEngines.json", DEFAULT_SEARCH_ENGINES);
}

// ---------------- 鉴权 ----------------

async function parseToken(req) {
  const raw = req.headers["authorization"];
  if (!raw) return null;
  try {
    const secret = await getJwtSecret();
    const payload = jwt.verify(raw, secret);
    return payload;
  } catch (e) {
    return null;
  }
}

function unauthorized(res) {
  return res.status(401).json({ success: false, errorMessage: "未登录或登录已过期" });
}

async function requireAuth(req, res, next) {
  const payload = await parseToken(req);
  if (!payload) return unauthorized(res);
  req.auth = payload;
  next();
}

// ---------------- 工具函数 ----------------

function filterHidden(tools, catelogs) {
  const hiddenCates = new Set(catelogs.filter((c) => c.hide).map((c) => c.name));
  return tools.filter((t) => !t.hide && !hiddenCates.has(t.catelog));
}

const PLACEHOLDER_ICO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAYAAACtWK6eAAAAWklEQVR4nO3BMQEAAADCoPVPbQlPoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgNcD1fgAAXK4f14AAAAASUVORK5CYII=",
  "base64"
);

function imgContentType(url) {
  const u = url.toLowerCase();
  if (u.includes(".svg")) return "image/svg+xml";
  if (u.includes(".png")) return "image/png";
  if (u.includes(".jpg") || u.includes(".jpeg")) return "image/jpeg";
  if (u.includes(".gif")) return "image/gif";
  if (u.includes(".webp")) return "image/webp";
  return "image/x-icon";
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.88 Safari/537.36";

// 带硬超时的 fetch（避免运行时 fetch 挂起导致请求卡死）
async function fetchWithTimeout(url, ms, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 从目标站点抓取图标 URL（对应原 goscraper 的简化实现）
function extractIconUrl(html, pageUrl) {
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
    const resp = await fetchWithTimeout(siteUrl, 8000, { "User-Agent": UA });
    if (!resp.ok) return "";
    const html = await resp.text();
    let icon = extractIconUrl(html, siteUrl);
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

// 抓取图片并转 base64 存入 Blob（对应原 UpdateImg）
async function cacheImage(url) {
  try {
    const resp = await fetchWithTimeout(url, 8000, { "User-Agent": UA });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0 || buf.length > 5 * 1024 * 1024) return null;
    const value = buf.toString("base64");
    await store.setJSON(`img/${encodeURIComponent(url)}.json`, { url, value });
    return value;
  } catch (e) {
    return null;
  }
}

// 添加/更新工具时 logo 为空则后台抓取（对应原 LazyFetchLogo）
async function lazyFetchLogo(toolId) {
  try {
    const tools = await readDoc("tools.json", []);
    const tool = tools.find((t) => Number(t.id) === Number(toolId));
    if (!tool) return;
    const iconUrl = await scrapeIconUrl(tool.url);
    if (iconUrl) {
      tool.logo = iconUrl;
      await writeDoc("tools.json", tools);
    }
  } catch (e) {
    /* 忽略 */
  }
}

// ---------------- 公开接口 ----------------

// GET /api/ — 首页全量数据
app.get("/", async (req, res) => {
  const payload = await parseToken(req);
  const loggedIn = !!payload;
  let tools = await readDoc("tools.json", []);
  let catelogs = await readDoc("catelogs.json", []);
  const setting = await readDoc("setting.json", DEFAULT_SETTING);
  const siteConfig = await readDoc("siteConfig.json", DEFAULT_SITE_CONFIG);
  if (!loggedIn) {
    tools = filterHidden(tools, catelogs);
    catelogs = catelogs.filter((c) => !c.hide);
  }
  const bySort = (a, b) => (a.sort || 0) - (b.sort || 0);
  res.json({
    success: true,
    data: {
      tools: [...tools].sort(bySort),
      catelogs: [...catelogs].sort(bySort),
      setting,
      siteConfig,
    },
  });
});

// POST /api/login
app.post("/login", async (req, res) => {
  const { name, password } = req.body || {};
  const user = await ensureUser();
  if (user.name !== name) {
    return res.json({ success: false, errorMessage: "用户名不存在" });
  }
  if (user.password !== password) {
    return res.json({ success: false, errorMessage: "密码错误" });
  }
  const secret = await getJwtSecret();
  const token = jwt.sign({ name: user.name, id: user.id, exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 }, secret);
  res.json({ success: true, message: "登录成功", data: { user, token } });
});

// GET /api/logout
app.get("/logout", (req, res) => res.json({ success: true, message: "登出成功" }));

// GET /api/searchEngines — 启用的搜索引擎
app.get("/searchEngines", async (req, res) => {
  const engines = await ensureSearchEngines();
  res.json({ success: true, data: engines.filter((e) => e.enabled).sort((a, b) => (a.sort || 0) - (b.sort || 0)) });
});

// GET /api/img?url= — 图标代理/缓存
app.get("/img", async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ success: false, errorMessage: "URL参数不能为空" });
  }
  // 整体限时 12 秒，任何情况下都要给出响应
  const result = await Promise.race([
    (async () => {
      const key = `img/${encodeURIComponent(url)}.json`;
      let value = null;
      const cached = await store.get(key, { type: "json" }).catch(() => null);
      if (cached && cached.value) {
        value = cached.value;
      } else {
        value = await cacheImage(url);
      }
      return value;
    })(),
    new Promise((resolve) => setTimeout(() => resolve(null), 12000)),
  ]);
  if (!result) {
    return res.status(404).json({ success: false, errorMessage: "未找到图片" });
  }
  const buf = Buffer.from(result, "base64");
  res.set("Content-Type", imgContentType(url));
  res.set("Cache-Control", "public, max-age=86400");
  res.send(buf);
});

// ---------------- 管理接口 ----------------

// GET /api/admin/all
app.get("/admin/all", requireAuth, async (req, res) => {
  const tools = await readDoc("tools.json", []);
  const catelogs = await readDoc("catelogs.json", []);
  const setting = await readDoc("setting.json", DEFAULT_SETTING);
  const siteConfig = await readDoc("siteConfig.json", DEFAULT_SITE_CONFIG);
  const tokens = await readDoc("tokens.json", []);
  const bySort = (a, b) => (a.sort || 0) - (b.sort || 0);
  res.json({
    success: true,
    data: {
      tools: [...tools].sort(bySort),
      catelogs: [...catelogs].sort(bySort),
      setting,
      siteConfig,
      user: { name: req.auth.name, id: req.auth.id },
      tokens,
    },
  });
});

// POST /api/admin/apiToken
app.post("/admin/apiToken", requireAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ success: false, errorMessage: "名称不能为空" });
  const tokens = await readDoc("tokens.json", []);
  const id = nextId(tokens);
  const secret = await getJwtSecret();
  const value = jwt.sign({ name, id, exp: Math.floor(Date.now() / 1000) + 100 * 365 * 24 * 3600 }, secret);
  tokens.push({ id, name, value, disabled: 0 });
  await writeDoc("tokens.json", tokens);
  res.json({ success: true, data: { id, Value: value, Name: name }, message: "添加 Token 成功" });
});

// DELETE /api/admin/apiToken/:id
app.delete("/admin/apiToken/:id", requireAuth, async (req, res) => {
  const tokens = await readDoc("tokens.json", []);
  const t = tokens.find((x) => String(x.id) === req.params.id);
  if (t) {
    t.disabled = 1;
    await writeDoc("tokens.json", tokens);
  }
  res.json({ success: true, message: "删除 API Token 成功" });
});

// GET /api/admin/exportTools
app.get("/admin/exportTools", requireAuth, async (req, res) => {
  const tools = await readDoc("tools.json", []);
  res.json({ success: true, message: "导出工具成功", data: tools });
});

// POST /api/admin/importTools
app.post("/admin/importTools", requireAuth, async (req, res) => {
  const tools = req.body;
  if (!Array.isArray(tools)) {
    return res.status(400).json({ success: false, errorMessage: "数据格式错误" });
  }
  const existing = await readDoc("tools.json", []);
  const catelogs = await readDoc("catelogs.json", []);
  const catNames = new Set(catelogs.map((c) => c.name));
  for (const v of tools) {
    v.id = v.id || nextId(existing);
    existing.push({ sort: 0, hide: false, ...v });
    if (v.catelog && String(v.catelog).trim() && !catNames.has(v.catelog)) {
      catNames.add(v.catelog);
      catelogs.push({ id: nextId(catelogs), name: v.catelog, sort: catelogs.length + 1, hide: false });
    }
  }
  await writeDoc("tools.json", existing);
  await writeDoc("catelogs.json", catelogs);
  res.json({ success: true, message: "导入工具成功" });
});

// PUT /api/admin/user
app.put("/admin/user", requireAuth, async (req, res) => {
  const { name, password } = req.body || {};
  const user = await ensureUser();
  if (name) user.name = name;
  if (password) user.password = password;
  await writeDoc("user.json", user);
  res.json({ success: true, message: "更新用户成功" });
});

// PUT /api/admin/setting
app.put("/admin/setting", requireAuth, async (req, res) => {
  const setting = await readDoc("setting.json", DEFAULT_SETTING);
  await writeDoc("setting.json", { ...setting, ...req.body });
  res.json({ success: true, message: "更新配置成功" });
});

// PUT /api/admin/siteConfig
app.put("/admin/siteConfig", requireAuth, async (req, res) => {
  const siteConfig = await readDoc("siteConfig.json", DEFAULT_SITE_CONFIG);
  await writeDoc("siteConfig.json", { ...siteConfig, ...req.body });
  res.json({ success: true, message: "更新网站配置成功" });
});

// POST /api/admin/tool
app.post("/admin/tool", requireAuth, async (req, res) => {
  const data = req.body || {};
  if (!data.name || !data.url) {
    return res.status(400).json({ success: false, errorMessage: "名称和 URL 不能为空" });
  }
  const tools = await readDoc("tools.json", []);
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
  await writeDoc("tools.json", tools);
  if (!data.logo) {
    lazyFetchLogo(id).catch(() => {});
  }
  res.json({ success: true, message: "添加成功" });
});

// DELETE /api/admin/tool/:id
app.delete("/admin/tool/:id", requireAuth, async (req, res) => {
  const tools = await readDoc("tools.json", []);
  const idx = tools.findIndex((t) => String(t.id) === req.params.id);
  if (idx >= 0) tools.splice(idx, 1);
  await writeDoc("tools.json", tools);
  res.json({ success: true, message: "删除成功" });
});

// PUT /api/admin/tool/:id
app.put("/admin/tool/:id", requireAuth, async (req, res) => {
  const data = req.body || {};
  const tools = await readDoc("tools.json", []);
  const tool = tools.find((t) => Number(t.id) === Number(data.id));
  if (tool) {
    Object.assign(tool, data);
    await writeDoc("tools.json", tools);
    if (!data.logo) {
      lazyFetchLogo(tool.id).catch(() => {});
    }
  }
  res.json({ success: true, message: "更新成功" });
});

// PUT /api/admin/tools/sort
app.put("/admin/tools/sort", requireAuth, async (req, res) => {
  const updates = req.body;
  if (!Array.isArray(updates)) {
    return res.status(400).json({ success: false, errorMessage: "数据格式错误" });
  }
  const tools = await readDoc("tools.json", []);
  const map = new Map(tools.map((t) => [Number(t.id), t]));
  for (const u of updates) {
    const t = map.get(Number(u.id));
    if (t) t.sort = u.sort;
  }
  await writeDoc("tools.json", tools);
  res.json({ success: true, message: "更新排序成功" });
});

// POST /api/admin/catelog
app.post("/admin/catelog", requireAuth, async (req, res) => {
  const data = req.body || {};
  if (!data.name) return res.status(400).json({ success: false, errorMessage: "名称不能为空" });
  const catelogs = await readDoc("catelogs.json", []);
  catelogs.push({
    id: nextId(catelogs),
    name: data.name,
    sort: data.sort || catelogs.length + 1,
    hide: !!data.hide,
  });
  await writeDoc("catelogs.json", catelogs);
  res.json({ success: true, message: "增加分类成功" });
});

// DELETE /api/admin/catelog/:id
app.delete("/admin/catelog/:id", requireAuth, async (req, res) => {
  const catelogs = await readDoc("catelogs.json", []);
  const idx = catelogs.findIndex((c) => String(c.id) === req.params.id);
  if (idx >= 0) catelogs.splice(idx, 1);
  await writeDoc("catelogs.json", catelogs);
  res.json({ success: true, message: "删除分类成功" });
});

// PUT /api/admin/catelog/:id
app.put("/admin/catelog/:id", requireAuth, async (req, res) => {
  const data = req.body || {};
  const catelogs = await readDoc("catelogs.json", []);
  const cat = catelogs.find((c) => Number(c.id) === Number(data.id));
  if (cat) {
    Object.assign(cat, data);
    await writeDoc("catelogs.json", catelogs);
  }
  res.json({ success: true, message: "更新分类成功" });
});

// GET /api/admin/searchEngine
app.get("/admin/searchEngine", requireAuth, async (req, res) => {
  const engines = await ensureSearchEngines();
  res.json({ success: true, data: engines });
});

// POST /api/admin/searchEngine
app.post("/admin/searchEngine", requireAuth, async (req, res) => {
  const engines = await ensureSearchEngines();
  const id = nextId(engines);
  engines.push({
    id,
    name: req.body?.name || "",
    baseUrl: req.body?.baseUrl || "",
    queryParam: req.body?.queryParam || "q",
    logo: req.body?.logo || "",
    sort: req.body?.sort || engines.length + 1,
    enabled: req.body?.enabled !== false,
  });
  await writeDoc("searchEngines.json", engines);
  res.json({ success: true, message: "添加搜索引擎成功", data: { id } });
});

// PUT /api/admin/searchEngine/:id
app.put("/admin/searchEngine/:id", requireAuth, async (req, res) => {
  const engines = await ensureSearchEngines();
  const engine = engines.find((e) => Number(e.id) === Number(req.params.id));
  if (engine) {
    Object.assign(engine, req.body, { id: engine.id });
    await writeDoc("searchEngines.json", engines);
  }
  res.json({ success: true, message: "更新搜索引擎成功" });
});

// DELETE /api/admin/searchEngine/:id
app.delete("/admin/searchEngine/:id", requireAuth, async (req, res) => {
  const engines = await ensureSearchEngines();
  const idx = engines.findIndex((e) => Number(e.id) === Number(req.params.id));
  if (idx >= 0) engines.splice(idx, 1);
  await writeDoc("searchEngines.json", engines);
  res.json({ success: true, message: "删除搜索引擎成功" });
});

// PUT /api/admin/searchEngines/sort
app.put("/admin/searchEngines/sort", requireAuth, async (req, res) => {
  const updates = req.body;
  if (!Array.isArray(updates)) {
    return res.status(400).json({ success: false, errorMessage: "数据格式错误" });
  }
  const engines = await ensureSearchEngines();
  const map = new Map(engines.map((e) => [Number(e.id), e]));
  for (const u of updates) {
    const e = map.get(Number(u.id));
    if (e) e.sort = u.sort;
  }
  await writeDoc("searchEngines.json", engines);
  res.json({ success: true, message: "更新排序成功" });
});

app.use((req, res) => {
  res.status(404).json({ success: false, errorMessage: "接口不存在" });
});

export default app;
