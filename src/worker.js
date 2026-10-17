/**
 * van-nav —— Cloudflare Worker 入口（静态资源 + API + 后台门禁）
 *
 * 由 Pages Functions 版改写：三个 Functions 文件（api / admin / login）合并成单个 Worker，
 * 静态前端通过 assets 绑定（env.ASSETS）提供，业务代码完全复用。
 *
 * 路由优先级（[assets] run_worker_first = true，所以请求一律先进这里）：
 *   /api/*   → src/api.js，接口层
 *   /admin*  → Zero Trust 门禁 + 注入会话引导脚本后的 SPA 外壳
 *   /login   → 同上，拿到会话后自动回跳 /admin
 *   其他     → 静态资源（前端构建产物，位于 public/）
 */

import { handleApi } from "./api.js";
import { serveAdminSpa } from "../lib/spa.js";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return handleApi({ request, env, ctx });
    }

    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      return serveAdminSpa(request, env, { redirectToAdmin: false });
    }

    if (pathname === "/login") {
      return serveAdminSpa(request, env, { redirectToAdmin: true });
    }

    if (!env.ASSETS) {
      return new Response("静态资源绑定 ASSETS 不存在，请检查 wrangler.toml 的 [assets] 段落。", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
