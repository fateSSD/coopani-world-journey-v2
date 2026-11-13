/**
 * 表结构与 upsert 语句的对账 —— 2026-11-10。
 *
 * ## 为什么要有这一条
 *
 * 11-09 20:38 把 worker 换成 `ON CONFLICT(uid, date_key, slot)` 的版本，
 * 而线上 D1 的 `presence` 主键还是旧的 `(uid, city, date_key, slot)`
 * —— 迁移脚本写了，但**从来没在线上跑过**。
 *
 * SQLite 对「冲突目标不对应任何主键或唯一约束」是**直接报错**，不是降级。
 * 于是每一次上报都 500，整整一天池子里一条新数据没进。而读接口一点事没有，
 * 面板照样打得开，只是那个「今天多少只」永远停在 19 —— 报障时看到的就是这个。
 *
 * 现有的 `sight-cf.test.mjs` 用的是假 D1（只认 SQL 的形状，不解析），
 * 这类「语句和表对不上」它天生看不见。所以这里做静态对账：
 * 把 `schema.sql` 里的主键读出来，跟 `worker.js` 里 upsert 的冲突目标比一遍。
 *
 * 顺带守第二条：**迁移脚本必须把 `schema.sql` 里的索引全部重建。**
 * 建表语句里的索引会随 `DROP TABLE` 一起没，漏一个不会报错，只会让某个
 * 查询悄悄退化成全表扫描 —— 那是在烧 D1 额度，不烧 CPU。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const SCHEMA = read('../cloud/sight-cf/schema.sql');
const WORKER = read('../cloud/sight-cf/src/worker.js');
const MIGRATION = read('../cloud/sight-cf/migrate-2026-11-07-presence-pk.sql');

/** 从建表语句里抠出主键列。 */
function primaryKeyOf(sql) {
  const table = sql.match(/CREATE TABLE IF NOT EXISTS presence \(([\s\S]*?)\n\);/);
  assert.ok(table, 'schema.sql 里找不到 presence 的建表语句');
  const pk = table[1].match(/PRIMARY KEY\s*\(([^)]*)\)/i);
  assert.ok(pk, 'presence 没有主键');
  return pk[1].split(',').map((s) => s.trim()).filter(Boolean);
}

/** 从 worker 的 `INSERT INTO presence ... ON CONFLICT(...)` 里抠出冲突目标。 */
function upsertTargetOf(src) {
  const at = src.indexOf('INSERT INTO presence');
  assert.ok(at > 0, 'worker.js 里找不到 presence 的写入语句');
  const after = src.slice(at);
  const hit = after.match(/ON CONFLICT\s*\(([^)]*)\)/i);
  assert.ok(hit, 'presence 的写入没有 ON CONFLICT —— 主键一撞就整条失败');
  return hit[1].split(',').map((s) => s.trim()).filter(Boolean);
}

/** 建在 presence 上的索引名。 */
function indexesOnPresence(sql) {
  return [...sql.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)\s+ON presence\b/g)].map((m) => m[1]).sort();
}

test('presence：upsert 的冲突目标必须等于表的主键', () => {
  const pk = primaryKeyOf(SCHEMA);
  const target = upsertTargetOf(WORKER);
  assert.deepEqual(
    target, pk,
    `语句和表对不上：upsert 写的是 (${target.join(', ')})，表的主键是 (${pk.join(', ')})。`
    + '线上表现是**每次上报都 500**，而读接口全部正常 —— 极难看出是这里的问题。',
  );
});

test('presence：迁移脚本把 schema 里的索引一个不落地重建', () => {
  const want = indexesOnPresence(SCHEMA);
  const got = new Set(indexesOnPresence(MIGRATION));
  assert.ok(want.length >= 3, `schema 里的 presence 索引只有 ${want.length} 个，是不是解析错了`);
  const missing = want.filter((name) => !got.has(name));
  assert.deepEqual(
    missing, [],
    `迁移脚本漏了 ${missing.join(', ')}。DROP TABLE 会带走旧表上的索引，`
    + '漏掉的那个查询会悄悄退化成全表扫描。',
  );
});

test('presence：主键不含 city（换一座城不该多一行）', () => {
  assert.ok(
    !primaryKeyOf(SCHEMA).includes('city'),
    '主键又带上 city 了 —— 一天跑两城会各写一行，「一只鱼一天最多 4 行」就不成立',
  );
});

/*
 * 下面三条守「时标别混」和「在线别乱叫」—— 2026-11-10。
 *
 * 那天两句报障是同一个病根：数字的**口径**没写在任何地方。
 *   「卡死在 19」   → 拿现实日期去比 `date_key`（游戏内日期），永远不会动；
 *   「何来一只在线」→ 上报只在启动/到站时发生，一条整天不动的鱼会自动消失。
 */

test('presence：「今天」按北京时间起算，不是 UTC', () => {
  assert.match(
    WORKER, /const CN_OFFSET_MS\s*=\s*8 \* 3_600_000/,
    'CN_OFFSET_MS 没了 —— 回到 UTC 零点起算，等于早上八点换日，凌晨上线的鱼会被算进昨天',
  );
  const def = WORKER.match(/const todayStartIso = \(\) => \{[\s\S]{0,240}?\};/);
  assert.ok(def, 'todayStartIso 不再是函数体形式，检查它是不是退回成简单的 UTC 截断了');
  assert.match(def[0], /CN_OFFSET_MS/, 'todayStartIso 没用到 CN_OFFSET_MS');
});

test('presence：现实时间口径一律用 at，不许再对 date_key 数「今天多少只」', () => {
  const bad = [...WORKER.matchAll(/COUNT\(DISTINCT uid\) AS n FROM presence WHERE date_key/g)];
  assert.deepEqual(
    bad.map((m) => m[0]), [],
    '还有查询拿 date_key（游戏内日期）当现实今天用 —— 那个数字只会卡死不动，'
    + '2026-11-10 面板「卡在 19」就是这么来的',
  );
});

/*
 * 2026-11-11 改口径：**实时和累计分成两个口**（Mr.Q：「把实时数据和累计数据分开」）。
 *
 * 原先是三个数（在册 / 今天来过 / 此刻在线）挤在 `/admin/pets` 一个响应里，
 * 2026-11-06 和 11-10 两次被读成「哪边坏了」。光改文案不够 ——
 * 页面自动刷新为了看「在线几只」得把全表明细一起拉，一次几千行读，
 * 一天几百万行，直接把 D1 免费额度打光（Cloudflare 发信、池子停了一整天）。
 *
 * 现在这条盯三件事：窗口常量还在、实时口算这两个数、累计口**不许**再算。
 */
test('presence：实时与累计分成两个口，各回各的', () => {
  assert.ok(WORKER.includes('const ONLINE_WINDOW_MS'), '在线窗口被改没了');
  assert.ok(WORKER.includes('const onlineSinceIso'), 'onlineSinceIso 没了');
  // 池子那个口（/sight/status）照旧带 online，桌面面板要用。
  assert.ok(WORKER.includes('online: Number(onlineRow?.n ?? 0) || 0'), '/sight/status 不再返回 online');

  const at = WORKER.indexOf("url.pathname === '/admin/live'");
  assert.ok(at > 0, '找不到 /admin/live 那段');
  const live = WORKER.slice(at, at + 2600);
  assert.ok(live.includes('online: Number(onlineRow?.n ?? 0) || 0'), '/admin/live 没返回在线数');
  assert.ok(live.includes('today: Number(todayRow?.n ?? 0) || 0'), '/admin/live 没返回今天来过');
  assert.ok(live.includes('onlineWindowMin'), '/admin/live 没告诉页面在线窗口是多少分钟');

  /*
   * 累计那个口不许再算 online/today —— 算回来两个口径又混进一个响应，
   * 下次有人顺手把它加回页面，额度再烧一次。
   * `onlineRow?.n` 里不含 `online?.n`，所以这条锚得住。
   */
  assert.equal(WORKER.includes('online?.n'), false, '/admin/pets 又把 online 算回来了，两个口径混回一个口');
});

test('presence：/admin/live 进了路由白名单', () => {
  /*
   * 白名单和 `adminRoute` 里的分支必须一一对应。2026-11-11 加 /admin/live 时
   * 忘了加白名单：路由写好了、语法也对、测试直接 404 —— 报错长得像「接口没实现」。
   */
  assert.ok(WORKER.includes("|| url.pathname === '/admin/live'"), '/admin/live 没进分发白名单');
});

/*
 * 邻居匹配：把 `date_key` 拿出去 —— 2026-11-10。
 *
 * 原来「这一带还有谁」是同城 + **同日** + 同时段三重与，那个「日」是 `date_key`，
 * 也就是各人**自己的游戏内日期**。世界时钟 24 倍速，同一刻线上并存
 * 2026-11-10 / 2026-11-12 / 2027-03-07 —— 两条鱼撞上同一天几乎不可能。
 *
 * 实测：池子里 7 只在跑，他女儿在昆明，
 * `/sight?city=kunming&date=2026-11-10&slot=afternoon` 回的是 `list: []`。
 */
test('邻居：同城 + 同时段 + 近期活跃，不再按 date_key 筛', () => {
  assert.match(WORKER, /const RECENT_NEIGHBOR_MS\s*=/, 'RECENT_NEIGHBOR_MS 没了');

  /*
   * 只认「查邻居」那几条语句的形状：`SELECT pet, doing FROM presence ... ORDER BY at DESC`。
   * 按 `method === 'GET'` 切块不牢 —— 文件里不止一个 GET 分支，切到别处就会误报。
   */
  const wheres = [...WORKER.matchAll(
    /SELECT pet, doing FROM presence\s+WHERE([\s\S]{0,200}?)ORDER BY at DESC/g,
  )].map((m) => m[1]);
  assert.ok(wheres.length >= 1, '找不到邻居查询');

  for (const w of wheres) {
    assert.ok(
      !w.includes('date_key'),
      '邻居查询又按 date_key 筛了 —— 各人的游戏内日期差几天到几个月，'
      + '「这一带还有谁」会永远返回空（2026-11-10 实测就是这个现象）',
    );
    assert.match(w, /at >= \?\d/, `邻居查询没按 at 划活跃窗口：${w.trim()}`);
  }
});

/* ---------------- 同行卡（2026-11-11） ---------------- */

test('同行卡：upsert 的冲突目标必须和表的主键完全一致', () => {
  /*
   * 同一个坑，换个表：`presence` 那次线上炸了一整天，就是因为
   * `ON CONFLICT(...)` 写的列和主键对不上 —— SQLite 直接报错，
   * 而假 D1 只认 SQL 形状，看不见这一类。
   *
   * `party_cards` 的主键是 `(id, uid)`，upsert 必须正好撞这两个。
   */
  const table = SCHEMA.match(/CREATE TABLE IF NOT EXISTS party_cards \(([\s\S]*?)\n\);/);
  assert.ok(table, 'schema.sql 里找不到 party_cards 的建表语句');
  const pk = table[1].match(/PRIMARY KEY\s*\(([^)]*)\)/i);
  assert.ok(pk, 'party_cards 没有主键');
  const cols = pk[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(cols, ['id', 'uid'], '主键该是 (id, uid)：一段同行里一个人一张卡');

  const upsert = WORKER.match(/INSERT INTO party_cards[\s\S]*?ON CONFLICT\(([^)]*)\)/);
  assert.ok(upsert, 'worker 里找不到 party_cards 的 upsert');
  assert.deepEqual(
    upsert[1].split(',').map((s) => s.trim()),
    cols,
    '冲突目标和主键不一致，线上会直接 500',
  );
});

test('同行卡：表里必须有 exp，清理语句按它算', () => {
  assert.match(SCHEMA, /CREATE INDEX IF NOT EXISTS idx_cards_exp ON party_cards \(exp\);/);
  assert.match(WORKER, /FROM party_cards c[\s\S]*?LEFT JOIN invites i ON i\.id = c\.id/,
    '卡没跟着邀约一起清，孤儿行会一直占额度、还存着别人给的号');
});
