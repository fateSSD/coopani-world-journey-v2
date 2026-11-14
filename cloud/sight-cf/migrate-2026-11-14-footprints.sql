-- ------------------------------------------------------------------
-- 足迹：她去过哪些城（2026-11-14）
--
-- ## 为什么加这张表
--
-- `presence` 只留 4 天 —— 那是「池子」的数据，不是她的履历。
-- 一只鱼跑三个月，去过四十几座城，`presence` 里一行都留不下。
-- 客户端有 `everVisited`（城市 id 数组），但**只在本机**：
-- 换电脑、清缓存、重装，履历就断了。而这是**不可再生**的数据 ——
-- 过去的事没法重演，丢了就是丢了。
--
-- ## 只存最少的东西
--
-- `uid + city + 首末时间 + 次数`，没有名字、没有在干嘛、没有具体时刻表。
-- 泄露的只是「某个匿名 id 去过西安」，而换机不丢这点，比城市名的隐私重要。
--
-- ## 为什么不在每次心跳里 upsert
--
-- 心跳一天 72 次 × 162 只 ≈ 1.16 万行写入/天，全部浪费 ——
-- 足迹只在「到达一座新城」时才该变。所以写入由客户端的 `journey.arrive`
-- 触发，一天最多几次。这是**唯一**的写入点，别为了"顺便"把它挂到上报上去。
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS footprints (
  -- 她的匿名标识，跟 presence 同一套。
  uid      TEXT NOT NULL,
  -- 城市 id（`xian` 这种）。
  city     TEXT NOT NULL,
  -- 第一次到这城、最后一次到这城（ISO8601，真实时刻）。
  first_at TEXT NOT NULL,
  last_at  TEXT NOT NULL,
  -- 到过几次。重游同一座城会 +1。
  visits   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (uid, city)
);

-- 取一只鱼的全部足迹时走它（`WHERE uid = ?1 ORDER BY last_at DESC`）。
CREATE INDEX IF NOT EXISTS idx_footprints_uid
  ON footprints (uid, last_at DESC);
