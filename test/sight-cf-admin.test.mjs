/**
 * Cloudflare Worker 的管理口 —— 2026-11-05。
 *
 * 为什么要单独测这一段：那天线上「连不上」，查下来不是跨域，是**Worker 里没有
 * `/admin/pets` 这个路由**（而且 `ADMIN_KEY` 也没设）。代码写了不等于上了线，
 * 但至少这一段逻辑本身得是通的，否则上线之后又是一次来回。
 *
 * 用一张假 D1：只认这几条 SQL 的形状，不真的解析 SQL。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../cloud/sight-cf/src/worker.js';

const UID = 'a'.repeat(32);

function fakeDB() {
  const ops = [];
  const db = {
    ops,
    prepare(sql) {
      const rec = { sql, args: [] };
      return {
        bind(...args) { rec.args = args; return this; },
        async first() {
          ops.push({ ...rec, kind: 'first' });
          if (/FROM pet_flags WHERE uid/.test(sql)) return null;
          /* 两个 COUNT(DISTINCT uid)（`/admin/live` 的在线数与今天来过）给个非零值，
             否则「在线 0 只」这类断言永远看不见真数。 */
          if (/COUNT\(DISTINCT uid\)/.test(sql)) return { n: 1 };
          return null;
        },
        async all() {
          ops.push({ ...rec, kind: 'all' });
          /*
           * 累计那条查询改成子查询 + 窗口函数之后（2026-11-11），
           * `FROM presence p LEFT JOIN …` 这个字面不再存在 —— 假 DB 只认形状，
           * 形状变了就得跟着改。锚在 JOIN 上比锚在整段 FROM 上稳。
           */
          if (/LEFT JOIN pet_flags/.test(sql)) {
            return { results: [{ uid: UID, pet: '小银鱼', rows: 3, last: '2026-11-05T10:00:00Z', day: '2026-11-05', kind: 'rename', note: '名字带广告', flag_at: '2026-11-05' }] };
          }
          /* 「此刻」那块：每人取最近一条。形状是 `JOIN (SELECT uid, MAX(at)…)`。 */
          if (/JOIN \(\s*SELECT uid, MAX\(at\)/.test(sql)) {
            return { results: [{ uid: UID, pet: '小银鱼', city: 'xian', doing: '在城墙上走', at: '2026-11-11T00:10:00Z' }] };
          }
          if (/FROM pet_flags ORDER BY at/.test(sql)) {
            return { results: [{ uid: UID, pet: '小银鱼', kind: 'rename', note: '名字带广告', at: '2026-11-05' }] };
          }
          return { results: [] };
        },
        async run() { ops.push({ ...rec, kind: 'run' }); return { success: true }; },
      };
    },
  };
  return db;
}

/**
 * `envKey` 是服务端配的那个 secret，`sendKey` 是请求头里带过去的。
 * 两个分开写 —— 混用一个的话，「密钥不对」这种用例根本测不出来
 * （请求头和服务端永远一致）。
 */
const call = async (path, { method = 'GET', envKey = 'k-test', sendKey, body, db } = {}) => {
  const env = { DB: db ?? fakeDB() };
  if (envKey !== null) env.ADMIN_KEY = envKey;
  const sent = sendKey === undefined ? envKey : sendKey;
  const req = new Request('https://x.test' + path, {
    method,
    headers: sent ? { 'x-admin-key': sent, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : (method === 'POST' ? '{}' : undefined),
  });
  const res = await worker.fetch(req, env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text, env };
};

test('管理口：没配 ADMIN_KEY 时整条路 404（默认关闭）', async () => {
  const r = await call('/admin/pets', { envKey: null });
  assert.equal(r.status, 404, '没配 key 还开着 —— 等于把池子挂在公网上');
});

test('管理口：key 不对回 401，不告诉对方「你有 key 但错了」以外的东西', async () => {
  const r = await call('/admin/pets', { sendKey: 'wrong' });
  assert.equal(r.status, 401);
  assert.equal(r.json.ok, false);
});

test('管理口：列出鱼，带完整 uid 与已挂的标记', async () => {
  const r = await call('/admin/pets');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.pets.length, 1);
  const one = r.json.pets[0];
  assert.equal(one.uid, UID, 'uid 被打码了 —— 面板拿它封不了人');
  assert.equal(one.pet, '小银鱼');
  assert.equal(one.kind, 'rename');
  assert.equal(one.rows, 3);
});

test('管理口：封禁写进 pet_flags，解除是删行', async () => {
  const db = fakeDB();
  const ban = await call('/admin/flag', { method: 'POST', body: { uid: UID, pet: '小银鱼', kind: 'ban', note: '名字带广告' }, db });
  assert.equal(ban.status, 200, ban.text);
  const ins = db.ops.find((o) => o.kind === 'run' && /INSERT INTO pet_flags/.test(o.sql));
  assert.ok(ins, '没有写库');
  assert.deepEqual(ins.args.slice(0, 4), [UID, '小银鱼', 'ban', '名字带广告']);

  const ok = await call('/admin/flag', { method: 'POST', body: { uid: UID, kind: 'ok' }, db });
  assert.equal(ok.status, 200);
  assert.ok(db.ops.some((o) => o.kind === 'run' && /DELETE FROM pet_flags/.test(o.sql)), '解除没删行');
});

test('管理口：kind 只收三种，别的 400；GET /admin/flag 405', async () => {
  const bad = await call('/admin/flag', { method: 'POST', body: { uid: UID, kind: 'delete-all' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.ok, false);

  const wrongMethod = await call('/admin/flag', { method: 'GET' });
  assert.equal(wrongMethod.status, 405, 'GET 也能改数据就不对了');
});

test('管理口：uid 不合规直接拒，不写了半条', async () => {
  const db = fakeDB();
  const r = await call('/admin/flag', { method: 'POST', body: { uid: 'x', kind: 'ban' }, db });
  assert.equal(r.status, 400);
  assert.equal(db.ops.filter((o) => o.kind === 'run').length, 0, '非法 uid 还写了库');
});

test('管理口：此刻在线单独一个口，和累计分开', async () => {
  /*
   * 2026-11-11 Mr.Q：「把实时数据和累计数据分开」。
   *
   * 不只是显示分开 —— **接口也分开了**：自动刷新只打这个口，它只碰最近 30 分钟的行；
   * 累计那份要扫全表，只在人点「刷新」时拉。混在一起的时候，页面为了看一眼
   * 「在线几只」就把全表明细拉一遍，一天几百万行，把 D1 免费额度打光了。
   */
  const r = await call('/admin/live');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.online, 1);
  assert.equal(r.json.today, 1);
  assert.equal(r.json.onlineWindowMin, 30);
  assert.equal(r.json.pets.length, 1);
  assert.equal(r.json.pets[0].pet, '小银鱼');
  assert.equal(r.json.pets[0].doing, '在城墙里走' === '' ? '' : '在城墙上走');
  /* 累计那些字段不该出现在这儿 —— 混着回，下一个人又会把两个数读到一起。 */
  assert.equal('truncated' in r.json, false);
});

test('管理口：/live 也要 key', async () => {
  const r = await call('/admin/live', { sendKey: 'wrong' });
  assert.equal(r.status, 401);
});
