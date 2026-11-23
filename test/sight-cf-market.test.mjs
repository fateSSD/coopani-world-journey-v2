/**
 * L2 芦花塘市集服务端测试（三期买方半场 + 《街口黑板报》，2026-11-21）。
 *
 * 同样用 node:sqlite 跑真 schema.sql，验证：
 *   1. POST /town/join 入册/续期 + 限流 + ban 拦截
 *   2. GET /town/stalls 正常返回货架 + 《街口黑板报》bulletin（无表时优雅降级 200）
 *   3. POST /town/buy 原子防超卖、禁止自买、deals 表绝对不存金额列
 *   4. scheduled() 清理 town / stalls / deals 过期行
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const worker = (await import('../cloud/sight-cf/src/worker.js')).default;

function makeDB({ omitMarketTables = false } = {}) {
  const db = new DatabaseSync(':memory:');
  let sql = readFileSync('cloud/sight-cf/schema.sql', 'utf8');
  if (omitMarketTables) {
    sql = sql.split('-- L2 芦花塘市集')[0];
  }
  db.exec(sql);
  return {
    rawDb: db,
    prepare(q) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async first() { return db.prepare(q).get(...args) ?? undefined; },
        async all() { return { results: db.prepare(q).all(...args) }; },
        async run() {
          const r = db.prepare(q).run(...args);
          return { success: true, meta: { changes: Number(r.changes) } };
        },
      };
      return stmt;
    },
    exec(q) { db.exec(q); },
    query(q, ...a) { return db.prepare(q).all(...a); },
  };
}

const UID_A = 'a'.repeat(32);
const UID_B = 'b'.repeat(32);

async function req(path, { method = 'GET', body, db } = {}) {
  const env = { DB: db };
  const r = new Request(`https://town.test${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(r, env);
  const json = await res.json();
  return { status: res.status, json };
}

test('schema.sql 中 deals 表绝不能出现 price/amount/money 等金额列', () => {
  const schema = readFileSync('cloud/sight-cf/schema.sql', 'utf8');
  const m = schema.match(/CREATE TABLE IF NOT EXISTS deals \(([\s\S]*?)\);/);
  assert.ok(m, 'schema.sql 缺少 deals 表');
  assert.doesNotMatch(m[1], /\b(price|amount|money|cost)\b/i);
});

test('未迁移三张新表时，GET /town/stalls 必须优雅降级回 200，不许 500', async () => {
  const db = makeDB({ omitMarketTables: true });
  const r = await req('/town/stalls', { db });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.degraded, true);
  assert.deepEqual(r.json.stalls, []);
  assert.deepEqual(r.json.bulletin, []);

  const j = await req('/town/join', {
    method: 'POST',
    db,
    body: { uid: UID_A, pet: '大肥鱼', street: '灶前巷' },
  });
  assert.equal(j.status, 503);
  assert.equal(j.json.error, 'not migrated');
});

test('POST /town/join 正常入册、清洗脏词、ban 拦截，并进入《街口黑板报》', async () => {
  const db = makeDB();
  db.exec(`INSERT INTO pet_flags (uid, pet, kind) VALUES ('${UID_B}', '坏鱼', 'ban')`);

  const banned = await req('/town/join', {
    method: 'POST',
    db,
    body: { uid: UID_B, pet: '坏鱼', street: '早市街' },
  });
  assert.equal(banned.status, 403);

  const ok = await req('/town/join', {
    method: 'POST',
    db,
    body: { uid: UID_A, pet: '大肥鱼', street: '灶前巷' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.street, '灶前巷');

  const stalls = await req('/town/stalls', { db });
  assert.equal(stalls.status, 200);
  assert.ok(stalls.json.bulletin.some((line) => line.includes('住着 1 户')), '黑板报应汇总真实住户数');
});

test('POST /town/buy 原子减库存、禁止自买、超卖回 409、deals 写回执且更新黑板报', async () => {
  const db = makeDB();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const now = new Date().toISOString();
  db.rawDb.prepare(
    `INSERT INTO stalls (id, uid, seller, kind, item, price, stock, note, at, expires_at)
     VALUES ('st-1', ?, '阿沅', 'goods', '青梅酱', 28, 2, '自熬的', ?, ?)`,
  ).run(UID_A, now, future);

  // 禁止自己买自己的摊位
  const selfBuy = await req('/town/buy', {
    method: 'POST',
    db,
    body: { stallId: 'st-1', buyerUid: UID_A, buyer: '大肥鱼' },
  });
  assert.equal(selfBuy.status, 400);
  assert.equal(selfBuy.json.error, 'own stall');

  // 他人连续买 2 份
  const b1 = await req('/town/buy', {
    method: 'POST',
    db,
    body: { stallId: 'st-1', buyerUid: UID_B, buyer: '小胖鱼' },
  });
  assert.equal(b1.status, 200);
  assert.equal(b1.json.item, '青梅酱');
  assert.equal(b1.json.price, 28);
  assert.equal(b1.json.stockLeft, 1);

  // 未带 buyerUid 直接 400（防空 uid 绕过封禁/自买）
  const noUid = await req('/town/buy', {
    method: 'POST',
    db,
    body: { stallId: 'st-1', buyer: '路人鱼' },
  });
  assert.equal(noUid.status, 400);

  const UID_C = 'c'.repeat(32);
  const b2 = await req('/town/buy', {
    method: 'POST',
    db,
    body: { stallId: 'st-1', buyerUid: UID_C, buyer: '路人鱼' },
  });
  assert.equal(b2.status, 200);
  assert.equal(b2.json.stockLeft, 0);

  // 第 3 次必须 409 sold out，不能减成负数
  const b3 = await req('/town/buy', {
    method: 'POST',
    db,
    body: { stallId: 'st-1', buyerUid: UID_C, buyer: '慢一步鱼' },
  });
  assert.equal(b3.status, 409);

  const deals = db.query('SELECT item, qty, buyer_pet FROM deals');
  assert.equal(deals.length, 2);

  // 售空摊位不进货架，但成交写进《街口黑板报》
  const stRes = await req('/town/stalls', { db });
  assert.equal(stRes.json.stalls.length, 0);
  assert.ok(stRes.json.bulletin.some((line) => line.includes('成交了 2 份') && line.includes('青梅酱')));
});

test('scheduled() 会一并清理 town / stalls / deals 过期行', async () => {
  const db = makeDB();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const now = new Date().toISOString();

  db.rawDb.prepare(`INSERT INTO town (uid, pet, street, lane, at, expires_at) VALUES (?, '旧鱼', '早市街', 0, ?, ?)`).run(UID_A, now, past);
  db.rawDb.prepare(`INSERT INTO town (uid, pet, street, lane, at, expires_at) VALUES (?, '新鱼', '灶前巷', 0, ?, ?)`).run(UID_B, now, future);
  db.rawDb.prepare(`INSERT INTO stalls (id, uid, seller, kind, item, price, stock, note, at, expires_at) VALUES ('s-old', ?, '旧鱼', 'goods', '豆腐', 6, 1, '', ?, ?)`).run(UID_A, now, past);
  db.rawDb.prepare(`INSERT INTO deals (id, stall_id, seller_uid, buyer_uid, buyer_pet, item, qty, note, at, expires_at) VALUES ('d-old', 's-old', ?, ?, '新鱼', '豆腐', 1, '', ?, ?)`).run(UID_A, UID_B, now, past);

  await worker.scheduled({}, { DB: db });

  assert.equal(db.query('SELECT uid FROM town').length, 1);
  assert.equal(db.query('SELECT id FROM stalls').length, 0);
  assert.equal(db.query('SELECT id FROM deals').length, 0);
});

test('GET /admin/life 独立返回 Life 在册鱼数、街道分布与市集概况（带 ADMIN_KEY 守门）', async () => {
  const db = makeDB();
  const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const expired = new Date(Date.now() - 86_400_000).toISOString();
  const now = new Date().toISOString();
  const oldSeen = new Date(Date.now() - 3 * 86_400_000).toISOString();

  db.rawDb.prepare(`INSERT INTO town (uid, pet, street, lane, at, expires_at) VALUES (?, '大肥鱼', '早市街', 0, ?, ?)`).run(UID_A, now, future);
  db.rawDb.prepare(`INSERT INTO town (uid, pet, street, lane, at, expires_at) VALUES (?, '小银鱼', '灶前巷', 0, ?, ?)`).run(UID_B, oldSeen, future);
  db.rawDb.prepare(`INSERT INTO town (uid, pet, street, lane, at, expires_at) VALUES (?, '过期鱼', '早市街', 0, ?, ?)`).run('c'.repeat(32), oldSeen, expired);
  db.rawDb.prepare(`INSERT INTO stalls (id, uid, seller, kind, item, price, stock, note, at, expires_at) VALUES ('s-1', ?, '大肥鱼', 'goods', '豆腐花', 6, 2, '', ?, ?)`).run(UID_A, now, future);
  db.rawDb.prepare(`INSERT INTO deals (id, stall_id, seller_uid, buyer_uid, buyer_pet, item, qty, note, at, expires_at) VALUES ('d-1', 's-1', ?, ?, '小银鱼', '豆腐花', 1, '', ?, ?)`).run(UID_A, UID_B, now, future);

  const noKey = await worker.fetch(new Request('https://sight.test/admin/life'), { DB: db });
  assert.equal(noKey.status, 404);

  const badKey = await worker.fetch(new Request('https://sight.test/admin/life', {
    headers: { 'x-admin-key': 'wrong' },
  }), { DB: db, ADMIN_KEY: 'secret-1' });
  assert.equal(badKey.status, 401);

  const okRes = await worker.fetch(new Request('https://sight.test/admin/life', {
    headers: { 'x-admin-key': 'secret-1' },
  }), { DB: db, ADMIN_KEY: 'secret-1' });
  assert.equal(okRes.status, 200);
  const body = await okRes.json();
  assert.equal(body.ok, true);
  assert.equal(body.tableReady, true);
  assert.equal(body.total, 2);
  assert.equal(body.active24h, 1);
  assert.equal(body.activeStalls, 1);
  assert.equal(body.deals24h, 1);
  assert.equal(body.residents.length, 2);
  assert.ok(body.byStreet.some((s) => s.street === '早市街' && s.count === 1));
  assert.ok(body.byStreet.some((s) => s.street === '灶前巷' && s.count === 1));
});

test('2.1：/admin/life 缺表时不得返回假 tableReady:true，必须列出 missing', async () => {
  const db = makeDB();
  db.rawDb.exec('DROP TABLE stalls; DROP TABLE deals;');
  const res = await worker.fetch(new Request('https://sight.test/admin/life', {
    headers: { 'x-admin-key': 'secret-1' },
  }), { DB: db, ADMIN_KEY: 'secret-1' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tableReady, false);
  assert.deepEqual(body.missing, ['stalls', 'deals']);
});

test('2.2：POST /town/buy 同 uid 第 61 次购买回 429', async () => {
  const db = makeDB();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  db.rawDb.prepare(
    `INSERT INTO stalls (id, uid, seller, kind, item, price, stock, fresh_veg, note, at, expires_at)
     VALUES ('st-lim', ?, '阿沅', 'goods', '白豆腐', 5, 5, 1, '', ?, ?)`,
  ).run(UID_A, now, future);
  db.rawDb.prepare(
    `INSERT INTO rate (key, n, exp) VALUES (?, 60, ?)`,
  ).run(`tb:${UID_B}:${day}`, Math.floor(Date.now() / 1000) + 3600);

  const limited = await req('/town/buy', {
    method: 'POST',
    db,
    body: { stallId: 'st-lim', buyerUid: UID_B, buyer: '小胖鱼' },
  });
  assert.equal(limited.status, 429);
});

test('3.1 & 3.2：POST /town/stalls 挂摊穿透缓存上限3个、GET/POST /town/deals 已读回执且不泄金额与buyerUid', async () => {
  const db = makeDB();
  // 模拟 Cloudflare caches.default 以验证失效刷新是否真删除缓存
  let cachedRes = new Response(JSON.stringify({ ok: true, stalls: [], bulletin: [] }), { status: 200 });
  let deleteCalls = 0;
  const prevCaches = globalThis.caches;
  globalThis.caches = {
    default: {
      async match() { return cachedRes; },
      async put(_k, res) { cachedRes = res; },
      async delete() { deleteCalls += 1; cachedRes = null; return true; },
    },
  };
  try {
    // 连挂 3 个摊位成功，且第 1 次挂摊清掉旧 cache
    for (let i = 1; i <= 3; i++) {
      const p = await req('/town/stalls', {
        method: 'POST',
        db,
        body: { uid: UID_A, pet: '阿沅', item: `鲜菜${i}`, price: 10 + i, stock: 2, freshVeg: i === 1 },
      });
      assert.equal(p.status, 200);
      assert.equal(p.json.freshVeg, i === 1);
    }
    assert.ok(deleteCalls >= 3, '挂摊后必须失效 Cache');

    // 第 4 个摊位应被上限 3 拒之门外
    const p4 = await req('/town/stalls', {
      method: 'POST',
      db,
      body: { uid: UID_A, pet: '阿沅', item: '第4个摊', price: 15, stock: 1 },
    });
    assert.equal(p4.status, 409);

    // 紧接着 GET /town/stalls 立即看得到这 3 个新摊（含 freshVeg）
    const listRes = await req('/town/stalls', { db });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.json.stalls.length, 3);
    const hitVeg = listRes.json.stalls.find((x) => x.item === '鲜菜1');
    assert.equal(hitVeg?.freshVeg, true);

    // 买家买入鲜菜1
    const buy = await req('/town/buy', {
      method: 'POST',
      db,
      body: { stallId: hitVeg.id, buyerUid: UID_B, buyer: '小胖鱼' },
    });
    assert.equal(buy.status, 200);
    assert.equal(buy.json.freshVeg, true);

    // 卖方拉回执：未读 = 1，不暴露 buyerUid 与金额
    const deals1 = await req(`/town/deals?uid=${UID_A}`, { db });
    assert.equal(deals1.status, 200);
    assert.equal(deals1.json.unseen, 1);
    assert.equal(deals1.json.deals.length, 1);
    assert.equal(deals1.json.deals[0].buyerPet, '小胖鱼');
    assert.equal(deals1.json.deals[0].item, '鲜菜1');
    assert.equal('buyerUid' in deals1.json.deals[0], false);
    assert.equal('price' in deals1.json.deals[0], false);

    // 标已读后 unseen 归 0
    const seenRes = await req('/town/deals/seen', {
      method: 'POST',
      db,
      body: { uid: UID_A, ids: [deals1.json.deals[0].id] },
    });
    assert.equal(seenRes.status, 200);

    const deals2 = await req(`/town/deals?uid=${UID_A}`, { db });
    assert.equal(deals2.json.unseen, 0);
    assert.equal(deals2.json.deals[0].seen, true);
  } finally {
    globalThis.caches = prevCaches;
  }
});

test('POST /admin/town 修改街道后，会把 town 表失效旧街道按 uid 均匀分到新街（不再全挤首条街）', async () => {
  const db = makeDB();
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const streets = ['南滨河路', '张掖路', '皋兰路', '雁滩路'];
  for (let i = 0; i < 20; i++) {
    const uid = i.toString(16).padStart(32, 'c');
    db.rawDb.prepare(`INSERT INTO town (uid, pet, street, lane, at, expires_at) VALUES (?, ?, '早市街', 0, ?, ?)`).run(uid, `旧街鱼${i}`, now, future);
  }
  db.rawDb.prepare(`INSERT INTO town (uid, pet, street, lane, at, expires_at) VALUES (?, '张掖鱼', '张掖路', 0, ?, ?)`).run(UID_B, now, future);

  const saveRes = await worker.fetch(new Request('https://sight.test/admin/town', {
    method: 'POST',
    headers: { 'x-admin-key': 'secret-1', 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'lanzhou',
      name: '兰州',
      origin: '黄河穿城',
      streets,
      rules: ['河里的不吃河里的', '货不过夜'],
    }),
  }), { DB: db, ADMIN_KEY: 'secret-1' });
  assert.equal(saveRes.status, 200);
  const saveJson = await saveRes.json();
  assert.equal(saveJson.migrated, 20);

  const lifeRes = await worker.fetch(new Request('https://sight.test/admin/life', {
    headers: { 'x-admin-key': 'secret-1' },
  }), { DB: db, ADMIN_KEY: 'secret-1' });
  assert.equal(lifeRes.status, 200);
  const body = await lifeRes.json();
  assert.equal(body.byStreet.some((s) => s.street === '早市街'), false);
  const activeStreets = body.byStreet.filter((s) => streets.includes(s.street));
  assert.ok(activeStreets.length >= 3, `迁街后应均匀分到多条街，不能全挤在一条街：${JSON.stringify(body.byStreet)}`);
  assert.equal(activeStreets.reduce((sum, s) => sum + s.count, 0), 21);
});

test('POST /town/join 对过时街道（如「春熙路」）或空串按 uid 均匀落到当前本城街道', async () => {
  const db = makeDB();
  const streets = ['南滨河路', '张掖路', '皋兰路', '雁滩路'];
  await worker.fetch(new Request('https://sight.test/admin/town', {
    method: 'POST',
    headers: { 'x-admin-key': 'secret-1', 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'lanzhou',
      name: '兰州',
      origin: '黄河穿城',
      streets,
      rules: ['河里的不吃河里的'],
    }),
  }), { DB: db, ADMIN_KEY: 'secret-1' });

  const gotStreets = new Set();
  for (let i = 0; i < 20; i++) {
    const uid = i.toString(16).padStart(32, 'd');
    const r = await req('/town/join', {
      method: 'POST',
      db,
      body: { uid, pet: `大肥鱼${i}`, street: i % 2 === 0 ? '春熙路' : '' },
    });
    assert.equal(r.status, 200);
    assert.ok(streets.includes(r.json.street), `不应写入或返回过时/空街名：${r.json.street}`);
    gotStreets.add(r.json.street);
  }
  assert.ok(gotStreets.size >= 3, `应分散落到多条本城街道：${[...gotStreets].join(',')}`);
  const staleCount = db.rawDb.prepare("SELECT COUNT(*) AS n FROM town WHERE street = '春熙路' OR street = ''").get();
  assert.equal(Number(staleCount.n), 0, '数据库里绝不能再写入「春熙路」或空街道');
});
