/**
 * HS256 JWT —— 用 Web Crypto 实现，不依赖 jsonwebtoken（Workers 运行时没有 Node crypto）。
 * 用于签发「本站会话 token」：前端 localStorage._token 存的就是它。
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

function bytesToB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function importKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** 签发一个 HS256 JWT */
export async function signJwt(payload, secret) {
  const head = bytesToB64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = bytesToB64url(enc.encode(JSON.stringify(payload)));
  const data = `${head}.${body}`;
  const sig = await crypto.subtle.sign("HMAC", await importKey(secret), enc.encode(data));
  return `${data}.${bytesToB64url(new Uint8Array(sig))}`;
}

/** 校验 HS256 JWT，失败返回 null */
export async function verifyJwt(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await importKey(secret),
      b64urlToBytes(s),
      enc.encode(`${h}.${p}`)
    );
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64urlToBytes(p)));
    if (payload && payload.exp && payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}
