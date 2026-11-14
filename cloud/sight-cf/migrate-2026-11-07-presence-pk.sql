-- 2026-11-07 · presence 主键去掉 city
--
-- ⚠️ **这份脚本 11-07 写完之后没有在线上跑过，11-10 才补跑。**
--
-- 代价很实在：代码那边 11-09 20:38（北京时间）把 worker 换成
-- `ON CONFLICT(uid, date_key, slot)` 的版本，而线上表的主键还是
-- `(uid, city, date_key, slot)`。SQLite 遇到「冲突目标不对应任何主键/唯一约束」
-- 是直接报错的 —— 于是**每一次上报都 500**，从那一刻起整整一天，
-- 池子里一条新数据都没进（读接口全是好的，所以面板看着没坏，只是数字不动）。
--
-- 记忆点：**改了 upsert 的冲突目标，就必须同步改表，两者得在同一次发布里对齐。**
-- 现有的单测用的是假 D1（不真的解析 SQL），这类不一致它抓不到；
-- `test/sight-cf-schema.test.mjs` 就是这次补的静态对账。
--
-- ## 为什么改
--
-- 旧主键是 (uid, city, date_key, slot)：**换一座城就是多一行**。
-- 一天跑两城 = 8 行，四天留存就是 32 行 —— 管理面板上那只显示「31」的鱼就是这么来的
-- （那一列是「上报」，统计的是行数，不是发了几条消息）。
--
-- 而 `/sight/status` 每次都要 `SELECT COUNT(DISTINCT uid) FROM presence WHERE date_key=?`，
-- 把当天所有行扫一遍。行数直接乘进 D1 的读取额度，只数一多就是平方级开销。
-- 去掉 city 之后：一只鱼一天最多 4 行（4 个时段），全表小 2–8 倍，语义不变。
--
-- ## 怎么跑
--
--   npx wrangler d1 execute coop-sight --remote --file=./migrate-2026-11-07-presence-pk.sql
--
-- ## 回滚
--
-- 结构变更没法原地回退，但**数据是可再生**的：presence 只存「最近 4 天谁在哪」，
-- 客户端下一次上报就会重建。真要回退，把 schema.sql 里的主键改回去、
-- 重新执行一次「建新表 → 拷数据 → 换名」即可，中间最多丢一天的行。

-- 1) 新表（结构照 schema.sql，主键已去掉 city）
CREATE TABLE presence_v2 (
  uid        TEXT NOT NULL,
  pet        TEXT NOT NULL,
  city       TEXT NOT NULL,
  date_key   TEXT NOT NULL,
  slot       TEXT NOT NULL,
  doing      TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL,
  ip_hash    TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (uid, date_key, slot)
);

-- 2) 搬数据。同一 (uid, date, slot) 有多行时**只留最新那条**（旧主键才可能重复）。
INSERT INTO presence_v2 (uid, pet, city, date_key, slot, doing, at, ip_hash, token_hash)
SELECT uid, pet, city, date_key, slot, doing, at, ip_hash, token_hash
  FROM (
    SELECT p.*,
           ROW_NUMBER() OVER (PARTITION BY uid, date_key, slot ORDER BY at DESC) AS rn
      FROM presence p
  )
 WHERE rn = 1;

-- 3) 换名
DROP TABLE presence;
ALTER TABLE presence_v2 RENAME TO presence;

-- 4) 索引重建（原来三个都在旧表上，随 DROP 一起没了）
--
-- ⚠️ `idx_presence_uid` 原稿漏了。它不在建表语句里，是 schema.sql 末尾单独
-- 建的（2026-11-05 为 `/admin/pets` 的 `GROUP BY uid` 加的）。漏掉不会报错，
-- 只是之后再进管鱼面板，那个随时子查询会退化成全表扫描 —— 面板一开就烧 D1 读取额度。
-- 2026-11-10 补上。
CREATE INDEX IF NOT EXISTS idx_presence_query
  ON presence (city, date_key, slot, at DESC);
CREATE INDEX IF NOT EXISTS idx_presence_date
  ON presence (date_key);
CREATE INDEX IF NOT EXISTS idx_presence_uid
  ON presence (uid, at DESC);
CREATE INDEX IF NOT EXISTS idx_presence_at
  ON presence (at);
CREATE INDEX IF NOT EXISTS idx_presence_at_uid
  ON presence (at, uid);

-- 5) 自检：行数应该 ≤ 旧表行数（去重只会变少），且每只每天 ≤ 4 行
SELECT COUNT(*) AS rows_now FROM presence;
SELECT MAX(n) AS max_rows_per_pet_day FROM (
  SELECT COUNT(*) AS n FROM presence GROUP BY uid, date_key
);
