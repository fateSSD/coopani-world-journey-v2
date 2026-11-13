/**
 * 「怎么回家的」要分得清（2026-11-04，0.5.32）
 *
 * 群里一条反馈：「『回家』和『被上限撵回家』得分得清，不然写日记的时候情绪是错的」。
 *
 * 查下来实际有四种，比反馈里说的还多两种：
 *   自己待够了 / 到出门上限 / 钱撑不下去（打了太多次工还是不够）/ 他叫她回来
 *
 * 原来只在事件正文里分两种（`forced` 真 / 假），而那句话**只活在推送的那一刻** ——
 * `journey_now` 不提，`{{journey.now}}` 不提，她晚上写日记时手上什么都没有，
 * 于是四种收场被写成同一种情绪：「这一趟结束了，有点舍不得」。
 *
 * 这里盯的是一条链：`goHome(reason)` → 状态里存下来 → 事件正文和「她现在怎么样」**说同一件事**。
 * 只测其中一处的话，另外两处会悄悄漂回旧口径（技能里叫「同一件事实有几条出口」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');
const { cityById } = await import('../src/geo/cities.ts');

/** 桩要像个真 Logger：宿主接口有五个方法，少一个会在 warn 那条路上抛。 */
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
 * 她停在天水（离兰州不到 500 公里，`goHome` 会一趟到家）。
 * `decidedOn` 填成当天，避开早上那个「今天走不走」的决策块。
 */
async function startWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'jr-homer-'));
  new StateStore(dir).save({
    ...initialState('lanzhou'),
    phase: 'staying',
    hereId: 'tianshui',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-03T00:00:00Z',
    decidedOn: '2026-11-04',
  });
  const events = [];
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-04T04:00:00Z'),
  });
  await world.start(fakeHost(events));
  return { world, events };
}

const CASES = [
  { reason: 'done', label: '自己待够了', event: /待够了/, now: /待够了/ },
  { reason: 'limit', label: '到出门上限', event: /上限/, now: /上限/ },
  { reason: 'broke', label: '钱撑不下去', event: /短工/, now: /钱撑不下去/ },
  { reason: 'called', label: '他叫回来', event: /叫(她|你)回来/, now: /叫(她|你)回来/ },
];

for (const c of CASES) {
  test(`回家原因「${c.label}」：状态、事件、她现在怎么样，三处说同一件事`, async () => {
    const { world, events } = await startWorld();
    try {
      await world.goHome(new Date('2026-11-04T04:00:00Z'), cityById('tianshui'), c.reason);

      // 一行状态：日记、面板、以后再判断「要不要马上出门」都读它。
      assert.equal(world.st.homeReason, c.reason, `状态里没记下原因（读到 ${world.st.homeReason}）`);
      assert.equal(world.st.returnReason, null, '回程走完，那笔临时原因该清掉');
      assert.equal(world.st.phase, 'home');

      const home = events.filter((e) => e.type === 'journey.home');
      assert.equal(home.length, 1, `推了 ${home.length} 条回家事件`);
      assert.match(String(home[0].text), c.event, `事件正文没写清是哪一种：${home[0].text}`);

      // `{{journey.now}}` 和 `journey_now` 都是这一个方法 —— 它不提，她就读不到。
      const now = world.nowSummary();
      assert.match(String(now), c.now, `「她现在怎么样」里没提这一种：${now}`);
    } finally { world.stop?.(); }
  });
}

test('回程不是传送：走到家那天，原因要沿用几天前定下的那一笔', async () => {
  /*
   * 这条是四种之外最容易漏的一层。
   *
   * 他按「回来吧」之后，她要走好几天才到家 —— 走到家那一刻调用的是
   * `goHome(returnReason)`。如果只按「此刻是什么原因」填，回程一律变成
   * `done`（自己待够了）；而「他叫我回来的」这条最需要记住的，恰好丢了。
   */
  const { world, events } = await startWorld();
  try {
    world.st = { ...world.st, returnReason: 'called' };
    // 走到家：模拟 returning 那条分支最终落下来的调用
    await world.goHome(new Date('2026-11-04T04:00:00Z'), cityById('tianshui'), world.st.returnReason ?? 'done');
    assert.equal(world.st.homeReason, 'called', '回程走完把「他叫回来的」写成了别的');
    const home = events.filter((e) => e.type === 'journey.home');
    assert.match(String(home[0].text), /叫(她|你)回来/, `事件正文不对：${home[0].text}`);
  } finally { world.stop?.(); }
});

test('老状态里没有这个字段：读成「不知道」，不是「待够了」', async () => {
  /*
   * 升级前存下的 state.json 不会有 `homeReason`。
   * 读成一个默认值（尤其是 `done`）等于替她编了一段「我自己想回来了」。
   */
  const dir = mkdtempSync(join(tmpdir(), 'jr-homer-legacy-'));
  new StateStore(dir).save({
    ...initialState('lanzhou'),
    phase: 'home',
    hereId: 'lanzhou',
  });
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-04T04:00:00Z'),
  });
  await world.start(fakeHost([]));
  try {
    assert.equal(world.st.homeReason, null, '老状态读出了一个编的原因');
    const now = world.nowSummary();
    assert.doesNotMatch(String(now), /待够/, `「不知道」被写成了「待够了」：${now}`);
    assert.doesNotMatch(String(now), /上限/, `「不知道」被写成了「到上限」：${now}`);
  } finally { world.stop?.(); }
});

test('钱花光又在外地：回程不许躺平，一定动身往家走', async () => {
  /*
   * 2026-11-05 goto 档跑出来的原样，持续 143 个世界天：
   *
   *   phase=staying here=bangkok returning=true  spent 6000→三万八
   *
   * 链条是这样断的：钱空了 → `goHome('broke')` → 直达票买不起 → `returning=true`
   * → `moveOn` 朝家挑下一站，可 `purseRangeKm()` 在「空了」时只给两百公里
   * → 曼谷周边没有候选 → 原地不动；第二天早上又走一遍回程分支，还是不动。
   * 而 `returning` 排在所有决策之前，所以她连「去打工挣点钱」都轮不到 ——
   * **既回不去，也走不了，还不能挣**，只有 `journey.day` 一天天往外推。
   *
   * 修法两条：回家路上不受「只够走近处」的限制；这一对上真能走的方式里，
   * 最便宜的那种永远放行（欠一张票，到家结清）。
   */
  const dir = mkdtempSync(join(tmpdir(), 'jr-homer-'));
  new StateStore(dir).save({
    ...initialState('lanzhou'),
    phase: 'staying',
    hereId: 'bangkok',
    tripStartedAt: '2026-10-20T00:00:00Z',
    stayStartedAt: '2026-10-25T00:00:00Z',
    stayDateKey: '2026-11-05',
    returning: true,
    returnReason: 'broke',
    spent: 7000,          // 预算 6000，早超了
    workStints: 4,
  });
  const events = [];
  let clock = new Date('2026-11-05T00:30:00Z');   // 曼谷当地 07:30
  const world = new JourneyWorld({
    cfg: {
      ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', speed: 1,
      moneyEnabled: true, budget: 6000,
    },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => clock,
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  await world.start(fakeHost(events));
  try {
    for (let i = 0; i < 144; i++) {         // 72 小时，每半小时一巡检（48 小时偶尔不够：挑站/票钱要试两轮）
      clock = new Date(clock.getTime() + 1_800_000);
      await world.tick();
    }
    const depart = events.filter((e) => e.type === 'journey.depart');
    assert.ok(depart.length >= 1, `两天一步没动，还卡在${world.st.hereId}`);
    assert.equal(world.st.returning, true, '回程标志被弄丢了');
    /*
     * 只断言「她不在曼谷躺着了」—— 不断言「已经到过一站」。
     * 两千五百公里坐大巴要走四十多个小时，48 小时窗口里可能还在路上，
     * 那不是 bug（第一版这么写，三条里挂一条）。
     */
    const moved = world.st.phase !== 'staying' || world.st.hereId !== 'bangkok';
    assert.ok(moved, '还在曼谷躺着');
    if (world.st.phase === 'traveling') {
      assert.notEqual(world.st.leg?.toId, 'bangkok', '出发了却把曼谷当成目的地');
    }
  } finally {
    globalThis.fetch = origFetch;
    world.stop?.();
  }
});
