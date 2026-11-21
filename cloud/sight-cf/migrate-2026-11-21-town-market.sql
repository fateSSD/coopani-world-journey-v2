-- 迁移：L2 芦花塘市集（town / stalls / deals 三张表 + 索引，2026-11-21）
-- 部署时对已有库执行：
--   npx wrangler d1 execute coop-sight --remote --file=./migrate-2026-11-21-town-market.sql

CREATE TABLE IF NOT EXISTS town (
  uid        TEXT PRIMARY KEY,
  pet        TEXT NOT NULL,
  street     TEXT NOT NULL DEFAULT '',
  lane       INTEGER NOT NULL DEFAULT 0,
  at         TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_town_exp ON town (expires_at);
CREATE INDEX IF NOT EXISTS idx_town_at  ON town (at DESC);

CREATE TABLE IF NOT EXISTS stalls (
  id         TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  seller     TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'goods',
  item       TEXT NOT NULL,
  price      INTEGER NOT NULL,
  stock      INTEGER NOT NULL,
  fresh_veg  INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stalls_exp ON stalls (expires_at);
CREATE INDEX IF NOT EXISTS idx_stalls_at  ON stalls (at DESC);

CREATE TABLE IF NOT EXISTS deals (
  id         TEXT PRIMARY KEY,
  stall_id   TEXT NOT NULL,
  seller_uid TEXT NOT NULL,
  buyer_uid  TEXT NOT NULL DEFAULT '',
  buyer_pet  TEXT NOT NULL,
  item       TEXT NOT NULL,
  qty        INTEGER NOT NULL DEFAULT 1,
  note       TEXT NOT NULL DEFAULT '',
  seen       INTEGER NOT NULL DEFAULT 0,
  at         TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deals_seller ON deals (seller_uid, at DESC);
CREATE INDEX IF NOT EXISTS idx_deals_unseen ON deals (seller_uid, seen, at DESC);
CREATE INDEX IF NOT EXISTS idx_deals_exp    ON deals (expires_at);
CREATE INDEX IF NOT EXISTS idx_deals_at     ON deals (at DESC);
