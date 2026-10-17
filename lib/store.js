/**
 * D1 文档存储 —— 一张 docs 表存所有 JSON 文档。
 *
 * 之所以不做成多张业务表：本项目是从 Go/Gin + SQLite 迁来的，
 * 原实现就是「整存整取」的文档模型（tools.json / catelogs.json / setting.json ...）。
 * 保持同样的文档语义可以让 API 响应结构与前端零改动对齐，迁移风险最小。
 */

export const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS docs (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);`;

// 同一个 isolate 内只建一次表（不同 isolate 各自建一次，IF NOT EXISTS 幂等）
let initPromise = null;

function ensureSchema(db) {
  if (!initPromise) {
    initPromise = db
      .prepare(SCHEMA_SQL)
      .run()
      .catch(() => null);
  }
  return initPromise;
}

/** 读一个文档，不存在则写入 fallback 并返回 */
export async function readDoc(db, key, fallback) {
  if (!db) throw new Error("D1 绑定 DB 不存在，请检查 wrangler.toml 或 Pages 项目的 D1 绑定");
  await ensureSchema(db);
  try {
    const row = await db.prepare("SELECT v FROM docs WHERE k = ?").bind(key).first();
    if (!row) {
      await writeDoc(db, key, fallback);
      return fallback;
    }
    return JSON.parse(row.v);
  } catch (e) {
    return fallback;
  }
}

/** 写一个文档（upsert） */
export async function writeDoc(db, key, value) {
  if (!db) throw new Error("D1 绑定 DB 不存在，请检查 wrangler.toml 或 Pages 项目的 D1 绑定");
  await ensureSchema(db);
  await db
    .prepare(
      "INSERT INTO docs (k, v, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at"
    )
    .bind(key, JSON.stringify(value), Date.now())
    .run();
}

/** 会话 token 的签名密钥：首次使用时生成并落库，之后复用 */
export async function getJwtSecret(db) {
  const doc = await readDoc(db, "secret.json", null);
  if (doc && doc.secret) return doc.secret;
  const secret =
    crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await writeDoc(db, "secret.json", { secret });
  return secret;
}
