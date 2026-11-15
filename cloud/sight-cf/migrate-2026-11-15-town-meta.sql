-- ------------------------------------------------------------------
-- 本城设定（2026-11-15）
--
-- 只加一张表，不动任何老表、不改任何主键。跑法：
--
--   wrangler d1 execute coop-sight --remote --file=migrate-2026-11-15-town-meta.sql
--
-- 表是空的就表示「还没设过」—— 读的时候会退到内置默认值（浅水埠），
-- 不是报错、也不是空白。**所以这张表可以晚建、可以先不建**，
-- 只要 `/admin/town` 里那次写入有 try/catch 兜着。
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS town_meta (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  origin  TEXT NOT NULL DEFAULT '',
  streets TEXT NOT NULL DEFAULT '[]',
  rules   TEXT NOT NULL DEFAULT '[]',
  at      TEXT NOT NULL
);
