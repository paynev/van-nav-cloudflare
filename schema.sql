-- van-nav 数据表结构
-- 执行：npx wrangler d1 execute van-nav-db --remote --file=./schema.sql
--
-- 项目沿用「文档存储」模型：所有业务数据（工具 / 分类 / 站点配置 / 搜索引擎 /
-- API Token / 签名密钥）都以 JSON 文本存在 docs 表里，键名与旧版一致
-- （tools.json、catelogs.json、setting.json、siteConfig.json、searchEngines.json、
--   tokens.json、secret.json），首次访问接口时若文档不存在会自动写入默认值，
-- 所以这张表建好后不需要再手动插数据。

CREATE TABLE IF NOT EXISTS docs (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_docs_updated_at ON docs (updated_at);
