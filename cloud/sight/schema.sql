-- 碰面 + 邀约：三张表。
--
-- 这是**唯一的一份 DDL**，和云端实际跑的那三张表一致
-- （2026-11-05 09:05 以 migration `20261105090517_sight_invite_tables` 应用过）。
--
-- 全部 `IF NOT EXISTS`：老环境（0.5.29–0.5.47 只有 `presence`）升级上来时
-- 把整段跑一次就行，已有的表和数据一点不动。
--
-- 怎么跑：
--   控制台「数据库（PostgreSQL）→ SQL 执行」整段粘贴；
--   或者用 MCP / CLI 的 PG migration（推荐，会留迁移历史）。
--
-- 注意：**不要在「集合」里建表** —— 那是文档型数据库，这个环境没开，
-- 而云函数走的是 `app.rdb()`（PostgREST），只认 PostgreSQL 的表。

/* ---------------- 谁在哪（碰面） ---------------- */

create table if not exists presence (
  uid        text not null,
  pet        text not null,
  city       text not null,
  date_key   text not null,
  slot       text not null,
  doing      text not null default '',
  at         timestamptz not null default now()
);

-- 同一 uid、同城、同日、同时段只留一条（上报走 upsert 撞这个索引）
create unique index if not exists presence_uid_idx
  on presence (uid, city, date_key, slot);

-- 「这会儿这一带还有谁」按这个查
create index if not exists presence_query_idx
  on presence (city, date_key, slot, at desc);

/* ---------------- 谁想找伴一起去哪（邀约） ---------------- */

create table if not exists invites (
  id         text primary key,
  uid        text not null,
  pet        text not null,
  from_city  text not null,
  to_city    text not null,
  days       int  not null default 1,
  note       text not null default '',
  date_key   text not null,
  at         timestamptz not null default now(),
  -- 24 小时后就当没看见过。过期由查询条件判，不靠定时任务删
  expires_at timestamptz not null,
  -- 谁接的。'' 表示还挂着 —— 抢位置的条件更新靠这一列
  taken_by   text not null default ''
);

create index if not exists invites_query_idx
  on invites (from_city, expires_at, at desc);

/* ---------------- 限速计数 ---------------- */

-- key 形如 `iv:<uid>:<YYYY-MM-DD>` / `ia:<uid>:<YYYY-MM-DD>`，带日期所以跨天自动重置。
-- exp 是这一格的过期时刻（Unix 秒），清理按它删，不扫全表。
create table if not exists rate (
  key text primary key,
  n   int  not null default 0,
  exp bigint not null
);

/* ---------------- 人工标记（管理面板） ---------------- */

-- 自动过滤（AD_PATTERNS / BAD_WORDS）只认得形状明显的广告和几条多字脏话，
-- 「名字不对劲但说不出哪儿不对劲」得有人看。这张表只记人工判断的结果：
--   ban    上报一律 403，池子里就没有她了
--   rename 照常上报，回执多一句 notice:'rename'，客户端可转成提醒
--   ok     解除
--
-- 为什么单独一张表、不往 presence 上加列：同一个 uid 会写很多行 presence
-- （一天换几个地方就是几行），而标记是**关于这只鱼的**，不是关于某一格的。
create table if not exists pet_flags (
  uid  text primary key,
  pet  text not null default '',
  kind text not null,
  note text not null default '',
  at   timestamptz not null default now()
);
