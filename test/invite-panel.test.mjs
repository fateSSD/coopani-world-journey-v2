/**
 * 「邀约」面板的后端（2026-11-25）。
 *
 * 面板本身是浏览器里跑的，这里验的是它脚下的三件事：
 * 1. `plan` 把两段路算对 —— 尤其**走不通的那一段要说出来**（牛津没有机场）；
 * 2. `post` 真的按填的表发出去，且「怎么去」写进了正文前缀（协议里没有这一格）；
 * 3. `board` 只读、**绝不触发 `?mine=1`** —— 那条是「认领一次就没了」的接口，
 *    面板每刷一次就认领一次，等于替她答应别人的约。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

function fakeHost() {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => ({ ...e, cursor: 1, blobs: [] }),
    pushDeferred() {},
    store: {},
    drainPendingEvents: async () => [],
    modelFacts: { accepts: () => false },
  };
}

/**
 * 造一个「人在成都、配了碰面服务器」的世界，并接管 `fetch`。
 * 返回 `calls`：每条请求的 url + body，用来验「发了什么」「有没有发不该发的」。
 */
async function boot({ status = null, inviteOk = true } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'jr-invite-panel-'));
  new StateStore(dataDir).save({
    ...initialState('lanzhou'),
    phase: 'staying',
    hereId: 'chengdu',
    tripStartedAt: '2026-11-20T00:00:00Z',
    stayStartedAt: '2026-11-24T00:00:00Z',
    stayDateKey: '2026-11-24',
  });
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (u.includes('/status')) {
      return {
        ok: true,
        status: 200,
        json: async () => status ?? { ok: true, pool: 12, list: [], mineTaken: 0 },
      };
    }
    if (u.includes('/invite')) {
      return {
        ok: inviteOk,
        status: inviteOk ? 200 : 500,
        json: async () => (inviteOk ? { ok: true, id: 'a1b2c3d4e5f6a7b8' } : { ok: false, error: 'boom' }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, list: [], pool: 0 }) };
  };
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', meetUrl: 'https://x.test' },
    dataDir,
    botName: '小满',
    now: () => new Date('2026-11-24T05:00:00Z'),
  });
  await world.start(fakeHost());
  const cleanup = () => {
    globalThis.fetch = origFetch;
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { world, calls, cleanup };
}

test('plan：默认在脚下这座城碰头 —— 只列真正要走的那一段，并给出可用交通方式', async () => {
  const { world, cleanup } = await boot();
  try {
    const p = await world.panelInvoke('invite', 'plan', ['拉萨', '']);
    assert.equal(p.ok, true, p.reason);
    assert.equal(p.here.name, '成都');
    assert.equal(p.dest.name, '拉萨');
    /* 碰头城 = 成都 = 她现在这儿 → 没有「去碰头」那一段，只剩成都 → 拉萨。 */
    assert.equal(p.legs.length, 1);
    assert.match(p.legs[0].label, /成都 → 拉萨/);
    assert.ok(p.legs[0].modes.length > 0, '成都到拉萨总得有能走的办法');
    assert.ok(p.legs[0].modes.includes('飞机'), `应列出飞机，实际：${p.legs[0].modes.join('/')}`);
    assert.equal(p.meet, null, '碰头城就是脚下这座时不该单列出来');
  } finally { cleanup(); }
});

test('plan：碰头城填别的城就变成两段，各自列各自的方式', async () => {
  const { world, cleanup } = await boot();
  try {
    const p = await world.panelInvoke('invite', 'plan', ['拉萨', '西安']);
    assert.equal(p.ok, true, p.reason);
    assert.equal(p.meet.name, '西安');
    assert.equal(p.legs.length, 2);
    assert.match(p.legs[0].label, /成都 → 西安 碰头/);
    assert.match(p.legs[1].label, /西安 → 拉萨/);
    for (const leg of p.legs) assert.ok(leg.modes.length > 0, `${leg.label} 应列出方式`);
  } finally { cleanup(); }
});

test('plan：走不通的一段要当场说出来（牛津没有机场），而不是发布后才被拒', async () => {
  const { world, cleanup } = await boot();
  try {
    const p = await world.panelInvoke('invite', 'plan', ['牛津', '']);
    assert.equal(p.ok, false, '成都到牛津没有可用方式');
    assert.equal(p.legs[0].modes.length, 0);
    assert.match(p.reason, /没有能走的交通方式/);
  } finally { cleanup(); }
});

test('plan：城市表里没有的名字、以及「她现在就在这儿」，都给一句人话', async () => {
  const { world, cleanup } = await boot();
  try {
    const typo = await world.panelInvoke('invite', 'plan', ['剑桥', '']);
    assert.equal(typo.ok, false);
    assert.match(typo.nameProblem, /城市表里没有「剑桥」/);

    const same = await world.panelInvoke('invite', 'plan', ['成都', '']);
    assert.equal(same.ok, false);
    assert.match(same.reason, /就在成都/);
  } finally { cleanup(); }
});

test('post：按填的表发出去，「怎么去」走协议真字段，碰头城照填的发', async () => {
  const { world, calls, cleanup } = await boot();
  try {
    const r = await world.panelInvoke('invite', 'post', ['拉萨', '西安', 3, '一起去看布达拉宫', '火车']);
    assert.equal(r.ok, true, r.text);
    const post = calls.find((c) => c.url.endsWith('/invite') && c.body);
    assert.ok(post, '没有发出 /invite 请求');
    assert.equal(post.body.to, 'lasa');
    assert.equal(post.body.days, 3);
    assert.equal(post.body.meet, 'xian', '碰头城按城市 id 发');
    assert.equal(post.body.from, 'chengdu', '出发地是她脚下这座城');
    /*
     * 2026-11-25 起「怎么去」是协议里的 `mode` 字段，不再往正文里拼前缀。
     * 这两条断言是一对：字段在，正文干净 —— 只测一半就会漏掉「拼了两遍」。
     */
    assert.equal(post.body.mode, '火车', `走法没进 mode 字段：${JSON.stringify(post.body.mode)}`);
    assert.equal(post.body.note, '一起去看布达拉宫', `正文里还混着走法：${post.body.note}`);
  } finally { cleanup(); }
});

test('post：选了个这条路上没有的方式 —— 丢掉方式，但别把整条邀约一起拒了', async () => {
  const { world, calls, cleanup } = await boot();
  try {
    /*
     * 成都 → 拉萨 只有火车和飞机。页面停在旧结果上时（他刚改过目的地、
     * 方式列表还没刷回来）完全可能递一个「轮船」上来 ——
     * 那是附注，不该让一条本来发得出去的邀约发不出去。
     */
    const r = await world.panelInvoke('invite', 'post', ['拉萨', '西安', 3, '一起去看布达拉宫', '轮船']);
    assert.equal(r.ok, true, r.text);
    const post = calls.find((c) => c.url.endsWith('/invite') && c.body);
    assert.ok(post, '没有发出 /invite 请求');
    assert.equal(post.body.mode, '', `走不通的方式不该发出去：${JSON.stringify(post.body.mode)}`);
    assert.equal(post.body.note, '一起去看布达拉宫', '正文不该被改');
  } finally { cleanup(); }
});

test('post：服务器拒了就如实回一句，不假装发出去', async () => {
  const { world, cleanup } = await boot({ inviteOk: false });
  try {
    const r = await world.panelInvoke('invite', 'post', ['拉萨', '', 2, '', '']);
    assert.equal(r.ok, false);
    assert.match(r.text, /没发出去/);
  } finally { cleanup(); }
});

test('board：只读一栏 —— 读得到池子与挂着的那几条，且**绝不**调 ?mine=1', async () => {
  const status = {
    ok: true,
    pool: 641,
    mineTaken: 2,
    list: [
      { id: 'aaaaaaaaaaaaaaaa', pet: '小雪', from: 'xian', to: 'lasa', days: 3, note: '一起去看布达拉宫', at: '2026-11-24T03:00:00Z', meet: 'xian', pace: 1, mode: '火车', near: true },
      /* 这一条故意不给 `at` —— 老服务端不回这一格时，界面不该编一个时间出来。 */
      { id: 'bbbbbbbbbbbbbbbb', pet: '阿岸', from: 'haerbin', to: 'kunming', days: 2, note: '', meet: '', pace: 1, near: false },
    ],
  };
  const { world, calls, cleanup } = await boot({ status });
  try {
    /*
     * 开机本身会走「认领别人接了她的话」那条（`?mine=1`）—— 那是世界自己的节拍，
     * 不是面板干的。所以只盯**这次 board 之后新发出去的请求**。
     */
    const before = calls.length;
    const b = await world.panelInvoke('invite', 'board', []);
    assert.equal(b.ready, true, b.reason);
    assert.equal(b.pool, 641);
    assert.equal(b.mineTaken, 2);
    assert.equal(b.list.length, 2);
    assert.equal(b.list[0].toName, '拉萨');
    assert.equal(b.list[0].meetName, '西安', '碰头城的 id 要翻成名字');
    assert.equal(b.list[1].meetName, '', '没填碰头城就是空');
    /* 对方挑的走法要能到前端 —— 公告栏上那一行就是靠它。空的就留空，别编。 */
    assert.equal(b.list[0].mode, '火车');
    assert.equal(b.list[1].mode, '', '对方没挑走法就应该是空串');
    /*
     * 出发城（2026-11-25）。全服可见之后这一格是必要的：
     * 不写「她是从哪儿发的」，接的人不知道要先往哪儿去。
     */
    assert.equal(b.list[0].fromName, '西安');
    assert.equal(b.list[1].fromName, '哈尔滨');
    assert.equal(b.list[0].near, true, '同城那条要带 near');
    assert.equal(b.list[1].near, false, '外地的不是 near');
    /* 多久之前（2026-11-25）：这个 world 的 now 固定 05:00，那条是 03:00 发的。 */
    assert.equal(b.list[0].ageText, '2 小时前', `发布时间算错：${b.list[0].ageText}`);
    assert.equal(b.list[1].ageText, '', '没给 at 的老服务端，这一格该是空串');
    /*
     * 这条是这一页的命门：`/invite?mine=1` 会让服务端把结果置成「已认领」，
     * 并在本地建一份约定 —— 面板刷新一次就等于替她认下一桩约。
     */
    const after = calls.slice(before);
    assert.ok(!after.some((c) => c.url.includes('mine=1')), `面板不该碰 ?mine=1：${after.map((c) => c.url).join(' , ')}`);
    assert.ok(after.some((c) => c.url.includes('/status')), '公告栏应走 /status');
  } finally { cleanup(); }
});

test('board：没配碰面服务器时说清是哪一种没配，不是一句「加载失败」', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'jr-invite-nomeet-'));
  new StateStore(dataDir).save({ ...initialState('lanzhou'), phase: 'staying', hereId: 'chengdu' });
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', meetUrl: '' },
    dataDir,
    botName: '小满',
    now: () => new Date('2026-11-24T05:00:00Z'),
  });
  await world.start(fakeHost());
  try {
    const b = await world.panelInvoke('invite', 'board', []);
    assert.equal(b.ready, false);
    assert.match(b.reason, /还没配碰面服务器/);

    const p = await world.panelInvoke('invite', 'plan', ['拉萨', '']);
    assert.equal(p.meetReady, false);
    assert.match(p.reason, /碰面服务器/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('board：人在路上时，「发不了」的理由要写出来（按钮灰着也要有解释）', async () => {
  const { world, cleanup } = await boot();
  try {
    world.st = {
      ...world.st,
      phase: 'traveling',
      leg: {
        id: 'L1', fromId: 'chengdu', toId: 'lasa', modeId: 'train', km: 2000,
        durationWorldHours: 20, departedAt: '2026-11-24T00:00:00Z',
        arriveAt: '2026-11-24T20:00:00Z', speed: 1, viaIds: [], createdAt: '2026-11-24T00:00:00Z',
      },
    };
    const b = await world.panelInvoke('invite', 'board', []);
    assert.match(b.canPost, /在路上/);
  } finally { cleanup(); }
});
