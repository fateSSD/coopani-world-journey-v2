/**
 * 池子计数的缓存层（2026-11-13）。
 *
 * ## 为什么要单独测
 *
 * 这一层是**省钱的那一层**：`COUNT(DISTINCT uid)` 是全站最贵的读，
 * 2026-11-12 就是它把 500 万行/天的免费额度烧光的（当天 16:12 起全站 500，
 * 直到 08:00 UTC 零点重置才自己好）。
 *
 * 缓存写错了不会「报错」，只会**悄悄地不生效** —— 接口照常 200，
 * 额度照常烧光。这种缺陷在测试里必须能看见，所以这里数的不是返回值，
 * 而是**真查库的次数**。
 *
 * ## 怎么冒充 Cache API
 *
 * Node 里没有 `caches`。这里塞一个最小的假货：
 * - `match` 每次返回**新的 Response**（真 Cache API 也是这样；同一个 Response 读两次会炸）；
 * - 可以塞坏 JSON、也可以塞个异常进去，验证「缓存坏了不许拖垮接口」。
 *
 * 跑法：`node --import tsx --test test/sight-cf-pool-cache.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const worker = (await import('../cloud/sight-cf/src/worker.js')).default;

const POOL_CACHE_MS = 15 * 60_000;
const poolKey = () => `https://sight-count.internal/v2/${Math.floor(Date.now() / POOL_CACHE_MS)}`;

/**
 * 真 SQLite 当 D1，顺便数一下「贵查询」（`poolToday` 今日全池去重计数）跑了几次。
 *
 * 只数全池今日 `COUNT(DISTINCT uid)`（不带 `city = ?1`，且起点为 UTC 零点）—— 那才是 15 分钟缓存要省的那条。
 */
function makeDB() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('cloud/sight-cf/schema.sql', 'utf8'));
  const stats = { poolQueries: 0 };
  const api = {
    stats,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) {
          args = a;
          if (
            sql.includes('COUNT(DISTINCT uid)')
            && !sql.includes('city =')
            && typeof a[0] === 'string'
            && a[0].endsWith('T16:00:00.000Z')
          ) {
            stats.poolQueries += 1;
          }
          return stmt;
        },
        async first() { return db.prepare(sql).get(...args) ?? undefined; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() {
          const r = db.prepare(sql).run(...args);
          return { success: true, meta: { changes: Number(r.changes) } };
        },
      };
      return stmt;
    },
    exec(sql) { db.exec(sql); },
    query(sql, ...a) { return db.prepare(sql).all(...a); },
    raw: null,
  };
  api.raw = api;
  return api;
}

/** 最小可用的假 Cache API。`seed` 用来预置内容，测「缓存坏了」那两条。 */
function fakeCache() {
  const store = new Map();
  return {
    store,
    async match(req) {
      const k = typeof req === 'string' ? req : req.url;
      const v = store.get(k);
      if (v === undefined) return undefined;
      // 故意抛异常的用例
      if (v instanceof Error) throw v;
      return new Response(v.body, { status: 200, headers: v.headers });
    },
    async put(req, res) {
      const k = typeof req === 'string' ? req : req.url;
      const body = await res.text();
      store.set(k, { body, headers: Object.fromEntries(res.headers) });
    },
  };
}

const UID = 'a'.repeat(32);
const BASE = 'https://sight.test/sight';

const post = (body) => new Request(BASE, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.1.1.1' },
  body: JSON.stringify(body),
});
const get = (q) => new Request(`${BASE}?${q}`, { headers: { 'cf-connecting-ip': '1.1.1.1' } });
const statusReq = () => new Request(
  `${BASE}/status?uid=${UID}&city=xian`,
  { headers: { 'cf-connecting-ip': '1.1.1.1' } },
);

/** 装一个假 caches，用完立刻拆掉 —— 别污染别的测试文件。 */
function withCache(t, cache) {
  globalThis.caches = { default: cache };
  t.after(() => { delete globalThis.caches; });
}

test('第一次查库，第二次命中缓存', async (t) => {
  const cache = fakeCache();
  withCache(t, cache);
  const env = { DB: makeDB() };
  await worker.fetch(post({
    uid: UID, pet: '大肥鱼', city: 'xian', date: '2026-11-13', slot: 'morning', doing: '吃面',
  }), env);

  const r1 = await worker.fetch(statusReq(), env, {});
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('x-pool-cache'), 'miss', '第一次应该没命中');
  const before = env.DB.stats.poolQueries;
  assert.equal((await r1.json()).pool, 1);

  const r2 = await worker.fetch(statusReq(), env, {});
  assert.equal(r2.headers.get('x-pool-cache'), 'hit', '60 秒内第二次应该命中缓存');
  assert.equal(env.DB.stats.poolQueries, before, '命中缓存时不该再查库');
  assert.equal((await r2.json()).pool, 1, '缓存里的数要和库里一致');
});

test('三处调用共享同一份缓存：status / 邻居 / 落地页', async (t) => {
  const cache = fakeCache();
  withCache(t, cache);
  const env = { DB: makeDB() };
  await worker.fetch(post({
    uid: UID, pet: '大肥鱼', city: 'xian', date: '2026-11-13', slot: 'morning', doing: '吃面',
  }), env);

  const r1 = await worker.fetch(statusReq(), env, {});
  assert.equal(r1.headers.get('x-pool-cache'), 'miss');

  // 邻居列表：排表时用的那条，原来自己也数一遍
  const before = env.DB.stats.poolQueries;
  const r2 = await worker.fetch(get('city=xian&slot=morning'), env, {});
  assert.equal(r2.status, 200);
  assert.equal(env.DB.stats.poolQueries, before, '/sight 不该再数一遍池子');

  // 落地页：任何人打开域名都会打到
  const r3 = await worker.fetch(new Request('https://sight.test/'), env, {});
  assert.equal(r3.status, 200);
  assert.equal(env.DB.stats.poolQueries, before, '落地页不该再数一遍池子');
});

test('缓存里是坏数据 → 当没命中，照常查库', async (t) => {
  const cache = fakeCache();
  cache.store.set(poolKey(), { body: 'not json at all', headers: {} });
  withCache(t, cache);
  const env = { DB: makeDB() };

  const r = await worker.fetch(statusReq(), env, {});
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-pool-cache'), 'miss');
  assert.equal(env.DB.stats.poolQueries, 1, '坏缓存要退回直查 poolToday');
});

test('缓存层自己抛异常 → 当没命中，照常查库', async (t) => {
  const cache = fakeCache();
  cache.store.set(poolKey(), new Error('cache exploded'));
  withCache(t, cache);
  const env = { DB: makeDB() };

  const r = await worker.fetch(statusReq(), env, {});
  assert.equal(r.status, 200, '缓存坏了不许让接口 500');
  assert.equal(r.headers.get('x-pool-cache'), 'miss');
});

test('查库失败时不往缓存里写脏数（额度耗尽就靠这条）', async (t) => {
  const cache = fakeCache();
  withCache(t, cache);

  /*
   * 造一个「D1 拒绝查询」的库：真额度耗尽时就是抛错。
   * 关键断言是**缓存里什么都没留下** —— 否则一次失败会被放大成 15 分钟的「池子 0 只」。
   */
  const env = {
    DB: {
      prepare() { throw new Error('D1_ERROR: daily limit exceeded'); },
    },
  };

  const r = await worker.fetch(statusReq(), env, {});
  assert.equal(r.status, 500);
  assert.equal(cache.store.has(poolKey()), false, '失败结果绝不能进缓存');
});
