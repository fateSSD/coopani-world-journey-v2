/**
 * 一键同步：把她的钟拉回到用户此刻。
 *
 * 背景是 2026-10-31 用户提的那个问题：「用户开了加速，鱼的时间和用户时间不一致怎么办」。
 * 加速本身是设计（双时间轴），但三件事会真的坏：天气冲出预报窗口、日记日期跑到未来、
 * 两个人的日历对不上。
 *
 * 这个按钮只解决「日期对不上」，**不动倍速** —— 那是设置里那个 1x 的事，
 * 两个动作混在一起，用户会不知道自己改了什么。
 *
 * 这里盯四件事：
 * 1. 点完差值归零；
 * 2. 倍速原样保留（想改速度去设置，不是按这个按钮）；
 * 3. 正在走的那一段**剩余时长不变**（平移，不是重排）；
 * 4. 两个日期键跟着挪 —— 不挪就会被当成「跨天」，白扣一晚房费还多推一条事件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

const REAL = Date.parse('2026-10-31T02:00:00Z');   // 北京 10:00

function fakeHost() {
  const events = [];
  return {
    events,
    log: { info() {}, warn() {} },
    pushEvent: async (e) => { const env = { ...e, blobs: [] }; events.push(env); return env; },
    pushDeferred: () => {},
    store: {},
    drainPendingEvents: async () => [],
  };
}

function seed(state) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-sync-'));
  new StateStore(dir).save({ ...initialState('lanzhou'), ...state });
  return dir;
}

/** 固定时刻：同步前后 `realNow()` 都是 `REAL`，差值才能算得准。 */
function makeWorld(dir, cfgOver = {}) {
  return new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', ...cfgOver },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(REAL),
  });
}

/** 世界时间相对真实时间偏移 `ms` 毫秒（可为负 = 落后）。**用毫秒不用整天数** —— 见日期键那条测试。 */
function clockSkew(ms, speed) {
  return {
    realEpoch: new Date(REAL).toISOString(),
    worldEpoch: new Date(REAL + ms).toISOString(),
    speed,
  };
}

/** 走一段正在进行的旅程：已走一小时，还剩两小时。 */
function travellingLeg(worldNowMs) {
  return {
    id: 'leg-1',
    fromId: 'lanzhou', toId: 'tianshui', modeId: 'train',
    km: 238, durationWorldHours: 3,
    departedAt: new Date(worldNowMs - 3_600_000).toISOString(),
    arriveAt: new Date(worldNowMs + 2 * 3_600_000).toISOString(),
    speed: 24, viaIds: [], createdAt: new Date(worldNowMs - 3_600_000).toISOString(),
  };
}

const DAYS_AHEAD = 5;
const WORLD_NOW = REAL + DAYS_AHEAD * 86_400_000;

test('同步：点完之后她的时间就是此刻', async () => {
  const dir = seed({
    phase: 'traveling',
    hereId: 'lanzhou',
    homeId: 'lanzhou',
    clock: clockSkew(DAYS_AHEAD * 86_400_000, 24),
    leg: travellingLeg(WORLD_NOW),
    tripStartedAt: new Date(WORLD_NOW - 2 * 86_400_000).toISOString(),
  });
  const world = makeWorld(dir);
  await world.start(fakeHost());

  // 同步前确实差着五天（不然这个测试什么都没测到）。
  assert.equal(world.uiSnapshot().clockDriftMs, DAYS_AHEAD * 86_400_000, '前置条件不成立');

  await world.panelInvoke('now', 'syncClock', []);

  const drift = world.uiSnapshot().clockDriftMs;
  assert.ok(Math.abs(drift) < 1000, `同步后还差 ${drift} 毫秒`);
});

test('同步：只对时间，不动倍速', async () => {
  // 「同步」和「改回正常速度」是两件事。混在一起用户会不知道自己改了什么。
  const dir = seed({
    phase: 'traveling',
    hereId: 'lanzhou',
    homeId: 'lanzhou',
    clock: clockSkew(DAYS_AHEAD * 86_400_000, 24),
    leg: travellingLeg(WORLD_NOW),
    tripStartedAt: new Date(WORLD_NOW - 2 * 86_400_000).toISOString(),
  });
  const world = makeWorld(dir);
  await world.start(fakeHost());

  await world.panelInvoke('now', 'syncClock', []);

  assert.equal(world.st.clock.speed, 24, '同步把倍速改掉了');
});

test('同步：正在走的那一段剩余时长不变', async () => {
  // 平移整段时间轴，不是重排行程 —— 否则她会「瞬移」到离目的地更近或更远的地方。
  const dir = seed({
    phase: 'traveling',
    hereId: 'lanzhou',
    homeId: 'lanzhou',
    clock: clockSkew(DAYS_AHEAD * 86_400_000, 24),
    leg: travellingLeg(WORLD_NOW),
    tripStartedAt: new Date(WORLD_NOW - 2 * 86_400_000).toISOString(),
  });
  const world = makeWorld(dir);
  await world.start(fakeHost());
  const span = (l) => Date.parse(l.arriveAt) - Date.parse(l.departedAt);
  const before = span(world.st.leg);

  await world.panelInvoke('now', 'syncClock', []);

  assert.equal(span(world.st.leg), before, '这一段的时长被改了');
  // 到站时刻也必须跟着挪，否则进度条会跳。
  assert.equal(
    Date.parse(world.st.leg.arriveAt) - REAL,
    2 * 3_600_000,
    '到站时刻没跟着平移',
  );
});

test('同步：两个日期键按新时钟重算，不会被当成跨天', async () => {
  // 不挪的话 `stayTick` 会判定「跨天」：重扣一晚房费，再推一条「第 N 天」。
  // 钱和事件都是真的，所以这条必须守住。
  //
  // **偏移故意带 30 秒零头。** 早先的实现是拿日期字符串「减几天」，
  // 整三天的偏移算得对，一带零头就落到前一天（10-31 减 72 小时零 30 秒 = 10-27T23:59:30），
  // 于是看上去像凭空跳了一天。整天的偏移测不出这个错，所以这里必须带零头。
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('测试里不联网'); };
  try {
    const skew = 3 * 86_400_000 + 30_000;
    const dir = seed({
      phase: 'staying',
      hereId: 'tianshui',
      homeId: 'lanzhou',
      clock: clockSkew(skew, 4),
      stayStartedAt: new Date(REAL + skew - 86_400_000).toISOString(),
      stayDateKey: '2026-11-03',        // 她那边现在是 11 月 3 日
      decidedOn: '2026-11-03',
      tripStartedAt: new Date(REAL + skew - 2 * 86_400_000).toISOString(),
    });
    const world = makeWorld(dir, { speed: 4 });
    await world.start(fakeHost());

    await world.panelInvoke('now', 'syncClock', []);

    const snap = world.uiSnapshot();
    assert.equal(world.st.stayDateKey, snap.dateKey, `跨天判断会对不上：状态里 ${world.st.stayDateKey}，实际 ${snap.dateKey}`);
    assert.equal(world.st.decidedOn, snap.dateKey, '「今天走不走」会被重复决策');
  } finally { globalThis.fetch = origFetch; }
});

test('同步：1x 下不再额外拉一遍（本来就没差）', async () => {
  // 1x 且已经对齐时点按钮，不该有任何动作 —— 一秒以内的抖动不值得平移整段状态。
  const dir = seed({
    phase: 'traveling',
    hereId: 'lanzhou',
    homeId: 'lanzhou',
    clock: { realEpoch: new Date(REAL).toISOString(), worldEpoch: new Date(REAL).toISOString(), speed: 1 },
    leg: travellingLeg(REAL),
    tripStartedAt: new Date(REAL - 86_400_000).toISOString(),
  });
  const world = makeWorld(dir);
  await world.start(fakeHost());
  const before = JSON.stringify(world.st.leg);

  await world.panelInvoke('now', 'syncClock', []);

  assert.equal(JSON.stringify(world.st.leg), before, '没差也动了行程');
});

test('自动对齐仍然回 1x（同步按钮不改变这条老规则）', async () => {
  // `alignToReal` 第三个参数默认还是 1：`ensureClock` 那条自动路径靠它。
  // 加了按钮之后默认值被顺手改成「保留倍速」的话，1x 自动纠正就失效了。
  const dir = seed({
    phase: 'traveling',
    hereId: 'lanzhou',
    homeId: 'lanzhou',
    clock: clockSkew(DAYS_AHEAD * 86_400_000, 1),
    leg: travellingLeg(WORLD_NOW),
    tripStartedAt: new Date(WORLD_NOW - 2 * 86_400_000).toISOString(),
  });
  const world = makeWorld(dir);
  await world.start(fakeHost());

  world.alignToReal(new Date(REAL), world.uiSnapshot().clockDriftMs);

  assert.equal(world.st.clock.speed, 1, '自动对齐没回到 1x');
});

test('同步：她的钟落后时也能拉齐（不是只能往前拉）', async () => {
  // 落后不是假想：1x 下系统时钟被往回调过，或者从高倍速切下来时自动对齐没触发。
  // 这时 shift 是正的，「平移」和「重置」的区别一样成立 —— 符号写反就会把行程推到未来。
  const dir = seed({
    phase: 'traveling',
    hereId: 'lanzhou',
    homeId: 'lanzhou',
    clock: clockSkew(-2 * 86_400_000, 1),
    leg: travellingLeg(REAL - 2 * 86_400_000),
    tripStartedAt: new Date(REAL - 3 * 86_400_000).toISOString(),
  });
  const world = makeWorld(dir);
  await world.start(fakeHost());
  assert.ok(world.uiSnapshot().clockDriftMs < 0, '前置条件不成立：这不叫落后');

  const span = (l) => Date.parse(l.arriveAt) - Date.parse(l.departedAt);
  const before = span(world.st.leg);

  await world.panelInvoke('now', 'syncClock', []);

  const after = world.uiSnapshot();
  assert.ok(Math.abs(after.clockDriftMs) < 1000, `落后时没拉齐，还差 ${after.clockDriftMs}`);
  assert.equal(span(world.st.leg), before, '落后时平移把这一段的时长改了');
});

test('倍速：负数或零一律当 1，不许把世界调成龟速', async () => {
  // 2026-11-01 Mr.Q 截图：配置里填进了 -42。
  // 旧代码用 Math.max(0.1, speed) 兜底 —— 世界不会倒流，但会变成 0.1x 龟速，
  // 一天只走十分之一天。那既不是他要的，也不该由代码替他决定。
  const dir = seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou' });
  for (const bad of [-42, 0, 'abc']) {
    const world = makeWorld(dir, { speed: bad });
    await world.start(fakeHost());
    assert.equal(world.uiSnapshot().speed, 1, `倍速 ${bad} 没被纠正成 1`);
  }
  // 极端大的值也要压住：巡检最短 3 秒，240x 以上就成片跨过作息节点了
  const big = makeWorld(dir, { speed: 99999 });
  await big.start(fakeHost());
  assert.equal(big.uiSnapshot().speed, 240, '上限没压住');
});
