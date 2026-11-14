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

/* ---------------- 同行卡（2026-11-11，Discussion #586） ---------------- */

/*
 * 一起走过几天之后，互留的那张卡。
 *
 * ## 为什么有这张表
 *
 * 用户来信（原文是个孩子写的）：「约到一起的那几天里，让同行的伙伴能留下一个号，
 * 或者留一句话。不用多复杂，能让我在别处说一句『我在』就够了。」
 *
 * 在那之前，`presence` 只回答「谁在哪」、`invites` 只回答「谁想跟谁走」，
 * 散了之后什么都不剩 —— 名字都没记全就下车了。
 *
 * ## 边界（和「碰面归碰面，聊天归聊天」那条线对齐）
 *
 * 这不是聊天：没有回复、没有好友列表、没有未读、不能反复骚扰。
 * 一条邀约里的每个人最多留一张，留过就覆盖。**它是名片，不是信箱。**
 *
 * ## 主键为什么是 (id, uid)
 *
 * `id` 是邀约编号 —— 那段同行的锚；`uid` 是留卡的人。
 * 合起来保证「一段同行里一个人一张」，重复提交就是覆盖，天然幂等。
 *
 * `uid` **永远不出接口**：别人只该看见 pet、note、contact，看不见谁是谁。
 * 这条和 `invites.uid` 同一条线。
 *
 * ## 30 天
 *
 * 比 `invites` 的 24 小时长得多 —— 卡的意义就是「散伙之后还能找」，
 * 隔天就删等于没做。但也不留永久：这是别人给的号，
 * 一直挂着不合适，30 天足够一次「我下次去你那儿」的往来。
 */
CREATE TABLE IF NOT EXISTS party_cards (
  /* 邀约编号，16 位 hex。也是「同一段同行」的锚。 */
  id      TEXT NOT NULL,
  /* 留卡的人。永远不出接口。 */
  uid     TEXT NOT NULL,
  /* 留卡时的宠物名，已经过 safePet。 */
  pet     TEXT NOT NULL,
  /* 她写的那句话。唯一一段「她的话」的自由文本。 */
  note    TEXT NOT NULL DEFAULT '',
  /* 他留的号。**空串是正常值** —— 很多人不会填，那就不给。 */
  contact TEXT NOT NULL DEFAULT '',
  /* 真实写入时刻（ISO）。 */
  at      TEXT NOT NULL,
  /* 过期时刻。过了就没人取得到，由定时清理删掉。 */
  exp     TEXT NOT NULL,
  PRIMARY KEY (id, uid)
);

-- 定时清理按过期批量删。
CREATE INDEX IF NOT EXISTS idx_cards_exp ON party_cards (exp);

-- 取「这段同行里别人留了什么」：按 id 查，主键已经覆盖，这条索引只用于清理之外的分析。
CREATE INDEX IF NOT EXISTS idx_cards_id ON party_cards (id);

/* ---------------- 名片（2026-11-11，Discussion #586 的后半段） ---------------- */

/*
 * 一段长期自我介绍。和「同行卡」是两回事，别混：
 *
 *   卡   = 某一段同行结束时的临别留言，按邀约编号存，一段一张
 *   名片 = 这个人本身的样子，全局一张，改了就覆盖
 *
 * ## 为什么要有
 *
 * 用户 chloveln 在讨论里提的做法：「给每条鱼加一个简介，鱼之间可以通过简介里
 * 提供的花语乡/星邮/客厅的 id 来找到对方加上好友」。他 11-10 回了「明天我试试看」。
 *
 * ## 可见性：只有同行过的人
 *
 * 这是这一版和 chloveln 提议最大的不同 —— **不做「请求-同意」**。
 * 理由不是省事：同意流程要求她知道「有人在请求」，而这个扩展没有通知通道，
 * 只能等下次碰面才说得出来。一个要等三天的同意，比不给更让人难受。
 *
 * 所以改成：**看得见的条件从「对方点了同意」换成「你们真的一起走过」**。
 * 一起走过几天的人，本来就知道彼此的存在；陌生人无论怎么请求都看不见。
 *
 * ## 为什么是 30 天
 *
 * 名片是「现在还想不想被人找到」的表达，不是档案。一直挂着不合适，
 * 30 天不续就等于自己收回去了。跟卡同一个尺度，用户不用记两套规矩。
 */
CREATE TABLE IF NOT EXISTS profiles (
  /* 跟 presence / invites 同一套匿名标识，按机器分。 */
  uid  TEXT PRIMARY KEY,
  /* 宠物名，已经过 safePet。 */
  pet  TEXT NOT NULL,
  /* 那段自我介绍。可以写花语乡/星邮/客厅的 id —— 用户自己要写什么就写什么。 */
  text TEXT NOT NULL DEFAULT '',
  /* 真实写入时刻（ISO）。 */
  at   TEXT NOT NULL,
  /* 过期时刻。30 天不续就查不到。 */
  exp  TEXT NOT NULL
);

-- 定时清理按过期批量删。
CREATE INDEX IF NOT EXISTS idx_profiles_exp ON profiles (exp);

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
