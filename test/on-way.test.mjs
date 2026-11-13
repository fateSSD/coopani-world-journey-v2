/**
 * 城里移动那一段（2026-11-11）。
 *
 * 用户转来的反馈：「我鱼说打车要 34 分钟到，然后转头就跟我说到了。」
 *
 * 时间轴一直是准的 —— `planDay` 把通勤排在「活动时刻 − 路上分钟」，
 * 34 分钟一分不少地占着。**缺的是「这 34 分钟里她在哪」这句话**：
 * `journey.now` 原来只有「此刻在X」和「下一个点 14:34 在兵马俑」，
 * 通勤那段两条都不命中，于是她答不出「还要几分钟」，
 * 别的扩展从快照里也读不到「在路上」这个状态。
 *
 * 这一组盯三件事：
 *   1. 落在通勤区间里 → 有 what / leftMin / arriveAt
 *   2. 已经到景点（活动区间内）→ null，不能同时说「在路上」和「在兵马俑」
 *   3. 还没出发 / 歇着的日子 → null
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

/** 西安是 UTC+8：当地 10:20 = 02:20Z。倍速 1，世界时刻就是真实时刻。 */
const LOCAL_1020 = '2026-10-31T02:20:00Z';

function seedStaying(stateOver = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-onway-'));
  new StateStore(dir).save({
    ...initialState('lanzhou'),
    phase: 'staying',
    hereId: 'xian',
    stayDateKey: '2026-10-31',
    ...stateOver,
  });
  return dir;
}

function makeWorld(dir, localIso = LOCAL_1020) {
  return new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(localIso),
  });
}

/** 打车 34 分钟：10:00 出发，10:34 到景点。`planDay` 就是照这个关系排的。 */
function planWithCommute() {
  return {
    dateKey: '2026-10-31',
    meals: [],
    beats: [
      { at: 10, kind: 'commute', what: '打车去兵马俑' },
      { at: 10 + 34 / 60, kind: 'activity', what: '在兵马俑', spot: '兵马俑', until: 12 },
    ],
    lodging: { kind: 'chain', name: '某某宾馆', price: 200, feel: '' },
    commute: { trips: 1, price: 30, modes: ['出租车'] },
    sunriseHour: null,
    sunsetHour: null,
    weather: null,
    /* `uiSnapshot` 还会读这几项（同城的人、邀约、池子）。真实的 plan 一定有，
       这里补上是因为 `plan?.neighbors.length` 只保护 plan 本身，不保护字段。 */
    neighbors: [],
    invites: [],
    pool: 0,
  };
}

/** `plan` / `onWayNow` 都是私有的，但这几条测试要的就是它们，用 any 访问。 */
function withPlan(world) {
  world.plan = planWithCommute();
  return world;
}

test('在通勤区间里：说得出「打车去兵马俑，还要 14 分钟」', () => {
  const w = withPlan(makeWorld(seedStaying()));
  const r = w.onWayNow();
  assert.ok(r, '落在通勤区间里却给了 null —— 那段时间在状态里又是空的');
  assert.equal(r.what, '打车去兵马俑');
  assert.equal(r.leftMin, 14, `10:20 到 10:34 应该剩 14 分钟，实际 ${r.leftMin}`);
  assert.equal(r.arriveAt, '10:34');
});

test('已经到了景点：不能同时说「在路上」和「在兵马俑」', () => {
  const w = withPlan(makeWorld(seedStaying(), '2026-10-31T02:40:00Z')); // 当地 10:40
  assert.equal(w.onWayNow(), null, '已经在活动区间里了，还在报「在路上」');
});

test('还没出发：10:00 之前不算在路上', () => {
  const w = withPlan(makeWorld(seedStaying(), '2026-10-31T01:30:00Z')); // 当地 09:30
  assert.equal(w.onWayNow(), null);
});

test('歇着的日子不报通勤 —— 那天表里的景点本来就不去了', () => {
  /* 直接设内存里的 `st`：`rest` 是可选字段，持久化那条路上没有写入方，
     走 seed 进来会被 load 丢掉（它是逐字段构造的）。这里测的是判断逻辑本身。 */
  const w = withPlan(makeWorld(seedStaying()));
  w.st = { ...w.st, rest: { dateKey: '2026-10-31', from: 0, reason: '走累了' } };
  assert.equal(w.onWayNow(), null);
});

test('没有作息表就不报 —— 不能凭空说「在路上」', () => {
  const w = makeWorld(seedStaying());
  assert.equal(w.onWayNow(), null);
});

test('面板快照里能读到 onWay —— 别的扩展靠这个字段做「在路上」那一档', () => {
  const w = withPlan(makeWorld(seedStaying()));
  const snap = w.uiSnapshot();
  assert.ok('onWay' in snap, '快照里没有 onWay 字段');
  assert.ok(snap.onWay, `快照里 onWay 是空的：${JSON.stringify(snap.onWay)}`);
  assert.equal(snap.onWay.what, '打车去兵马俑');
  assert.equal(typeof snap.onWay.leftMin, 'number');
});
