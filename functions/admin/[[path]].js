/**
 * /admin 与 /admin/* —— 后台页面
 *
 * 前端是纯静态 SPA，目录下并没有 admin.html，
 * 所以这里从静态资源里取 index.html 返回，并做 Zero Trust 门禁 + 会话引导注入。
 *
 * 生产环境建议在 Zero Trust 里再配一条 Access 应用覆盖 /admin*，
 * 由 Cloudflare 在边缘完成登录跳转；这里的校验是第二道防线。
 */

import { serveAdminSpa } from "../../lib/spa.js";

export async function onRequest(context) {
  return serveAdminSpa(context.request, context.env, { redirectToAdmin: false });
}
