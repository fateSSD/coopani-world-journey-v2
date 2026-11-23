/**
 * 生理需求优先 + 双扩展日程协同测试（2026-11-23）。
 *
 * 覆盖：
 * 1. 洗澡占用 08:52–09:22 时，09:00 坐公交自动顺延到 09:27，不推送「边洗澡边坐公交」，且连续 tick 幂等；
 * 2. 生理需求 < 30（饱腹/清爽/精力）未处理时阶梯顺延，超过正餐边界则取消该波出门；
 * 3. 睡到 10:30 跳过清晨日出并顺延上午出门；
 * 4. 在景点区间内于生活层开启洗漱/睡眠，立即截断当前景点区间并清掉未推中段插话；
 * 5. 已推出节点（<= lastPushedAt）绝对不动；
 * 6. 生活层刚吃饱时不重复叠加饭点 food；
 * 7. 正在洗澡等独占动作时暂缓跨城出发决策且不占当日额度。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { adjustPlanForLife } = await import('../src/world-plan.ts');
const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');
const { cityById } = await import('../src/geo/cities.ts');

function fakeHost() {
  return {
    events: [],
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => ({ ...e, blobs: [] }),
    pushDeferred: () => {},
    store: {},
    drainPendingEvents: async () => [],
  };
}

function makeBasePlan() {
  return {
    dateKey: '2026-11-23',
    cityId: 'jiayuguan',
    sunriseHour: 6.5,
    sunsetHour: 18.0,
    shape: 'full',
    nightOption: null,
    weather: null,
    lodging: { tier: 'view', kind: '酒店', price: 200, feel: '' },
    commute: { trips: 2, price: 4, modes: ['公交'] },
    extras: { items: [], price: 0 },
    neighbors: [],
    pool: 0,
    invites: [],
    beats: [
      { at: 6.25, kind: 'sunrise', what: '日出' },
      { at: 7.0, kind: 'wake', what: '起床' },
      { at: 7.5, kind: 'breakfast', what: '早饭，牛肉面' },
      { at: 9.0, kind: 'commute', what: '坐公交去高处视野开的那一段' },
      { at: 9.5, kind: 'activity', what: '高处视野开的那一段', spot: '高处视野开的那一段', until: 11.5 },
      { at: 10.75, kind: 'activity', what: '还在高处视野开的那一段，走了这么久才转过一半', spot: '高处视野开的那一段' },
      { at: 12.5, kind: 'lunch', what: '午饭，烤羊肉串' },
      { at: 14.0, kind: 'commute', what: '坐公交去卖大盘鸡的土特产店' },
      { at: 14.5, kind: 'activity', what: '卖大盘鸡的土特产店', spot: '卖大盘鸡的土特产店', until: 17.0 },
      { at: 18.5, kind: 'dinner', what: '晚饭，大盘鸡' },
    ],
  };
}

test('adjustPlanForLife：正在洗澡到 09:22，09:00 坐公交顺延到 09:27 且幂等', () => {
  const plan = makeBasePlan();
  const r1 = adjustPlanForLife(plan, {
    localNow: 9.0,
    pushedAt: 7.5,
    busyUntilHour: 9 + 22 / 60,
    busyActId: 'wash',
    isHotelAct: true,
    needsCare: false,
  });
  assert.equal(r1.changed, true);
  const commute1 = r1.plan.beats.find((b) => b.what.includes('高处视野开的那一段') && b.kind === 'commute');
  const act1 = r1.plan.beats.find((b) => b.kind === 'activity' && b.until !== undefined && b.spot === '高处视野开的那一段');
  assert.ok(commute1 && Math.abs(commute1.at - (9 + 27 / 60)) < 0.02, `应顺延到 09:27，实际 ${commute1?.at}`);
  assert.ok(act1 && Math.abs(act1.at - (9 + 57 / 60)) < 0.02, `景点应顺延到 09:57，实际 ${act1?.at}`);

  /* 已推早饭 (7.5) 绝对不改 */
  const bf = r1.plan.beats.find((b) => b.kind === 'breakfast');
  assert.equal(bf?.at, 7.5);

  /* 再跑一轮（09:01），必须幂等不再漂移 */
  const r2 = adjustPlanForLife(r1.plan, {
    localNow: 9 + 1 / 60,
    pushedAt: 7.5,
    busyUntilHour: 9 + 22 / 60,
    busyActId: 'wash',
    isHotelAct: true,
    needsCare: false,
  });
  assert.equal(r2.changed, false, '同一占用窗口下第二轮应幂等不动');
});

test('adjustPlanForLife：生理需求低未处理时阶梯顺延，越过午饭边界自动取消上午段', () => {
  const plan = makeBasePlan();
  const r1 = adjustPlanForLife(plan, {
    localNow: 8.85,
    pushedAt: 7.5,
    busyUntilHour: null,
    needsCare: true,
  });
  assert.equal(r1.changed, true);
  const c1 = r1.plan.beats.find((b) => b.kind === 'commute' && b.what.includes('高处'));
  assert.ok(c1 && c1.at >= 9.45 && c1.at <= 9.6, `应顺延约 30 分钟到 09:30 左右，实际 ${c1?.at}`);

  /* 若拖到 11:50 还不满足，顺延后进景点已在 12:30 午饭边上（不足半小时），应取消上午那波，保留下午段 */
  const r2 = adjustPlanForLife(plan, {
    localNow: 11.85,
    pushedAt: 7.5,
    busyUntilHour: null,
    needsCare: true,
  });
  assert.equal(r2.changed, true);
  assert.equal(r2.plan.beats.some((b) => b.spot === '高处视野开的那一段'), false, '上午逛不成应取消');
  assert.equal(r2.plan.beats.some((b) => b.spot === '卖大盘鸡的土特产店'), true, '下午段仍保留');
});

test('adjustPlanForLife：睡到 10:30 时略过日出并顺延上午出门；景点内开启洗澡立即截断景点', () => {
  const plan = makeBasePlan();
  const rSleep = adjustPlanForLife(plan, {
    localNow: 8.0,
    pushedAt: null,
    busyUntilHour: 10.5,
    busyActId: 'sleep',
    isHotelAct: true,
    needsCare: false,
  });
  assert.equal(rSleep.changed, true);
  assert.equal(rSleep.plan.beats.some((b) => b.kind === 'sunrise'), false, '睡到 10:30 应略过清晨日出');
  const c = rSleep.plan.beats.find((b) => b.kind === 'commute' && b.what.includes('高处'));
  assert.ok(c && c.at > 10.5, `坐公交应顺延到醒来之后，实际 ${c?.at}`);

  /* 人在景点 09:30–11:30 期间的 10:00 开启洗澡，立即截断该景点并清掉 10:45 中段话 */
  const rBath = adjustPlanForLife(makeBasePlan(), {
    localNow: 10.0,
    pushedAt: 9.5,
    busyUntilHour: 10.5,
    busyActId: 'wash',
    isHotelAct: true,
    needsCare: false,
  });
  assert.equal(rBath.changed, true);
  const spotAct = rBath.plan.beats.find((b) => b.kind === 'activity' && b.until !== undefined && b.spot === '高处视野开的那一段');
  assert.ok(spotAct && spotAct.until <= 10.05, `景点应被截断到当前时刻，实际 until=${spotAct?.until}`);
  assert.equal(rBath.plan.beats.some((b) => b.at === 10.75), false, '未推的中段话应移除');
});

test('端到端 stayTick：洗澡期间不推 09:00 公交、journey-public 同步释放、且暂缓发车不占 decidedOn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-sync-life-'));
  try {
    // 当地 09:00（UTC+8 → 01:00Z）
    const now = new Date('2026-11-23T01:00:00Z');
    new StateStore(dir).save({
      ...initialState('lanzhou'),
      phase: 'staying',
      hereId: 'jiayuguan',
      homeId: 'lanzhou',
      stayStartedAt: '2026-11-15T01:00:00Z', // 待够了，本来 8 点后就会发车决策
      stayDateKey: '2026-11-23',
      lastBeatKey: '2026-11-23|breakfast|7.5',
      decidedOn: null,
    });
    writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
      schema: 2,
      asleepUntil: '',
      updatedAt: now.toISOString(),
      vitals: { food: 70, energy: 85, clean: 10, fun: 60, social: 60, fitness: 25 },
      activity: {
        id: 'wash',
        kind: 'act',
        label: '洗澡',
        from: '2026-11-23T00:52:00Z',
        until: '2026-11-23T01:22:00Z',
        occupiesPlace: true,
      },
    }));

    const w = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => now,
    });
    await w.start(fakeHost());
    w.plan = makeBasePlan();
    await w.stayTick(now);

    assert.equal(w.st.phase, 'staying', '洗澡时不应发车离开城市');
    assert.equal(w.st.decidedOn ?? null, null, '洗澡暂缓发车不应占掉今日决策额度');
    assert.equal(w.onWayNow(), null, '洗澡到 09:22，09:00 不该处于坐公交状态');
    assert.notEqual(w.st.lastBeatKey, '2026-11-23|commute|9', '09:00 公交不该被推进');

    const pub = JSON.parse(readFileSync(join(dir, 'journey-public.json'), 'utf8'));
    assert.equal(pub.onWay, null, 'journey-public.json 里 onWay 应为 null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('advanceBeats：生活层已吃饱（food >= 88）时，旅途正餐不再重复叠加 food', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-sync-food-'));
  try {
    const now = new Date('2026-11-23T04:30:00Z');
    writeFileSync(join(dir, 'life-state.json'), '{}');
    writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
      schema: 2,
      updatedAt: now.toISOString(),
      vitals: { food: 95, energy: 85, clean: 85, fun: 80, social: 60, fitness: 25 },
    }));
    const w = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => now,
    });
    await w.start(fakeHost());
    w.st = { ...w.st, phase: 'staying', hereId: 'jiayuguan', stayDateKey: '2026-11-23', lastBeatKey: null };
    w.plan = makeBasePlan();
    await w.advanceBeats(now, cityById('jiayuguan'), 12.6, '2026-11-23');

    const spendDir = join(dir, 'life-spend');
    const files = (await import('node:fs')).readdirSync(spendDir).filter((n) => n.endsWith('.json'));
    assert.equal(files.length, 1);
    const ticket = JSON.parse(readFileSync(join(spendDir, files[0]), 'utf8'));
    assert.equal(ticket.vitalsDelta.food, undefined, '已吃饱时不该重复叠 food');
    assert.ok(ticket.vitalsDelta.social > 0, '社交反哺仍保留');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('needsCare 连拍稳定锚点：只顺延一次，不无限往后漂移吃掉景点', () => {
  let cur = makeBasePlan();
  const r1 = adjustPlanForLife(cur, {
    localNow: 8.85,
    pushedAt: 7.5,
    busyUntilHour: null,
    needsCare: true,
  });
  assert.equal(r1.changed, true);
  cur = r1.plan;

  for (const t of [9.0, 9.25, 9.45, 9.65]) {
    const rn = adjustPlanForLife(cur, {
      localNow: t,
      pushedAt: 7.5,
      busyUntilHour: null,
      needsCare: true,
    });
    assert.equal(rn.changed, false, `localNow=${t} 时不应再连续顺延漂移`);
    assert.equal(
      rn.plan.beats.some((b) => b.spot === '高处视野开的那一段'),
      true,
      `localNow=${t} 时上午景点不应被漂移删掉`,
    );
  }
});

test('跨夜睡眠不把早上起床挪到 23:57；打工期间屏蔽 atSpotNow 与 onWayNow', async () => {
  const sleepRes = adjustPlanForLife(makeBasePlan(), {
    localNow: 22.0,
    pushedAt: null,
    busyUntilHour: 23.95,
    busyActId: 'sleep',
    isHotelAct: true,
    needsCare: false,
  });
  const wake = sleepRes.plan.beats.find((b) => b.kind === 'wake');
  assert.equal(wake?.at, 7.0, '夜里跨夜睡觉不得把早上起床推到 23:57');
  assert.equal(sleepRes.plan.beats.some((b) => b.kind === 'sunrise'), true, '夜间入睡不应删除当日日出记录');

  // 打工期间不报景点/通勤
  const dir = mkdtempSync(join(tmpdir(), 'jr-work-spot-'));
  try {
    const now = new Date('2026-11-23T01:45:00Z'); // 当地 09:45（正好在原本 09:30-11:30 景点内）
    new StateStore(dir).save({
      ...initialState('lanzhou'),
      phase: 'staying',
      hereId: 'jiayuguan',
      stayDateKey: '2026-11-23',
      work: { cityId: 'jiayuguan', startedOn: '2026-11-23', until: '2026-11-25T00:00:00Z', pay: 150, gig: '面馆后厨' },
    });
    const w = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => now,
    });
    await w.start(fakeHost());
    w.plan = makeBasePlan();
    assert.equal(w.atSpotNow(), null, '打工期间不得误判还在景区逛');

    const wayW = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => new Date('2026-11-23T01:10:00Z'), // 当地 09:10（原本 09:00-09:30 公交区间）
    });
    await wayW.start(fakeHost());
    wayW.plan = makeBasePlan();
    assert.equal(wayW.onWayNow(), null, '打工期间不得误判正在坐公交去景区');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('删景点必须推送 journey.plan 事件说明原因（不含第三人称她）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-plan-drop-'));
  try {
    const now = new Date('2026-11-23T03:50:00Z'); // 当地 11:50（午饭 12:30 前来不及再去上午景点）
    new StateStore(dir).save({
      ...initialState('lanzhou'),
      phase: 'staying',
      hereId: 'jiayuguan',
      stayDateKey: '2026-11-23',
      lastBeatKey: '2026-11-23|breakfast|7.5',
    });
    writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
      schema: 2,
      updatedAt: now.toISOString(),
      vitals: { food: 12, energy: 80, clean: 80, fun: 80, social: 60, fitness: 25 },
    }));
    const pushed = [];
    const w = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => now,
    });
    await w.start({
      ...fakeHost(),
      pushEvent: async (e) => { pushed.push(e); return { ...e, blobs: [] }; },
    });
    pushed.length = 0; // 清掉 start() 内部 rebuildPlan 顺带检查产生的首轮事件
    w.plan = makeBasePlan();
    await w.syncPlanWithLife(now, cityById('jiayuguan'));

    const dropEv = pushed.find((e) => e.type === 'journey.plan');
    assert.ok(dropEv, '取消景点时必须推送 journey.plan 事件通知');
    assert.match(String(dropEv.text), /高处视野开的那一段/);
    assert.equal(String(dropEv.text).includes('她'), false, '事件正文禁止出现第三人称「她」');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

