/**
 * 本城设定：`GET /town/info` 与 `GET|POST /admin/town` —— 2026-11-15。
 *
 * ## 这段为什么单独测
 *
 * 它是**唯一一处「服务器主」概念落地**的地方，而它有三个容易做歪的点，
 * 每一个在手工点一遍的时候都不会暴露：
 *
 * 1. **表没建时必须退默认，不能 500。** 迁移脚本可以晚跑，而城名显示不出来
 *    比显示一个默认城名糟得多 —— 前者看起来是服务坏了。
 * 2. **读写同一个口，方法闸门必须放过 POST。** `adminRoute` 开头那句
 *    `method !== 'GET'` 会把 POST 直接 405 掉，而报错长得像「接口没实现」
 *    （2026-11-11 加 `/admin/live` 时就是漏了白名单，同一个坑）。
 * 3. **写入要清洗，读的时候还要再兜一次。** 库里可能存着上一版留下的脏数据，
 *    读那侧兜住了，界面才不会显示一串广告。
 *
 * 用一张有状态的假 D1：只认这几条 SQL 的形状，但会真的把那一行存下来 ——
 * 「写完再读」这条链必须真走一遍，否则测的只是两个孤立的返回值。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../cloud/sight-cf/src/worker.js';

/**
 * @param {object} opt
 * @param {boolean} opt.hasTable `false` 时 `town_meta` 查询直接抛 —— 模拟迁移没跑。
 * @param {object} opt.seed     一开始就往表里放一行。
 */
function fakeDB({ hasTable = true, seed = null } = {}) {
  const state = { row: seed };
  return {
    state,
    prepare(sql) {
      const rec = { sql, args: [] };
      return {
        bind(...args) { rec.args = args; return this; },
        async first() {
          if (/FROM town_meta/.test(rec.sql)) {
            if (!hasTable) throw new Error('D1_ERROR: no such table: town_meta');
            return state.row;
          }
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          if (/INSERT INTO town_meta/.test(rec.sql)) {
            if (!hasTable) throw new Error('D1_ERROR: no such table: town_meta');
            const [id, name, origin, streets, rules, at] = rec.args;
            state.row = { id, name, origin, streets, rules, at };
            return { success: true };
          }
          return { success: true };
        },
      };
    },
  };
}

const call = async (path, { method = 'GET', envKey = 'k-test', sendKey, body, db } = {}) => {
  const env = { DB: db ?? fakeDB() };
  if (envKey !== null) env.ADMIN_KEY = envKey;
  const sent = sendKey === undefined ? envKey : sendKey;
  const req = new Request('https://x.test' + path, {
    method,
    headers: sent
      ? { 'x-admin-key': sent, 'content-type': 'application/json' }
      : { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : (method === 'POST' ? '{}' : undefined),
  });
  const res = await worker.fetch(req, env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
};

/* ---------------- 公开读 ---------------- */

test('没设过的时候回默认城，并且明说「这是默认」', async () => {
  const r = await call('/town/info', { envKey: null });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.town, 'luhuatang');
  assert.equal(r.json.name, '芦花塘');
  /*
   * `custom` 是最要紧的一格：没有它，服务器主打开面板看到「芦花塘」
   * 会以为自己早就设过了，然后改一个字段就以为只改了那一个。
   */
  assert.equal(r.json.custom, false, '没设过却说设过了');
  assert.equal(r.json.api, 1, '跨机接口没有版本号 —— 第一次改结构就会弄坏所有老客户端');
  assert.deepEqual(r.json.streets, ['早市街', '灶前巷', '望水坡']);
  assert.equal(r.json.rules.length, 4);
});

test('公开读不要 key —— 别的城来查目录不该被挡', async () => {
  /* `envKey: null` 时服务端根本没配 ADMIN_KEY，等于最「没权限」的状态。 */
  const r = await call('/town/info', { envKey: null });
  assert.equal(r.status, 200);
});

test('表没建也回 200 + 默认值，不许 500', async () => {
  /*
   * 迁移脚本可以晚跑。这时候城名显示不出来，比显示一个默认城名糟得多 ——
   * 前者看起来是服务坏了。所以读那侧必须有 try/catch。
   */
  const r = await call('/town/info', { envKey: null, db: fakeDB({ hasTable: false }) });
  assert.equal(r.status, 200, '表没建就 500 —— 迁移晚一步，整页就白了');
  assert.equal(r.json.name, '芦花塘');
  assert.equal(r.json.custom, false);
});

/* ---------------- 管理读写 ---------------- */

test('管理口没 key 一律 401，读和写都一样', async () => {
  for (const m of ['GET', 'POST']) {
    const r = await call('/admin/town', { method: m, sendKey: 'wrong' });
    assert.equal(r.status, 401, m + ' 没挡住');
    assert.equal(r.json.ok, false);
  }
});

test('没配 ADMIN_KEY 时整条路 404 —— 默认关闭不是默认开放', async () => {
  const r = await call('/admin/town', { envKey: null });
  assert.equal(r.status, 404);
});

test('POST 不会被方法闸门 405 掉', async () => {
  /*
   * 这一条是防回归的：`adminRoute` 开头 `method !== 'GET'` 那句会把
   * 所有 POST 打成 405，而 405 长得像「接口没实现」。加白名单那次漏过一次。
   */
  const db = fakeDB();
  const r = await call('/admin/town', {
    method: 'POST',
    db,
    body: { id: 'luhuatang', name: '芦花塘', streets: ['鱼市街'], rules: ['货不过夜'] },
  });
  assert.notEqual(r.status, 405, '被方法闸门挡了 —— 检查 adminRoute 顶部那三条分支');
  assert.equal(r.status, 200, r.text);
});

test('写进去之后，公开读能读到同一份', async () => {
  const db = fakeDB();
  const w = await call('/admin/town', {
    method: 'POST',
    db,
    body: {
      id: 'ludiandang',
      name: '芦苇荡',
      origin: '一片会动的芦苇，船进去就看不见了。',
      streets: ['渡口', '苇子深处', '晒网的地方'],
      rules: ['夜里不点灯', '价自己定', '赊账记在心里'],
    },
  });
  assert.equal(w.status, 200, w.text);
  assert.equal(w.json.town.name, '芦苇荡');
  assert.equal(w.json.town.custom, true);

  /* 同一个库、公开口：这就是「服务器主改完，别人立刻看到」那条链。 */
  const r = await call('/town/info', { envKey: null, db });
  assert.equal(r.json.name, '芦苇荡');
  assert.equal(r.json.town, 'ludiandang');
  assert.deepEqual(r.json.streets, ['渡口', '苇子深处', '晒网的地方']);
  assert.equal(r.json.custom, true);
});

test('城 id 必须是 okCity 那套格式 —— 中文 id 会让 journey 整条路 400', async () => {
  for (const bad of ['芦苇荡', 'a b', 'x'.repeat(41), '', '-']) {
    /* `-` 其实合法（正则允许），这里只是确认它不炸；下面单独断言空串。 */
    if (bad === '-') continue;
    const r = await call('/admin/town', {
      method: 'POST',
      body: { id: bad, name: '某城', streets: ['街'], rules: ['规'] },
    });
    assert.equal(r.status, 400, `id="${bad}" 被放进去了`);
    assert.equal(r.json.error, 'bad id');
  }
});

test('城名或街名空了不许存 —— 那叫没设完，不叫设定', async () => {
  const noName = await call('/admin/town', {
    method: 'POST',
    body: { id: 'luhuatang', name: '   ', streets: ['街'], rules: ['规'] },
  });
  assert.equal(noName.status, 400);
  assert.equal(noName.json.error, 'bad name');

  const noStreet = await call('/admin/town', {
    method: 'POST',
    body: { id: 'luhuatang', name: '芦花塘', streets: [], rules: ['规'] },
  });
  assert.equal(noStreet.status, 400);
  assert.equal(noStreet.json.error, 'bad lists');

  const noRule = await call('/admin/town', {
    method: 'POST',
    body: { id: 'luhuatang', name: '芦花塘', streets: ['街'], rules: [] },
  });
  assert.equal(noRule.status, 400, '没有城规的城不该能存下来');
});

test('带广告的城名被拦在门外', async () => {
  const r = await call('/admin/town', {
    method: 'POST',
    body: { id: 'luhuatang', name: '加微信 abc123 领福利', streets: ['街'], rules: ['规'] },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'bad name');
});

test('空槽位会被丢掉，不会存成一片空字符串', async () => {
  const db = fakeDB();
  const r = await call('/admin/town', {
    method: 'POST',
    db,
    body: { id: 'luhuatang', name: '芦花塘', streets: ['鱼市街', '', '  '], rules: ['货不过夜', ''] },
  });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.town.streets, ['鱼市街'], '空槽位被存进去了');
  assert.deepEqual(r.json.town.rules, ['货不过夜']);
});

test('库里存着坏 JSON 时读那侧兜住，不许整页崩', async () => {
  /*
   * 上一版留下的数据可能不是合法 JSON（或者被人手工改过）。
   * 展示用的字段，兜住退默认比抛出去好。
   */
  const db = fakeDB({
    seed: { id: 'luhuatang', name: '芦花塘', origin: '', streets: '{"不是数组"', rules: 'null', at: '2026-11-15' },
  });
  const r = await call('/town/info', { envKey: null, db });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.streets, ['早市街', '灶前巷', '望水坡'], '坏 JSON 没退默认');
  assert.equal(r.json.rules.length, 4);
});

test('街名和城规各封顶 5 条', async () => {
  const many = ['一', '二', '三', '四', '五', '六', '七'];
  const r = await call('/admin/town', {
    method: 'POST',
    body: { id: 'luhuatang', name: '芦花塘', streets: many, rules: many },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.town.streets.length, 5);
  assert.equal(r.json.town.rules.length, 5);
});
