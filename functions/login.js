/**
 * /login —— 旧前端登录页
 *
 * 前端在收到 401 时会硬跳到 /login，所以这个路径必须存在且同样受 Zero Trust 保护。
 * 拿到会话 token 后 bootstrap 脚本会自动把用户送回 /admin。
 */

import { serveAdminSpa } from "../lib/spa.js";

export async function onRequest(context) {
  return serveAdminSpa(context.request, context.env, { redirectToAdmin: true });
}
