-- 碰面服务器的表结构（Cloudflare D1 = SQLite）
--
-- 部署时把这份整个粘进 D1 控制台的 SQL 编辑器跑一次，或者：
--   npx wrangler d1 execute coop-sight --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS presence (
  -- 她的匿名标识。本地随机生成一次，不跟账号、不跟硬件绑。
  uid       TEXT NOT NULL,
  -- 宠物名。**唯一会被别人看见的字段之一。**
  pet       TEXT NOT NULL,
  -- 城市 id（`xian` 这种），不是中文名 —— 中文名会重。
  city      TEXT NOT NULL,
  -- 当地日期，`YYYY-MM-DD`。
  date_key  TEXT NOT NULL,
  -- morning / afternoon / evening / night
  slot      TEXT NOT NULL,
  -- 在干嘛，一句话。**另一个会被别人看见的字段。**
  doing     TEXT NOT NULL DEFAULT '',
  -- 上报时刻（ISO8601）。只用来排序和限速，**永远不出接口**。
  at        TEXT NOT NULL,
  -- IP 的 sha256 前 16 位，只用于限速去重，不可逆。
  ip_hash   TEXT NOT NULL DEFAULT '',
  -- 留给以后：客户端如果升级成带 token 的，把 token 的 sha256 存这儿。
  token_hash TEXT NOT NULL DEFAULT '',
  /*
   * 主键**不含 city**（2026-11-07）。
   *
   * 含 city 时「换一座城」会多写一行：一天跑两城 = 8 行，四天留存就是 32 行。
   * 而 `/sight/status` 每次都要按 `date_key` 数一遍当天的行（用来算「今天多少只」），
   * 行数直接乘进 D1 的读取额度 —— 只数一多就是平方级开销。
   *
   * 现在一天最多 4 行（4 个时段），城市跟着最后一次上报覆盖。
   * 语义不变：池子只关心「这只鱼今天来过」，面板只关心「这会儿在哪」。
   */
  PRIMARY KEY (uid, date_key, slot)
);

-- 查询走「城 + 日 + 时段」，再按时间倒序取前三个。
CREATE INDEX IF NOT EXISTS idx_presence_query
  ON presence (city, date_key, slot, at DESC);

-- 定时清理按日期整批删（`scheduled()` 里用）。
CREATE INDEX IF NOT EXISTS idx_presence_date
  ON presence (date_key);

-- 「今天多少只」和定时清理都按**真实时刻** `at` 走（2026-11-10 改口径）。
CREATE INDEX IF NOT EXISTS idx_presence_at
  ON presence (at);

-- ------------------------------------------------------------------
-- `(at, uid)` 覆盖索引（2026-11-14）
--
-- **这条索引是省额度用的，不是省时间的。**
--
-- `COUNT(DISTINCT uid) ... WHERE at >= ?` 原本被优化器选中 `idx_presence_uid`
-- （`uid, at DESC`）—— 那是覆盖索引，但**按 uid 排序**，`at >= ?` 无法定位起点，
-- 只能从头扫到尾。实测：表里 1,647 行，每次 COUNT 读 **1,663 行**。
--
-- 而 `(at, uid)` 能按 `at` 做范围定位、且 `uid` 就在索引里不用回表：
-- 同一个查询读 **57 行**。**差 29 倍。**
--
-- D1 免费版按「读行数」计量（500 万/天），这一条就是 11-10 到 11-13 反复
-- 顶穿额度的真正原因 —— 不是查询次数多，是每次扫全表。
--
-- **优化器不会自己选它**（仍偏好 `idx_presence_uid` 的覆盖性），所以
-- worker.js 里那几处 COUNT 都写了 `INDEXED BY idx_presence_at_uid` 强制指定。
-- 改这些查询时**别把 INDEXED BY 删了** —— 删了不会报错，只会悄悄退回全表扫。
-- ------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_presence_at_uid
  ON presence (at, uid);

/*
 * 限速计数器。
 *
 * ## 为什么单独开一张表
 *
 * 第一版的三条闸全是 `SELECT COUNT(*) FROM presence WHERE ...`。
 * 执行计划看着很漂亮（走 covering index，没有全表扫描），但**走索引不等于不花钱** ——
 * `COUNT` 范围内有多少行就要读多少行。实测表里 8 万行时，每次 POST 读 8 万行；
 * D1 免费版一天 500 万行读取，**62 次上报就烧光**。
 *
 * 也就是说：那道「防止刷爆额度」的闸，本身就是最大的刷子。
 *
 * 换成计数器表之后，一次判定 = 读 1 行写 1 行，与表大小无关。
 *
 * ## 一条语句完成「窗口过期重置 + 计数 + 返回」
 *
 * `worker.js` 里那句 UPSERT 的 `CASE` 就是在做这件事：
 * 窗口过了就从 1 重新数，没过就 +1。原子，并发安全（D1 写是串行化的）。
 *
 * ## key 的三种前缀
 *
 *   `u:<uid>`      某个宠物自己的上报频率
 *   `i:<ip_hash>`  某个出口 IP 的上报频率
 *   `d:<日期>`     全站当天累计（对应每日硬上限）
 *
 * 过期行不用急着删 —— 同一个 key 会被反复用（只在窗口过期时把 n 重置成 1），
 * 所以这张表的大小约等于「用户数 + IP 数」，不会随天数膨胀。
 */
CREATE TABLE IF NOT EXISTS rate (
  -- 见上面的三种前缀。
  key       TEXT PRIMARY KEY,
  -- 当前窗口内已经数到几。
  n         INTEGER NOT NULL DEFAULT 0,
  -- 当前窗口的过期时刻（Unix 秒）。过期后下一次数会从 1 重新开始。
  exp       INTEGER NOT NULL
);

-- 兜底清理用（正常情况下这张表不会长，见上面说明）。
CREATE INDEX IF NOT EXISTS idx_rate_exp ON rate (exp);

/*
 * 邀约：让她自己发起「有没有人一起去某地」。
 *
 * ## 为什么是「事件 + 公告板」，不是「撮合系统」
 *
 * 服务端**完全不懂语义**。它只存「谁、从哪、想去哪、几天、一句话」，
 * 和「这条被谁接了」。想不想去、什么时候去、去不去得成，全在模型那边判断。
 *
 * 这样服务端永远不需要知道「这两个 bot 是不是朋友」「该不该撮合」——
 * 一旦它开始判断这些，就得有用户关系、有权限、有审核，
 * 那就变成「花语乡」那条路了，成本高一个量级。
 *
 * ## 一条硬规矩：不回应 = 没看见
 *
 * 邀约 24 小时自动过期，**不通知发起者结果**。发起方那边只会看到她照常自己走 ——
 * 这样「A 发了没人应」就不构成一次被拒绝，不会让她的世界里出现「社交失败」。
 * 几口人的小圈子，撮合成功率本来就低，不能让每次失败都有代价。
 */
CREATE TABLE IF NOT EXISTS invites (
  -- 随机 16 位 hex，只用来接的那一下对上号。
  id         TEXT PRIMARY KEY,
  -- 发起者。**永远不出接口**（别人只该看见 pet）。
  uid        TEXT NOT NULL,
  -- 宠物名，已经过 safePet。
  pet        TEXT NOT NULL,
  -- 发的时候在哪儿、想去哪儿（都是城市 id）。
  from_city  TEXT NOT NULL,
  to_city    TEXT NOT NULL,
  -- 打算待几天。
  days       INTEGER NOT NULL DEFAULT 1,
  -- 一句话。**唯一一段自由文本**，所以写入前必须过 safeDoing。
  note       TEXT NOT NULL DEFAULT '',
  -- 发起那天（当地日期），用于「一天最多发几条」。
  date_key   TEXT NOT NULL,
  at         TEXT NOT NULL,
  -- 过期时刻。过了就没人能看见，由定时清理删掉。
  expires_at TEXT NOT NULL,
  -- 谁接了。空 = 还挂着。
  taken_by   TEXT NOT NULL DEFAULT '',
  -- 接的人的名字。发起者要能说出「谁接了」，见 /sight/invite?mine=1。
  taken_pet  TEXT NOT NULL DEFAULT '',
  -- 发起者认领过这条结果没有。认领一次就置 1，避免每次排表反复建同一份约定。
  owner_seen INTEGER NOT NULL DEFAULT 0,
  /*
   * 见面城（2026-11-07）。空 = 老口径：直接在目的地见。
   *
   * 「约在哪儿见面 → 一起去哪儿 → 从哪儿分开」里只多了这一级：
   * 目的地（`to_city`）本身就是「最后分开的城」，所以不需要第三个字段。
   */
  meet_city  TEXT NOT NULL DEFAULT '',
  /*
   * 发起方的世界流速（1 = 和真实时间同步，0 = 老客户端没报）。
   *
   * 只用于让接的人在本地判断「你俩时间流速差太多，凑不到一起」。
   * **不参与任何服务端逻辑** —— 服务端不该懂「世界」这件事。
   */
  pace       INTEGER NOT NULL DEFAULT 0
);

-- 别人从自己所在的城市看过去：「这个城里有人发了想去哪的邀约」。
CREATE INDEX IF NOT EXISTS idx_invites_pool ON invites (from_city, expires_at);

-- 自己看自己发过什么（排查用，也用于「一个人一天发几条」）。
CREATE INDEX IF NOT EXISTS idx_invites_owner ON invites (uid, date_key);

-- 定时清理按过期时间批量删。
CREATE INDEX IF NOT EXISTS idx_invites_exp ON invites (expires_at);

/* ---------------- 人工标记（管理面板 · 2026-11-05） ---------------- */

-- Cloudflare D1（SQLite）。和 `cloud/sight/schema.sql` 那张同名表是一个意思：
--   ban    上报与邀约一律 403，池子里立刻没有她
--   rename 照常上报，回执多一句 notice:'rename'
--   删除   解除（表里不留 ok 这一行，省一次判断）
create table if not exists pet_flags (
  uid  text primary key,
  pet  text not null default '',
  kind text not null,
  note text not null default '',
  at   text not null default (datetime('now'))
);

-- 管理面板按 uid 归组看「谁是谁」，这条索引让它不用扫全表。
-- 2026-11-05 加：面板一打开就是 GROUP BY uid，没有索引时 D1 会把整张 presence 读一遍。
CREATE INDEX IF NOT EXISTS idx_presence_uid
  ON presence (uid, at DESC);

/* ---------------- 一条邀约可以被好几个人接（2026-11-05） ---------------- */

-- 原来 `invites.taken_by` 是单值，第二个来接的人直接 409 —— 于是一条邀约只能成一对。
-- 同城三只鱼时，A 和 B 走了，C 没有位置可去；用户原话：「两两配对总有一个鱼会单出来」。
--
-- 现在另开一张表记「谁接了」，一条邀约最多 MAX_PARTY - 1 行（含发起者共四只，
-- 跟同城可见上限 MEET_MAX 是同一个数）。
-- `invites.taken_by / taken_pet` 保留，仍写第一位接单人 —— 老客户端读的这两个字段不能断。
create table if not exists invite_takers (
  id   text not null,
  uid  text not null,
  pet  text not null default '',
  at   text not null,
  -- 发起者认领过没有。一个人接一次就置 1，避免每次排表反复建同一份约定。
  seen integer not null default 0,
  primary key (id, uid)
);

create index if not exists idx_invite_takers_id on invite_takers (id);

-- 迁移：这张表之前的邀约（只走过 taken_by）补进来，seen 置 1 —— 那些发起者早就认领过了。
insert or ignore into invite_takers (id, uid, pet, at, seen)
select id, taken_by, taken_pet, at, 1 from invites where taken_by <> '';

-- ------------------------------------------------------------------
-- 足迹：她去过哪些城（2026-11-14）。
--
-- `presence` 只留 4 天，那是「池子」的数据；履历不该跟着池子一起被清掉。
-- 只在「到达一座新城」时写（客户端的 `journey.arrive`），**不挂心跳上报** ——
-- 心跳一天 72 次，挂上去就是把省下的额度原样烧回来。
-- ------------------------------------------------------------------
create table if not exists footprints (
  uid      text not null,
  city     text not null,
  first_at text not null,
  last_at  text not null,
  visits   integer not null default 1,
  primary key (uid, city)
);

create index if not exists idx_footprints_uid on footprints (uid, last_at desc);

-- ------------------------------------------------------------------
-- 路标：她在一座城留一句「这里值得来」（2026-11-14）。
--
-- 是**推荐**不是聊天 —— 只有去留，没有来回，所以冷门城市空着也成立。
-- 一只鱼一城一天一条（重留覆盖旧的）；一城封顶 20 条，7 天过期。
-- ------------------------------------------------------------------
create table if not exists signposts (
  id         text primary key,
  uid        text not null,
  pet        text not null,
  city       text not null,
  text       text not null,
  at         text not null,
  expires_at text not null
);

create index if not exists idx_signposts_city on signposts (city, at desc);
create index if not exists idx_signposts_exp on signposts (expires_at);

-- ------------------------------------------------------------------
-- 错误计数（2026-11-14）。
--
-- 11-12 那次全站 500，Worker 侧一个字都没留，用户替我们查了一整天。
-- 之后各处补了 console.error，但那是**实时日志**——dashboard 上翻，
-- 没人会天天去看，事后也没有趋势。
--
-- 这张表只回答一个问题：**这一小时哪个接口在报错、报了哪种、多少次**。
--
-- ## 为什么不每次错误写一行
--
-- D1 写入按行计费。错误风暴恰恰是最需要记录的时候，也最容易把额度打爆
-- （全站 500 → 每个请求都报错 → 一次事故烧掉整个月的写额度）。
-- 所以写入前有一道**进程内闸**：同一 tag 每分钟最多写一次，
-- 之后靠 `count = count + 1` 累加。写入量上限 = 错误种类数 × 60/小时。
-- ------------------------------------------------------------------
create table if not exists errors (
  -- 2026-11-14 / 2026-11-14T19（UTC）
  day      text not null,
  hour     text not null,
  -- 哪个路由
  path     text not null,
  -- 代码里的标记，如 '[sight profile]'
  tag      text not null,
  count    integer not null default 1,
  -- 最后一条原始消息（截断到 200 字），排查时看这个
  last_msg text,
  last_at  text not null,
  primary key (day, hour, path, tag)
);

create index if not exists idx_errors_day on errors (day, hour desc);

-- ------------------------------------------------------------------
-- 同行卡与名片（2026-11-14 补）
--
-- 这两张表**线上一直有，这份 schema 里却从来没有** —— 当初是手工建在 D1 上的。
--
-- 后果不是「不好看」：任何人拿这份 schema 新建一个库，名片和同行卡会直接
-- 500（`no such table`），而这要等真跑起来才暴露。`test/sight-cf.test.mjs`
-- 里那 14 条一直是红的，根子就在这里 —— 测试用真 SQLite 跑，建不出表。
--
-- 结构从线上 `sqlite_master` 原样导出，只做了排版。大写是有原因的：
-- `test/sight-cf-schema.test.mjs` 用 `/CREATE TABLE IF NOT EXISTS party_cards/`
-- 去匹配这一行，小写匹配不上。
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS party_cards (
  id      TEXT NOT NULL,
  uid     TEXT NOT NULL,
  pet     TEXT NOT NULL,
  note    TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  at      TEXT NOT NULL,
  exp     TEXT NOT NULL,
  PRIMARY KEY (id, uid)
);

CREATE TABLE IF NOT EXISTS profiles (
  uid  TEXT PRIMARY KEY,
  pet  TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  at   TEXT NOT NULL,
  exp  TEXT NOT NULL
);

-- 卡片相关的索引（2026-11-14 补，与线上一致）
-- `idx_cards_exp` 是定时清理用的 —— 没有它，每次清理都扫全表。
CREATE INDEX IF NOT EXISTS idx_cards_exp ON party_cards (exp);
CREATE INDEX IF NOT EXISTS idx_cards_id ON party_cards (id);
CREATE INDEX IF NOT EXISTS idx_profiles_exp ON profiles (exp);
