/**
 * 「打算走了」—— 先宣布，第二天早上再动身（2026-11-15，A 方案）
 *
 * 用户来信的原始要求：**她没有被问过，也没有机会说不。**
 *
 * 原来的流程是「早上八点掷中 → 同一拍 moveOn → 推 journey.depart」，
 * 她连一句话都插不进去，于是会出现「大连才第三天，我还没待够」和
 * 「我这就上车了」隔二十秒同时到达用户眼前。
 *
 * 现在拆成两拍：
 *   第 N 天早上 —— 掷中只说一句「打算明天去 X」，今天不走；
 *   第 N+1 天早上 —— 说了就走，不再掷骰子。
 * 中间那一晚是她的余地：不想走就 `journey_stay`。
 *
 * 这里守四件事：
 *   ① 掷中当天不发车，只宣布，目的地记进 state；
 *   ② 第二天按宣布的那座城走，**不重新挑**（否则「说秦皇岛、去锦州」）；
 *   ③ `journey_stay` 能撤掉那一趟，撤完当天不走；
 *   ④ 没有等着走的那一趟时调 `journey_stay`，不报错、也不改状态。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

/** 北京时间 10:00 —— 当地决定点（8 点）已经过了。 */
const START = Date.parse('2026-11-05T02:00:00Z');

async function boot(trip) {
  const dir = mkdtempSync(join(tmpdir(), 'announce-depart-'));
  const clock = { v: new Date(START) };
  new StateStore(dir).save({ ...initialState('lanzhou'), lastSeenAt: clock.v.toISOString(), ...trip });
  const events = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  /* 0.99：不触发 20% 的「待够就回家」，也不触发 15% 的「再留一天」——「该走」变成确定性动作。 */
  const origRandom = Math.random;
  Math.random = () => 0.99;

  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', speed: 1 },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => clock.v,
  });
  await world.start({
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => { events.push(e); return { ...e, blobs: [] }; },
    pushDeferred() {},
    store: {},
    drainPendingEvents: async () => [],
  });

  return {
    world,
    events,
    clock,
    /** 时间往前走，但**人一直在电脑前** —— lastSeenAt 跟着走，别被当成离线。 */
    advance: (ms) => {
      clock.v = new Date(clock.v.getTime() + ms);
      world.st = { ...world.st, lastSeenAt: clock.v.toISOString() };
    },
    tick: (n = 2) => (async () => { for (let i = 0; i < n; i++) await world.tick(); })(),
    tool: (name) => world.tools().find((t) => t.name === name).handler,
    done: () => {
      globalThis.fetch = origFetch;
      Math.random = origRandom;
      world.stop?.();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 大连，住了 4 天 —— 撞 `STAY_DAYS_MAX`，必走。 */
const tooLong = (extra = {}) => ({
  phase: 'staying',
  hereId: 'dalian',
  homeId: 'lanzhou',
  tripStartedAt: '2026-10-28T00:00:00Z',
  stayStartedAt: '2026-11-01T00:00:00Z',
  stayDateKey: '2026-11-04',
  tripVisited: ['dalian'],
  ...extra,
});

const byType = (events, type) => events.filter((e) => String(e.type) === type);

/* ---------------- ① 掷中当天：只说，不走 ---------------- */

test('待够了：当天不出发，只宣布「打算明天去 X」', async () => {
  const t = await boot(tooLong());
  try {
    await t.tick(2);

    assert.equal(byType(t.events, 'journey.depart').length, 0, '当天就把车票买了');
    assert.equal(t.world.st.phase, 'staying', `已经在 ${t.world.st.phase} 了`);
    assert.equal(t.world.st.announceDeparted, undefined);
    assert.equal(t.world.st.announceDepartOn, '2026-11-05', '宣布日期没记成今天');
    assert.ok(t.world.st.announceCityId, '宣布了却没说去哪');

    const planned = byType(t.events, 'journey.departing');
    assert.equal(planned.length, 1, `预告推了 ${planned.length} 条`);
    assert.match(String(planned[0].text), /打算走了/, '预告里没写「打算」');
    assert.match(String(planned[0].text), /明天早上动身/, '预告没说什么时候走');
  } finally { t.done(); }
});

/* ---------------- ② 第二天：按宣布的那座城走 ---------------- */

test('第二天早上：走，而且去的是昨天说的那座城', async () => {
  const t = await boot(tooLong());
  try {
    await t.tick(2);
    const announced = t.world.st.announceCityId;
    assert.ok(announced, '前提没成立：没宣布');

    t.advance(24 * 3_600_000); // 到了第二天早上
    await t.tick(2);

    const depart = byType(t.events, 'journey.depart');
    assert.equal(depart.length, 1, `今天该走了，实际推了 ${depart.length} 条`);
    assert.equal(t.world.st.phase, 'traveling', `还没走，停在 ${t.world.st.phase}`);
    assert.equal(t.world.st.leg?.toId, announced, `昨天说去 ${announced}，今天去了 ${t.world.st.leg?.toId}`);
    assert.equal(t.world.st.announceDepartOn, null, '走了之后那一趟没清掉');
    assert.equal(t.world.st.announceCityId, null, '走了之后目的地没清掉');
  } finally { t.done(); }
});

/* ---------------- ③ 她说不走：撤掉，当天留下 ---------------- */

test('她说「再待一天」：那一趟撤掉，人还在这座城', async () => {
  const t = await boot(tooLong());
  try {
    await t.tick(2);
    assert.ok(t.world.st.announceDepartOn, '前提没成立：没宣布');

    const out = await t.tool('journey_stay')({ reason: '海还没看够，明天想再走一趟滨海路' });

    assert.doesNotMatch(String(out), /没有等着走/, `被拒了：${out}`);
    assert.match(String(out), /再待一天/, `回执不对：${out}`);
    assert.equal(t.world.st.announceDepartOn, null, '那一趟没撤掉');
    assert.equal(t.world.st.announceCityId, null, '目的地没清掉');
    assert.equal(t.world.st.phase, 'staying', '人走了');
    assert.equal(byType(t.events, 'journey.depart').length, 0, '撤了还是走了');

    const stay = byType(t.events, 'journey.stay');
    assert.equal(stay.length, 1, '留下的那句没推');
    assert.match(String(stay[0].text), /滨海路/, '她自己的理由没进事件');
  } finally { t.done(); }
});

test('撤掉之后再过一天：重新判，不是直接走', async () => {
  const t = await boot(tooLong());
  try {
    await t.tick(2);
    await t.tool('journey_stay')({ reason: '想再待一天' });
    const plannedBefore = byType(t.events, 'journey.departing').length;

    t.advance(24 * 3_600_000);
    await t.tick(2);

    /* 骰子按死在 0.99：又掷中 → 再宣布一次，仍然不发车。 */
    assert.equal(byType(t.events, 'journey.depart').length, 0, '撤了之后第二天直接走了');
    assert.equal(
      byType(t.events, 'journey.departing').length, plannedBefore + 1,
      '第二天没有重新判',
    );
  } finally { t.done(); }
});

/* ---------------- ④ 没那趟车的时候：不报错、不改状态 ---------------- */

test('没有等着走的那一趟：journey_stay 不报错，也不改状态', async () => {
  const t = await boot(tooLong({ announceDepartOn: null, announceCityId: null }));
  try {
    const before = { ...t.world.st };
    const out = await t.tool('journey_stay')({ reason: '随便说一句' });
    assert.match(String(out), /没有等着走/, `回执没讲清：${out}`);
    assert.equal(t.world.st.announceDepartOn, before.announceDepartOn);
    assert.equal(t.world.st.phase, 'staying');
  } finally { t.done(); }
});

test('不给理由：说清要一句话，不静默成功', async () => {
  const t = await boot(tooLong());
  try {
    await t.tick(2);
    const out = await t.tool('journey_stay')({ reason: '   ' });
    assert.match(String(out), /为什么/, `回执没说清要理由：${out}`);
    assert.ok(t.world.st.announceDepartOn, '没给理由却把那一趟撤了');
  } finally { t.done(); }
});
