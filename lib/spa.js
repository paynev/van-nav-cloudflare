/**
 * 给 /admin 和 /login 这两个页面路由提供 SPA 外壳 + Zero Trust 门禁。
 *
 * 前端是已构建好的 React SPA（仓库里只有 static/ 产物，没有源码），
 * 它的后台布局会检查 localStorage._token，没有就跳 /login。
 * 我们在服务端把 index.html 拿出来，注入一段 bootstrap 脚本：
 * 同步请求 /api/session，用 Zero Trust 身份换取会话 token 写进 localStorage，
 * 这样前端不用改一行代码就能工作。
 */

import { accessConfig, verifyAccessToken, readAccessCookie } from "./access.js";

const BOOTSTRAP = (redirectToAdmin) => `
<script>
/* van-nav: Cloudflare Zero Trust 会话引导（由 Worker 在服务端注入） */
(function () {
  try {
    var x = new XMLHttpRequest();
    x.open("GET", "/api/session", false);
    x.setRequestHeader("Accept", "application/json");
    x.send();
    if (x.status === 200) {
      var d = JSON.parse(x.responseText);
      if (d && d.success && d.data && d.data.token) {
        localStorage.setItem("_token", d.data.token);
      } else {
        localStorage.removeItem("_token");
      }
    } else {
      localStorage.removeItem("_token");
    }
  } catch (e) {}
  ${
    redirectToAdmin
      ? 'if (localStorage.getItem("_token") && location.pathname === "/login") { location.replace("/admin"); }'
      : ""
  }
})();
</script>`;

function html(body, status) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function errorPage(title, detail) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1f2328;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:32px 36px;max-width:640px;box-shadow:0 4px 16px rgba(0,0,0,.05)}
h1{margin:0 0 12px;font-size:19px}p{margin:0 0 10px;line-height:1.7;font-size:14px;color:#4a5058}
code{background:#f2f4f7;border-radius:4px;padding:1px 5px;font-size:13px}</style></head>
<body><div class="card"><h1>${title}</h1>${detail}</div></body></html>`;
}

export function notConfiguredPage(missing) {
  return errorPage(
    "尚未配置 Cloudflare Zero Trust",
    `<p>后台已改为 Zero Trust 认证，但还缺少环境变量：<code>${missing.join("</code>、<code>")}</code>。</p>
     <p>请在 Worker 的 <b>Settings → Variables and Secrets</b>（或 wrangler.toml 的 <code>[vars]</code>）里添加后重新部署：</p>
     <p><code>CF_ACCESS_TEAM_DOMAIN</code> = 你的团队域名，例如 <code>yourteam.cloudflareaccess.com</code><br/>
        <code>CF_ACCESS_AUD</code> = Zero Trust 后台应用的 Audience Tag</p>`
  );
}

/**
 * 校验 Zero Trust 身份并渲染后台页面。
 * 返回 null 表示通过（调用方继续渲染），否则返回应直接返回的 Response。
 */
async function gate(request, env) {
  const cfg = accessConfig(env);
  if (!cfg.ready) {
    return html(notConfiguredPage(cfg.missing), 500);
  }
  const payload = await verifyAccessToken(readAccessCookie(request), cfg);
  if (!payload || payload.error) {
    return html(
      errorPage(
        "未通过 Zero Trust 认证",
        `<p>访问 <code>/admin</code> 需要先通过 Cloudflare Zero Trust 的身份认证。</p>
         <p>如果你已经在 Zero Trust 里登录过仍看到本页，请检查 Access 应用的路径是否覆盖了 <code>/admin*</code>，
         以及 <code>CF_ACCESS_AUD</code> 是否与应用的 Audience Tag 一致。</p>`
      ),
      401
    );
  }
  return null;
}

/** 渲染 /admin 与 /login：Zero Trust 门禁 + 注入会话引导脚本 */
export async function serveAdminSpa(request, env, options = {}) {
  const denied = await gate(request, env);
  if (denied) return denied;

  const asset = await env.ASSETS.fetch(new Request(new URL("/index.html", request.url).toString()));
  if (!asset || !asset.ok) {
    return html(errorPage("缺少 index.html", "<p>静态资源里没有找到 <code>index.html</code>，请检查 wrangler.toml 的 <code>[assets] directory</code>。</p>"), 500);
  }

  const raw = await asset.text();
  const injected = raw.includes("</head>")
    ? raw.replace("</head>", `${BOOTSTRAP(options.redirectToAdmin)}</head>`)
    : raw + BOOTSTRAP(options.redirectToAdmin);

  return html(injected, 200);
}
