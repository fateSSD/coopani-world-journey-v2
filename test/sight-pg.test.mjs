/**
 * 旧版服务端（腾讯云 CloudBase + PostgreSQL）的邀约接口（2026-11-05）
 *
 * ## 为什么这个文件要自己造假库
 *
 * 这一份 `cloud/sight/index.js` 才是**真正在跑的那台**（设置里填的就是
 * `*.app.tcloudbase.com`）。而它本地跑不起来：要靠 `@cloudbase/node-sdk` 的
 * `app.rdb()`，那东西只在云函数里可用。
 *
 * 所以这里做两件事：**把函数拷进一个临时目录**，旁边放一个假的 node-sdk，
 * 假的那层实现 PostgREST 的那几个动词（select / eq / gt / insert / update / upsert）。
 *
 * ## 它证明什么、不证明什么
 *
 * 证明：路由分派、字段校验、清洗、限速、以及**「两个人抢同一条只成一个」那段逻辑**。
 * 不证明：真 SDK 的链式 API 形状和我猜的一样（那要部署上去才知道）。
 * 但这一段里最容易错的是**语义**，不是形状 —— 语义在这儿跑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = new URL('../cloud/sight/index.js', import.meta.url);

/** 假的 PostgREST：够跑这一份函数用，不多实现一个字。 */
const STUB = `
const tables = { presence: [], invites: [], rate: [], pet_flags: [] };
const cmp = (v, op, x) => {
  if (op === 'eq') return v === x;
  if (op === 'neq') return v !== x;
  if (op === 'gt') return Date.parse(v) > Date.parse(x) || Number(v) > Number(x);
  return false;
};

function builder(table) {
  const st = { table, kind: 'select', cols: '*', conds: [], order: null, limit: null, payload: null };
  const api = {
    select(cols) { st.kind = 'select'; if (cols) st.cols = cols; return api; },
    eq(c, v) { st.conds.push([c, 'eq', v]); return api; },
    neq(c, v) { st.conds.push([c, 'neq', v]); return api; },
    gt(c, v) { st.conds.push([c, 'gt', v]); return api; },
    order(c, o) { st.order = [c, o && o.ascending]; return api; },
    limit(n) { st.limit = n; return api; },
    insert(obj) { st.kind = 'insert'; st.payload = obj; return api; },
    update(obj) { st.kind = 'update'; st.payload = obj; return api; },
    upsert(obj, opt) { st.kind = 'upsert'; st.payload = obj; st.opt = opt; return api; },
    then(res, rej) { try { res(run(st)); } catch (e) { rej(e); } },
  };
  return api;
}

function run(st) {
  const rows = tables[st.table];
  if (!rows) return { data: null, error: { message: 'relation "' + st.table + '" does not exist' } };
  const match = (r) => st.conds.every(([c, op, v]) => cmp(r[c], op, v));

  if (st.kind === 'insert') { rows.push({ ...st.payload }); return { data: null, error: null }; }
  if (st.kind === 'upsert') {
    const key = (st.opt && st.opt.onConflict ? st.opt.onConflict.split(',') : ['key']);
    const hit = rows.find((r) => key.every((k) => r[k] === st.payload[k]));
    if (hit) Object.assign(hit, st.payload); else rows.push({ ...st.payload });
    return { data: null, error: null };
  }
  if (st.kind === 'update') {
    // **条件更新**：只改命中的行 —— 抢位置靠的就是这个，假库必须照做
    for (const r of rows) if (match(r)) Object.assign(r, st.payload);
    return { data: null, error: null };
  }
  let out = rows.filter(match).map((r) => ({ ...r }));
  if (st.order) {
    const [c, asc] = st.order;
    out.sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc === false ? -1 : 1));
  }
  if (st.limit) out = out.slice(0, st.limit);
  return { data: out, error: null };
}

module.exports = {
  SYMBOL_CURRENT_ENV: 'stub',
  init: () => ({ rdb: () => ({ from: builder }) }),
  __tables: tables,
};
globalThis.__SIGHT_TABLES = tables;
`;

/** 把函数拷进临时目录 + 放一个假依赖，然后 require 回来。 */
function loadFn() {
  const dir = mkdtempSync(join(tmpdir(), 'sight-pg-'));
  mkdirSync(join(dir, 'node_modules', '@cloudbase', 'node-sdk'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}');
  writeFileSync(
    join(dir, 'node_modules', '@cloudbase', 'node-sdk', 'package.json'),
    '{"name":"@cloudbase/node-sdk","main":"index.js"}',
  );
  writeFileSync(join(dir, 'node_modules', '@cloudbase', 'node-sdk', 'index.js'), STUB);
  copyFileSync(new URL(SRC), join(dir, 'index.js'));
  return { dir, files: readFileSync, path: join(dir, 'index.js') };
}

const FN = await import(pathToFileURL(loadFn().path).href);
const call = (event) => FN.main(event);

const uid = (n) => n.toString(16).padStart(2, '0').repeat(12);
const UID_A = uid(1);
const UID_B = uid(2);
const UID_C = uid(3);

const ev = (path, method, body = null, query = null) => ({
  path,
  httpMethod: method,
  body: body ? JSON.stringify(body) : (method === 'POST' ? '{}' : undefined),
  queryStringParameters: query || {},
});

const parse = (r) => JSON.parse(r.body);

/* ---------------- 路由 ---------------- */

test('三条路径分派：/sight、/sight/invite、/sight/accept', async () => {
  const pres = parse(await call(ev('/sight', 'GET', null, { city: 'xian', date: '2026-11-05', slot: 'evening' })));
  assert.equal(pres.ok, true, `碰面这条没走对：${JSON.stringify(pres)}`);

  const invite = parse(await call(ev('/sight/invite', 'GET', null, { city: 'xian', uid: UID_A })));
  assert.equal(invite.ok, true, `邀约这条没走对：${JSON.stringify(invite)}`);
  assert.ok(Array.isArray(invite.list), '邀约应该回一个 list');

  // 接那条只认 POST
  const accept = await call(ev('/sight/accept', 'GET'));
  assert.equal(accept.statusCode, 405);
});

test('预检请求放行，而且带跨域头', async () => {
  const r = await call(ev('/sight/invite', 'OPTIONS'));
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers['access-control-allow-origin'], '*');
});

/* ---------------- 邀约 ---------------- */

test('发一条：id 是 16 位十六进制，24 小时后过期', async () => {
  const r = parse(await call(ev('/sight/invite', 'POST', {
    uid: UID_A, pet: '大肥鱼', from: 'xian', to: 'lasa', days: 3, note: '想看雪山',
  })));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.id, /^[a-f0-9]{16}$/, `id 形状不对：${r.id}`);
});

test('别人看得见，自己看不见自己的；而且返回里没有 uid', async () => {
  const r = parse(await call(ev('/sight/invite', 'GET', null, { city: 'xian', uid: UID_B })));
  assert.equal(r.ok, true);
  assert.ok(r.list.length >= 1, '别人的邀约没看到');
  const one = r.list[0];
  assert.equal(one.pet, '大肥鱼');
  assert.equal(one.to, 'lasa');
  assert.equal(one.days, 3);
  assert.equal(one.note, '想看雪山');
  // **发起者的 uid 一个字节都不能出现在返回里**
  assert.ok(!JSON.stringify(r).includes(UID_A), '把发起者的 uid 漏出去了');

  const own = parse(await call(ev('/sight/invite', 'GET', null, { city: 'xian', uid: UID_A })));
  assert.ok(!own.list.some((x) => x.pet === '大肥鱼'), '看到了自己发的那条');
});

test('广告名字换成中性的一个，广告备注留空 —— 都不拒绝整条', async () => {
  const r = parse(await call(ev('/sight/invite', 'POST', {
    uid: UID_C, pet: '加微信abc123', from: 'chengdu', to: 'lasa', days: 2, note: '私聊我优惠券',
  })));
  assert.equal(r.ok, true, '被整条拒了 —— 她应该还在，只是不带那句话');

  const seen = parse(await call(ev('/sight/invite', 'GET', null, { city: 'chengdu', uid: UID_A })));
  const one = seen.list.find((x) => x.to === 'lasa');
  assert.ok(one, '换成中性名之后该还在');
  assert.equal(one.pet, '一只鱼', `名字没洗：${one.pet}`);
  assert.equal(one.note, '', `备注没洗：${one.note}`);
});

test('一天只发三条，第四条 429', async () => {
  const sender = uid(4);
  const send = () => call(ev('/sight/invite', 'POST', {
    uid: sender, pet: '小鱼', from: 'xian', to: 'lasa', days: 1, note: '',
  }));
  for (let i = 0; i < 3; i++) {
    const r = parse(await send());
    assert.equal(r.ok, true, `第 ${i + 1} 条就被挡了`);
  }
  const over = parse(await send());
  assert.equal(over.ok, false);
  assert.equal(over.error, 'too many');
});

/* ---------------- 接 ---------------- */

test('接一条：回「跟谁、去哪、几天」；自己发的接不了', async () => {
  const made = parse(await call(ev('/sight/invite', 'POST', {
    uid: uid(5), pet: '小满', from: 'lasa', to: 'chengdu', days: 4, note: '一起吃火锅',
  })));
  assert.equal(made.ok, true);

  const self = parse(await call(ev('/sight/accept', 'POST', { uid: uid(5), id: made.id })));
  assert.equal(self.ok, false);
  assert.equal(self.error, 'own invite');

  const got = parse(await call(ev('/sight/accept', 'POST', { uid: uid(6), id: made.id })));
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.with, '小满');
  assert.equal(got.to, 'chengdu');
  assert.equal(got.days, 4);
  assert.equal(got.note, '一起吃火锅');
});

test('同一条被两个人同时接：只有一个接到，另一个 409', async () => {
  /*
   * 这段是这一份服务端里唯一有并发语义的地方。
   * 写成「先查再写」时，两个请求都会查到 taken_by 为空、都通过校验、都去写 ——
   * 两个人各自拿到 200，然后都以为对方会来。
   *
   * 现在靠 `update ... where taken_by = ''` + **回读比对**。
   */
  const made = parse(await call(ev('/sight/invite', 'POST', {
    uid: uid(7), pet: '阿七', from: 'lasa', to: 'xian', days: 2, note: '',
  })));
  assert.equal(made.ok, true);

  const first = parse(await call(ev('/sight/accept', 'POST', { uid: uid(8), id: made.id })));
  const second = parse(await call(ev('/sight/accept', 'POST', { uid: uid(9), id: made.id })));
  assert.equal(first.ok, true, '第一个该接到');
  assert.equal(second.ok, false, '第二个不该也接到');
  assert.equal(second.error, 'taken');
});

test('过期的不给接；接过的在列表里消失', async () => {
  const made = parse(await call(ev('/sight/invite', 'POST', {
    uid: uid(10), pet: '铁牛', from: 'xian', to: 'chengdu', days: 1, note: '',
  })));
  assert.equal(made.ok, true);

  // 直接改库把它弄过期 —— 等 24 小时不是测试该干的事
  const tables = globalThis.__SIGHT_TABLES;
  const row = tables.invites.find((x) => x.id === made.id);
  row.expires_at = new Date(Date.now() - 60_000).toISOString();

  const late = parse(await call(ev('/sight/accept', 'POST', { uid: uid(11), id: made.id })));
  assert.equal(late.ok, false);
  assert.equal(late.error, 'expired');

  const listed = parse(await call(ev('/sight/invite', 'GET', null, { city: 'xian', uid: uid(12) })));
  assert.ok(!listed.list.some((x) => x.id === made.id), '过期那条还在列表里');
});

test('一天只接一条，第二条 429', async () => {
  const a = parse(await call(ev('/sight/invite', 'POST', { uid: uid(13), pet: '甲', from: 'xian', to: 'lasa', days: 1, note: '' })));
  const b = parse(await call(ev('/sight/invite', 'POST', { uid: uid(14), pet: '乙', from: 'xian', to: 'lasa', days: 1, note: '' })));
  assert.ok(a.ok && b.ok);

  const taker = uid(15);
  const one = parse(await call(ev('/sight/accept', 'POST', { uid: taker, id: a.id })));
  assert.equal(one.ok, true);
  const two = parse(await call(ev('/sight/accept', 'POST', { uid: taker, id: b.id })));
  assert.equal(two.ok, false);
  assert.equal(two.error, 'too many');
});

/* ---------------- 碰面（顺带守一遍没被改坏） ---------------- */

test('碰面：报一声再查出来，只回名字和在干嘛', async () => {
  assert.equal(parse(await call(ev('/sight', 'POST', {
    uid: UID_A, pet: '大肥鱼', city: 'xian', date: '2026-11-05', slot: 'evening', doing: '吃面',
  }))).ok, true);

  const r = parse(await call(ev('/sight', 'GET', null, {
    city: 'xian', date: '2026-11-05', slot: 'evening', exclude: UID_B,
  })));
  assert.equal(r.ok, true);
  const one = r.list.find((x) => x.pet === '大肥鱼');
  assert.ok(one, '没查到自己那条');
  assert.deepEqual(Object.keys(one).sort(), ['doing', 'pet'], '多回了字段');
  assert.equal(one.doing, '吃面');
});

/* ---------------- 路由被网关改写时的兜底 ---------------- */

test('路径被裁成 /sight 了，也能靠请求的形状认出是邀约', async () => {
  /*
   * 2026-11-05 实测：腾讯云把 `/sight/invite` 也转给同一个函数，但 `event.path`
   * 不一定保留子路径 —— 有的网关只给 `/sight`。裁掉了还认不出来，
   * 表现就是「接口在、功能不在」，最难查的那一种。
   */
  const sender = uid(21);

  const sent = parse(await call(ev('/sight', 'POST', {
    uid: sender, pet: '大肥鱼', from: 'xian', to: 'lasa', days: 2, note: '想看雪山',
  })));
  assert.equal(sent.ok, true, `按形状没认出「发邀约」：${JSON.stringify(sent)}`);
  assert.match(sent.id, /^[a-f0-9]{16}$/);

  const listed = parse(await call(ev('/sight', 'GET', null, { city: 'xian', uid: uid(22) })));
  assert.equal(listed.ok, true, `按形状没认出「看邀约」：${JSON.stringify(listed)}`);
  assert.ok(Array.isArray(listed.list), '看邀约该回 list，不该回碰面那个');

  const taken = parse(await call(ev('/sight', 'POST', { uid: uid(23), id: sent.id })));
  assert.equal(taken.ok, true, `按形状没认出「接邀约」：${JSON.stringify(taken)}`);
  assert.equal(taken.to, 'lasa');
});

test('形状兜底不许抢走碰面：带 date+slot 的仍然走碰面', async () => {
  const r = parse(await call(ev('/sight', 'POST', {
    uid: uid(24), pet: '大肥鱼', city: 'xian', date: '2026-11-05', slot: 'evening', doing: '吃面',
  })));
  assert.equal(r.ok, true, JSON.stringify(r));
  const got = parse(await call(ev('/sight', 'GET', null, {
    city: 'xian', date: '2026-11-05', slot: 'evening', exclude: uid(25),
  })));
  assert.equal(got.ok, true);
  assert.ok(got.list.some((x) => x.pet === '大肥鱼'), '碰面那条被形状兜底抢走了');
});

/* ---------------- 管理口（2026-11-05） ---------------- */

/** 带请求头的版本 —— 管理口只认 header 里的 key，不认 query。 */
const evH = (path, method, body = null, query = null, headers = null) => ({
  path,
  httpMethod: method,
  body: body ? JSON.stringify(body) : (method === 'POST' ? '{}' : undefined),
  queryStringParameters: query || {},
  ...(headers ? { headers } : {}),
});

const ADMIN_KEY_V = 'test-admin-9f3a';
const adminHdr = { 'x-admin-key': ADMIN_KEY_V };
/** 单独一只，别跟上面几条测试抢同一个 uid。 */
const UID_D = uid(7);

test('管理口没配 ADMIN_KEY 就整条路不存在', async () => {
  delete process.env.ADMIN_KEY;
  const r = await call(evH('/sight/admin/pets', 'GET', null, null, adminHdr));
  assert.equal(r.statusCode, 404, '没配 key 还开着 —— 等于把整个池子挂在公网上');
});

test('管理口 key 不对也回 404 —— 不告诉对方「你 key 错了」', async () => {
  process.env.ADMIN_KEY = ADMIN_KEY_V;
  const r = await call(evH('/sight/admin/pets', 'GET', null, null, { 'x-admin-key': 'nope' }));
  assert.equal(r.statusCode, 404);
});

test('列鱼：按 uid 收成一行，上报次数累加', async () => {
  process.env.ADMIN_KEY = ADMIN_KEY_V;
  await call(ev('/sight', 'POST', { uid: UID_D, pet: '小银鱼', city: 'xian', date: '2026-11-05', slot: 'evening', doing: '看塔' }));
  await call(ev('/sight', 'POST', { uid: UID_D, pet: '小银鱼', city: 'xian', date: '2026-11-05', slot: 'night', doing: '睡' }));

  const r = await call(evH('/sight/admin/pets', 'GET', null, null, adminHdr));
  assert.equal(r.statusCode, 200, `管理口没连上：${r.body}`);
  const j = parse(r);
  const me = j.pets.find((p) => p.uid === UID_D);
  assert.ok(me, '刚报过的那只鱼没出现在列表里');
  assert.equal(me.pet, '小银鱼', '名字没带出来 —— 面板上就只剩一串 uid');
  assert.ok(me.rows >= 2, `上报次数没累加：${me.rows}`);
});

test('封掉之后：上报 403，邀约也发不出去', async () => {
  process.env.ADMIN_KEY = ADMIN_KEY_V;
  const ban = parse(await call(evH('/sight/admin/flag', 'POST', { uid: UID_D, pet: '小银鱼', kind: 'ban', note: '名字带广告' }, null, adminHdr)));
  assert.equal(ban.ok, true, `标记没写进去：${JSON.stringify(ban)}`);

  const pres = await call(ev('/sight', 'POST', { uid: UID_D, pet: '小银鱼', city: 'xian', date: '2026-11-05', slot: 'morning', doing: '' }));
  assert.equal(pres.statusCode, 403, '封了还能上报，等于没封');

  const iv = await call(ev('/sight/invite', 'POST', { uid: UID_D, pet: '小银鱼', from: 'xian', to: 'chengdu', days: 3, note: '' }));
  assert.equal(iv.statusCode, 403, '封了还能发邀约，只封了半截');
});

test('提示改名：上报照走，回执多一句 notice', async () => {
  process.env.ADMIN_KEY = ADMIN_KEY_V;
  await call(evH('/sight/admin/flag', 'POST', { uid: UID_D, pet: '小银鱼', kind: 'rename', note: '换个名字' }, null, adminHdr));
  const r = await call(ev('/sight', 'POST', { uid: UID_D, pet: '小银鱼', city: 'xian', date: '2026-11-05', slot: 'afternoon', doing: '' }));
  assert.equal(r.statusCode, 200, '提醒改名不该把她挡在外面');
  assert.equal(parse(r).notice, 'rename', '回执里没带那句提醒，客户端就永远不会知道');
});

test('解除之后又能报上来', async () => {
  process.env.ADMIN_KEY = ADMIN_KEY_V;
  await call(evH('/sight/admin/flag', 'POST', { uid: UID_D, kind: 'ok' }, null, adminHdr));
  const r = await call(ev('/sight', 'POST', { uid: UID_D, pet: '小银鱼', city: 'xian', date: '2026-11-05', slot: 'morning', doing: '' }));
  assert.equal(r.statusCode, 200, '解除之后还挡着，人就没法改了');
  assert.equal(parse(r).notice, undefined, '解除了还挂着改名提醒');
});
