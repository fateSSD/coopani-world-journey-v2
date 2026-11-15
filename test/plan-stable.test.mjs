/**
 * 同一天的计划表必须可重建、已发生的部分不许被改写（2026-11-07）
 *
 * ## 起因
 *
 * Mr.Q 的两张截图，同一时段、同一件事，内容却不一样：
 *
 * ```
 * 14:15  骑共享单车去锦里
 * 14:15  扫了辆电瓶车去锦里
 * ```
 *
 * 根因不是「推重了」，是 **plan 不可重建**：
 *
 * - `planDay` 的随机源是 `Math.random`（`inCityMode` 用它挑交通方式）；
 * - 单车 6 分钟/公里、电瓶车 4 分钟/公里 —— 挑中哪个，`beat.at` 也跟着变；
 * - plan 只活在内存里，Core 一重启就重建，**每次重建都重新掷骰子**；
 * - 于是同一件事既换了车，又因为 `at` 变了骗过 `lastBeatKey` 那道去重，推了第二遍。
 *
 * 更深一层：**已经发生过的事被改写了**。她 13:00 骑的是单车，14:00 重建后
 * 变成「14:15 扫电瓶车去的」—— 那不是重复通知，是篡改昨天。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { planDay } = await import('../src/plan/dayplan.ts');
const { CITIES, cityById } = await import('../src/geo/cities.ts');
const { rollLodging } = await import('../src/plan/lodging.ts');

/** 一个确定性的假随机源。同种子 → 同序列。 */
function lcg(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

const plan = (city, rnd, over = {}) => planDay({
  city, dateKey: '2026-11-07', shape: 'full',
  lodging: rollLodging(lcg(7)), rnd, ...over,
});

test('同一个随机源 → 同一张表（逐条一致，含通勤方式与时刻）', () => {
  const c = cityById('chengdu');
  const a = plan(c, lcg(42));
  const b = plan(c, lcg(42));
  assert.deepEqual(a.beats, b.beats, '同种子排出来的表不一样 —— planDay 还有别的不确定来源');
});

test('随机源不同 → 通勤方式可能不同（说明这个测试真能抓到东西）', () => {
  /*
   * 如果这条不成立，上面那条就是空过 —— 说明 `rnd` 根本没被用到。
   */
  const c = cityById('chengdu');
  const verbs = new Set();
  for (let s = 1; s <= 40; s++) {
    const p = plan(c, lcg(s));
    for (const b of p.beats) {
      if (b.kind === 'commute') verbs.add(b.what.slice(0, 6));
    }
  }
  assert.ok(verbs.size >= 2, `四十个种子只排出一种通勤方式，这条测试抓不到东西：${[...verbs]}`);
});

test('表里确实有「城内交通」这一类节点（不然上面两条测的是空气）', () => {
  const c = cityById('chengdu');
  const p = plan(c, lcg(42));
  const commute = p.beats.filter((b) => b.kind === 'commute');
  assert.ok(commute.length > 0, `成都一天里没有通勤节点，这条测试要换个城市：${p.beats.map((b) => b.kind)}`);
});

test('world 里调用 planDay 必须传种子随机 —— 否则每次重建都换车', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { JourneyWorld } = await import('../src/world.ts');
  const { JOURNEY_DEFAULTS } = await import('../src/config.ts');

  const now = new Date('2026-11-07T02:00:00Z');
  const makeWorld = () => {
    const dir = mkdtempSync(join(tmpdir(), 'jr-plan-seed-'));
    const w = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => now,
    });
    w.st = {
      ...w.st,
      phase: 'staying',
      hereId: 'chengdu',
      stayStartedAt: '2026-11-06T02:00:00Z',
      stayDateKey: '2026-11-07',
    };
    return w;
  };
  const w1 = makeWorld();
  const w2 = makeWorld();
  await w1.rebuildPlan(now);
  await w2.rebuildPlan(now);
  assert.deepEqual(w1.plan?.beats, w2.plan?.beats, '同状态两次 rebuildPlan 排出来的表不一样（通勤方式或时刻漂移）');
});

test('world 重建计划时保留已推出的那一段', async () => {
  /*
   * 种子随机让「同参数重建」幂等，但参数会变（钱紧、换酒店、shape）。
   * 那些变化只该影响还没发生的事 —— 已经说过的话不能被改写。
   */
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { JourneyWorld } = await import('../src/world.ts');
  const { JOURNEY_DEFAULTS } = await import('../src/config.ts');

  const now = new Date('2026-11-07T05:00:00Z'); // 成都 13:00
  const dir = mkdtempSync(join(tmpdir(), 'jr-plan-keep-'));
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => now,
  });
  w.st = {
    ...w.st,
    phase: 'staying',
    hereId: 'chengdu',
    stayStartedAt: '2026-11-06T02:00:00Z',
    stayDateKey: '2026-11-07',
  };
  await w.rebuildPlan(now);
  // 假设午饭（12.5）已经推出去了，且早餐那句当时是特定内容
  w.plan.beats[0] = { ...w.plan.beats[0], what: '早饭，已经说出口的那碗抄手' };
  w.st = { ...w.st, lastBeatKey: '2026-11-07|lunch|12.5' };
  await w.rebuildPlan(now);
  assert.equal(w.plan.beats[0].what, '早饭，已经说出口的那碗抄手', '已经推出去的早饭在 rebuildPlan 时被改写了');
});

test('lastPushedAt 的解析与 advanceBeats 写的 key 对得上', async () => {
  /*
   * 这一对我们抓过一次：`advanceBeats` 拼的是 `${dateKey}|${kind}|${at}`，
   * 如果哪天那边改了顺序，这里解析出来的就是垃圾 —— 而且不会报错，
   * 只会让「保留已推段」静默失效。
   */
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { JourneyWorld } = await import('../src/world.ts');
  const { JOURNEY_DEFAULTS } = await import('../src/config.ts');

  const now = new Date('2026-11-07T05:00:00Z');
  const dir = mkdtempSync(join(tmpdir(), 'jr-pushed-at-'));
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => now,
  });
  w.host = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pushEvent: async () => {},
  };
  w.plan = {
    sunriseHour: 7,
    lodging: { price: 180, feel: '' },
    beats: [
      { kind: 'breakfast', at: 8.5, what: '早饭，肥肠粉' },
      { kind: 'lunch', at: 12.5, what: '午饭，担担面' },
    ],
  };
  await w.advanceBeats(now, cityById('chengdu'), 13.0, '2026-11-07');
  assert.equal(w.lastPushedAt('2026-11-07'), 12.5, `advanceBeats 写下的 key (${w.st.lastBeatKey}) 被 lastPushedAt 解析错了`);
  assert.equal(w.lastPushedAt('2026-11-08'), null, '不同日期的 key 不该命中');
});
