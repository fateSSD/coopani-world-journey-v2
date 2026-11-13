/**
 * 定期看一眼邀约，**只在真有人找伴时**提一句 —— 2026-11-06
 *
 * Mr.Q 问「鱼收发邀请都是自动的嘛」。查下来：发和接都是她自己判断，
 * 但**她只在排表那一刻才看到邀约列表** —— 别人中午发的，可能第二天早上才发现，
 * 而邀约 24 小时就过期。这条补的就是那个缺口。
 *
 * 花钱的地方只有一处：**推事件**（她开口说一句 = 一次模型调用）。所以两道闸：
 * 每条只提一次、一天最多两条。拉列表本身是只读请求，不占配额。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

const MINE = '小满';

function fakeHost(events) {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => { events.push(e); return { ...e, blobs: [] }; },
    pushDeferred() {}, store: {}, drainPendingEvents: async () => [],
  };
}

/** `list` 是 `/invite` 要回的东西；`/sight` 一律回空（这组只管邀约）。 */
async function boot(list) {
  const dataDir = mkdtempSync(join(tmpdir(), 'jr-peek-'));
  new StateStore(dataDir).save({
    ...initialState('lanzhou'),
    phase: 'staying',
    hereId: 'chengdu',
    tripStartedAt: '2026-11-05T00:00:00Z',
    stayStartedAt: '2026-11-06T04:00:00Z',
    stayDateKey: '2026-11-06',
  });
  let nowMs = Date.parse('2026-11-06T05:00:00Z');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    /*
     * 2026-11-06 起「池子多大 + 谁在找伴」走同一个请求 `/sight/status`。
     * `mine=1` 那条（谁接了她的话）仍是 `/invite`，要分开回 —— 混着回会被当成
     * 「有人接了她的话」，先推一条 invite-taken，把这组计数全带偏。
     */
    if (u.includes('/status')) return { ok: true, status: 200, json: async () => ({ ok: true, pool: 3, list }) };
    if (u.includes('/invite')) return { ok: true, status: 200, json: async () => ({ ok: true, list: [] }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, list: [], pool: 3 }) };
  };
  const events = [];
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', meetUrl: 'https://x.test' },
    dataDir,
    botName: MINE,
    now: () => new Date(nowMs),
  });
  await world.start(fakeHost(events));
  return {
    world,
    events,
    /** 把世界时间往前推，好越过 30 分钟那道闸。 */
    advance: (min) => { nowMs += min * 60_000; },
    invites: () => events.filter((e) => e.type === 'journey.invite'),
    restore: () => { globalThis.fetch = origFetch; world.stop?.(); },
  };
}

const one = (id, pet, to = 'xian', days = 3, note = '') => ({ id, pet, to, days, note });

test('有人找伴：推一条事件，说清是谁、去哪、几天', async () => {
  const { world, invites, restore } = await boot([one('aaaaaaaaaaaaaaaa', '小渔')]);
  try {
    await world.tick();
    const list = invites();
    assert.equal(list.length, 1, `应该推一条，实际 ${list.length}`);
    assert.match(list[0].text, /小渔/);
    assert.match(list[0].text, /西安/);
    assert.match(list[0].text, /3 天/);
  } finally { restore(); }
});

test('同一条邀约只提一次', async () => {
  const { world, advance, invites, restore } = await boot([one('bbbbbbbbbbbbbbbb', '小渔')]);
  try {
    await world.tick();
    advance(40);
    await world.tick();
    assert.equal(invites().length, 1, '同一条被提了两次 —— 那是骚扰');
  } finally { restore(); }
});

test('一天最多提两条：第三、四条今天不提，且不算「已经提过」', async () => {
  const { world, advance, invites, restore } = await boot([
    one('c1c1c1c1c1c1c1c1', '甲'), one('c2c2c2c2c2c2c2c2', '乙'), one('c3c3c3c3c3c3c3c3', '丙'),
  ]);
  try {
    for (let i = 0; i < 3; i++) { await world.tick(); advance(40); }
    assert.equal(invites().length, 2, `封顶失效：推了 ${invites().length} 条`);
    /*
     * 第三条**不能**进 seen —— seen 的意思是「已经跟她提过」。
     * 把没提过的写进去，它明天也提不到了（一天只提一条时，池子里三条永远只看得到第一条）。
     */
    assert.equal(world.st.inviteSeen.includes('c3c3c3c3c3c3c3c3'), false,
      '没提过的被记账了 —— 这条邀约以后再也提不到');
  } finally { restore(); }
});

test('自己发的、去现在的城市、去她家的，都不提', async () => {
  const { world, invites, restore } = await boot([
    one('d1d1d1d1d1d1d1d1', MINE),        // 自己发的
    one('d2d2d2d2d2d2d2d2', '甲', 'chengdu'), // 就是她现在这座城
    one('d3d3d3d3d3d3d3d3', '乙', 'lanzhou'), // 去她家
  ]);
  try {
    await world.tick();
    assert.equal(invites().length, 0, '提了不该提的');
  } finally { restore(); }
});

test('没配服务器：一次都不提，也不写状态', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'jr-peek2-'));
  new StateStore(dataDir).save({ ...initialState('lanzhou') });
  const events = [];
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir,
    botName: MINE,
    now: () => new Date('2026-11-06T05:00:00Z'),
  });
  await world.start(fakeHost(events));
  try {
    await world.tick();
    assert.equal(events.filter((e) => e.type === 'journey.invite').length, 0);
  } finally { world.stop?.(); }
});
