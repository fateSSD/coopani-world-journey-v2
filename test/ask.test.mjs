/**
 * 「出门等点头」这件事本身（2026-11-06）
 *
 * ## 原来的样子
 *
 * `tick()` 里只有一句 `if (this.cfg.askBeforeDepart) return;` —— 开关一开，
 * 那条鱼**从此再没出过门，而且一句话都不说**。用户看到的是「她在家躺了半个月」，
 * 只会以为扩展坏了。开关的意思是「先问问我」，而「问」这个动作原来根本不存在。
 *
 * ## 现在要守的三件事
 *
 * 1. **问，而且要问得出来。** 面板上那张卡片（一句话 + 好 / 不好）就是「问」本身。
 * 2. **问了不许自己先走。** 答「好」之前 `phase` 必须还是 `home`。
 * 3. **问了不许反复问。** 同一时刻只有一张单；被回绝之后要冷一天。
 *
 * 另外两条与它配套：在家也能**看见**别人的邀约；开了开关时接邀约要先问过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

function fakeHost(events) {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => {
      events.push(e);
      return { ...e, blobs: [] };
    },
    pushDeferred() {},
    store: {},
    drainPendingEvents: async () => [],
  };
}

/**
 * 起一台 World，时钟钉死在一个时刻。
 *
 * `now` 是**真实时刻**，世界时刻由它推（没有 clock 基准时两者相同）。
 * 2026-11-04T04:00:00Z = 兰州中午 12 点 —— 在 7–21 点的出门窗口里面。
 */
async function boot(trip, nowISO) {
  const dataDir = mkdtempSync(join(tmpdir(), 'jr-ask-'));
  new StateStore(dataDir).save({ ...initialState('lanzhou'), ...trip });
  const events = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir,
    botName: '大肥鱼',
    now: () => new Date(nowISO),
  });
  await world.start(fakeHost(events));
  return {
    world,
    events,
    restore: () => { globalThis.fetch = origFetch; world.stop(); },
  };
}

/** 面板快照。「他现在能看到什么」这件事的唯一口径。 */
const snapOf = (world) => world.webUi().invoke('now', 'snapshot', []);
/** 按钮那一下。 */
const answer = (world, ok) => world.webUi().invoke('now', 'answerAsk', [ok]);

/** 邀约链路的假服务器（列表在顶层 `list`，成交在顶层字段）。 */
function inviteServer(one) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/invite?')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, list: [one] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, with: one.pet, to: one.to, days: one.days, note: one.note }),
    };
  };
}

test('开关开着：她会问一句，而不是一动不动', async () => {
  const { world, events, restore } = await boot({ phase: 'home', hereId: 'lanzhou' }, '2026-11-04T04:00:00Z');
  try {
    world.cfg.askBeforeDepart = true;
    await world.tick();

    const snap = await snapOf(world);
    assert.ok(snap.ask, '开关开着，面板上却什么都没有 —— 他不会知道她在等');
    assert.equal(snap.ask.kind, 'depart');
    assert.ok(snap.ask.city, '没说要去哪');
    assert.match(snap.ask.line, /让我走|去/);
    // 问了不等于走了。
    assert.equal(world.st.phase, 'home', '说好等他点头，结果自己先走了');
    assert.equal(events.filter((e) => e.type === 'journey.ask').length, 1, '没有一条她看得见的话');
  } finally { restore(); }
});

test('问一次就够 —— 巡检再来几轮也不重复问', async () => {
  const { world, events, restore } = await boot({ phase: 'home', hereId: 'lanzhou' }, '2026-11-04T04:00:00Z');
  try {
    world.cfg.askBeforeDepart = true;
    await world.tick();
    await world.tick();
    await world.tick();
    assert.equal(events.filter((e) => e.type === 'journey.ask').length, 1, '同一件事问了三遍');
    const snap = await snapOf(world);
    assert.ok(snap.ask);
  } finally { restore(); }
});

test('他答「好」：真的上路，去的就是她问的那座城', async () => {
  const { world, restore } = await boot({ phase: 'home', hereId: 'lanzhou' }, '2026-11-04T04:00:00Z');
  try {
    world.cfg.askBeforeDepart = true;
    await world.tick();
    const asked = (await snapOf(world)).ask;
    assert.ok(asked);
    const askedCityId = world.st.ask.cityId;

    await answer(world, true);
    assert.equal(world.st.ask, null, '答完了那张单还挂着');
    assert.equal(world.st.phase, 'traveling', '答了好却没走');
    // 问的是 A、走的是 B —— 这套功能最难看的一种错。
    assert.equal(world.st.leg.toId, askedCityId, '走的方向和问的那座城不是一回事');
    const snap = await snapOf(world);
    assert.equal(snap.ask, null);
    assert.equal(snap.mode, 'traveling');
  } finally { restore(); }
});

test('他答「不好」：算了，而且不会掉头又问一遍', async () => {
  const { world, events, restore } = await boot({ phase: 'home', hereId: 'lanzhou' }, '2026-11-04T04:00:00Z');
  try {
    world.cfg.askBeforeDepart = true;
    await world.tick();
    assert.ok((await snapOf(world)).ask);

    await answer(world, false);
    assert.equal(world.st.ask, null);
    assert.ok(world.st.askNoAt, '没记下回绝时刻，下一轮会立刻再问');
    assert.equal(world.st.phase, 'home');
    assert.match(String(events.at(-1).text), /不好/, '回绝这件事她该说一句');

    // 冷却期内再巡检：不许重问。
    await world.tick();
    assert.equal(world.st.ask, null, '刚说完不好就又问了一遍 —— 那叫骚扰');
  } finally { restore(); }
});

test('她那边半夜不问 —— 凌晨三点弹「让我出门吧」是没常识', async () => {
  // 2026-11-04T18:00:00Z = 兰州次日 02:00。
  const { world, restore } = await boot({ phase: 'home', hereId: 'lanzhou' }, '2026-11-04T18:00:00Z');
  try {
    world.cfg.askBeforeDepart = true;
    await world.tick();
    assert.equal(world.st.ask, null, '半夜来问了一句');
  } finally { restore(); }
});

test('在家也看得见喊话 —— 「接不了」和「看不见」是两件事', async () => {
  const { world, restore } = await boot({ phase: 'home', hereId: 'lanzhou' }, '2026-11-04T04:00:00Z');
  try {
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    globalThis.fetch = inviteServer({
      id: 'abcdef0123456789', pet: '小满', to: 'chengdu', days: 3, note: '一起吃火锅',
    });
    const out = await world.tools().find((t) => t.name === 'journey_accept').handler({});
    assert.ok(!out.isError, `在家看不到邀约：${out.text}`);
    assert.match(String(out.text), /小满/, '没说是谁在找伴');
    assert.match(String(out.text), /成都/);
  } finally { restore(); }
});

test('开了开关时接邀约要先问 —— 没点头之前不许答应任何人', async () => {
  const { world, restore } = await boot({
    phase: 'staying',
    hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
    stayDateKey: '2026-11-04',
  }, '2026-11-04T04:00:00Z');
  try {
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    world.cfg.askBeforeDepart = true;
    globalThis.fetch = inviteServer({
      id: 'abcdef0123456789', pet: '小满', to: 'chengdu', days: 3, note: '一起吃火锅',
    });

    const out = await world.tools().find((t) => t.name === 'journey_accept')
      .handler({ id: 'abcdef0123456789' });
    assert.ok(!out.isError, `该记下这张请求：${out.text}`);
    assert.equal(world.st.pledge, null, '他还没点头，就先把人答应了');

    const snap = await snapOf(world);
    assert.ok(snap.ask, '没生成待批的单子');
    assert.equal(snap.ask.kind, 'accept');
    assert.equal(snap.ask.city, '成都');
    assert.equal(snap.ask.withPet, '小满');
    assert.equal(snap.ask.days, 3);

    // 他答「好」之后才真的接。
    await answer(world, true);
    const p = world.st.pledge;
    assert.ok(p, '答了好却没接下');
    assert.equal(p.cityId, 'chengdu');
    /*
     * 她本来就在西安待着，所以这一趟不是「立刻上路」，而是**下一站往成都走** ——
     * 什么时候动身由 `stayTick` 按当天作息决定（跟原来自动接的那条路一致）。
     * 这里只验承诺真的落到了行程上，不代它规定几点出发。
     */
    assert.equal(world.st.ask, null);
    assert.equal(world.st.phase, 'staying');
  } finally { restore(); }
});

/**
 * 手上有约时，那张待批单上的城市必须是**约定的那一站**（2026-11-12）。
 *
 * Discussion #586 的原始现场：她和别人约好了去某地，面板却推来一座系统自己挑的城。
 * 他一点「好」，`answerAsk` 把那座城当指定目的地传进 `depart`，
 * 而 `depart` 第一行是 `opts.to ? null : activePledge()` —— **约定被整个丢掉**。
 * 用户看到的就是「约好了人，上了车却去了别处，到了只能自己慢慢找」。
 *
 * 这条守的是**问的和去的必须是同一座城，而且就是约定的那座**。
 */
test('手上有约：问的就是约定的那一站，不是系统自己挑的城', async () => {
  const { world, restore } = await boot({
    phase: 'home',
    hereId: 'lanzhou',
    pledge: {
      cityId: 'lasa',
      days: 3,
      withPet: '大肥鱼',
      withPets: ['大肥鱼'],
      inviteId: 'ef5d38ca00d35ae3',
      // 半小时前刚接的，还在有效窗口里。
      acceptedAt: '2026-11-04T03:30:00Z',
      arrivedAt: null,
    },
  }, '2026-11-04T04:00:00Z');
  try {
    world.cfg.askBeforeDepart = true;
    await world.tick();

    const snap = await snapOf(world);
    assert.ok(snap.ask, '开关开着、手上还有约，却什么都没问');
    assert.equal(world.st.ask.cityId, 'lasa',
      `约好的是拉萨，问的却是 ${world.st.ask.cityId} —— 他一点「好」就去了别处`);
    assert.match(String(snap.ask.line), /约好/, '赴约被说成了「她想出门」');

    await answer(world, true);
    assert.equal(world.st.phase, 'traveling');
    assert.equal(world.st.leg.toId, 'lasa', '点了好，去的不是约定的那座城');
  } finally { restore(); }
});
