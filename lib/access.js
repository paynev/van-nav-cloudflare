/**
 * Cloudflare Zero Trust（Access）校验。
 *
 * 用户在 /admin 通过 Access 认证后，Cloudflare 会下发一个 HttpOnly 的
 * CF_Authorization cookie，里面是一个 RS256 JWT。我们在服务端用
 * Access 团队域名的 JWKS 公钥验签，才认这个请求是管理员。
 *
 * 这样做的好处：即使 Access 的 Application 路径规则配错了，
 * 函数层面依然会拒绝，不会出现「绕过页面直接打 API」的情况。
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlToBytes(s) {
  let t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export const COOKIE_NAME = "CF_Authorization";

/** 读取 Zero Trust 配置；未配置时 ready 为 false，调用方应给出明确提示 */
export function accessConfig(env) {
  const teamDomain = String(env?.CF_ACCESS_TEAM_DOMAIN || "").trim();
  const aud = String(env?.CF_ACCESS_AUD || "").trim();
  const missing = [];
  if (!teamDomain) missing.push("CF_ACCESS_TEAM_DOMAIN");
  if (!aud) missing.push("CF_ACCESS_AUD");
  return { teamDomain, aud, missing, ready: missing.length === 0 };
}

// JWKS 缓存：同一个 isolate 内 6 小时拉一次
let jwksCache = { keys: null, at: 0, domain: "" };

async function getJwks(teamDomain) {
  if (jwksCache.keys && jwksCache.domain === teamDomain && Date.now() - jwksCache.at < 6 * 3600 * 1000) {
    return jwksCache.keys;
  }
  const resp = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`拉取 Zero Trust 证书失败（HTTP ${resp.status}）`);
  const j = await resp.json();
  jwksCache = { keys: j.keys || [], at: Date.now(), domain: teamDomain };
  return jwksCache.keys;
}

/**
 * 校验 Access JWT。
 * 返回 payload（成功）/ null（无效）/ { error: "not_configured" }（未配置环境变量）
 */
export async function verifyAccessToken(token, { teamDomain, aud }) {
  if (!teamDomain) return { error: "not_configured" };
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;

  let header;
  try {
    header = JSON.parse(dec.decode(b64urlToBytes(parts[0])));
  } catch (e) {
    return null;
  }
  if (header.alg !== "RS256") return null;

  const keys = await getJwks(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]),
      enc.encode(`${parts[0]}.${parts[1]}`)
    );
  } catch (e) {
    return null;
  }
  if (!ok) return null;

  let payload;
  try {
    payload = JSON.parse(dec.decode(b64urlToBytes(parts[1])));
  } catch (e) {
    return null;
  }

  if (payload.exp && payload.exp * 1000 <= Date.now()) return null;
  if (payload.iss !== `https://${teamDomain}`) return null;
  // aud：Access 应用的 Audience Tag，务必校验，否则别的 Access 应用签发的 token 也能进来
  if (aud && payload.aud !== aud) return null;

  return payload;
}

/** 从请求里取出 CF_Authorization cookie */
export function readAccessCookie(request) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === COOKIE_NAME) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch (e) {
        return part.slice(i + 1).trim();
      }
    }
  }
  return "";
}

/** 把 Access payload 归一成管理员身份 */
export function identityFromAccess(payload) {
  return {
    name: payload.email || payload.sub || "admin",
    id: payload.sub || payload.email || "unknown",
    source: "zero-trust",
  };
}
