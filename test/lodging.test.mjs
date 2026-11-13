/**
 * 换酒店 —— `journey_lodging`（2026-11-05）
 *
 * 起因是一句转发：用户让自己的鱼改酒店，鱼去翻底层代码，回话说「完全没找到」。
 *
 * 它没找错。原来只有一条路能换房：**记账开着、钱紧了，日切时把 plan 清掉重掷**。
 * 没开记账的人 `isTight()` 恒为 false，那条路永远不触发 —— 于是「让鱼换个酒店」
 * 在机制上是不可能的事，而不是鱼不肯。
 *
 * Mr.Q 的要求是「两种模式都打开」：记账开、记账关，用户开口就能换。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');
const { rerollLodging, rollLodging } = await import('../src/plan/lodging.ts');

/* ---------------- 掷房：只测这一件事 ---------------- */

/** 固定随机源，结果可复现。 */
const seq = (seed = 1) => {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
};

test('换房：一定换到另一家，不会掷回同一间', () => {
  /*
   * 这条是根。掷回同一间房，等于让用户白说一遍 ——
   * 而且他还会以为功能坏了。
   */
  const start = { tier: 'budget', kind: '快捷连锁', price: 220, feel: '' };
  const rnd = seq(7);
  for (let i = 0; i < 60; i++) {
    const next = rerollLodging(start, rnd, false, 1, 'any');
    assert.notEqual(next.kind, start.kind, `第 ${i} 次换回了同一间「${next.kind}」`);
  }
});

test('换房：说「便宜点」就往便宜走，不许往上跳', () => {
  const view = { tier: 'view', kind: '山景房', price: 680, feel: '' };
  const rnd = seq(3);
  for (let i = 0; i < 30; i++) {
    const next = rerollLodging(view, rnd, false, 1, 'cheaper');
    assert.ok(next.price < view.price, `要便宜却换到了 ${next.price} 块（原来 ${view.price}）`);
    assert.equal(next.tier, 'budget', '要便宜却留在了景观房');
  }

  /*
   * 已经是最便宜的那一档时，**不能为了「换」而涨价**。
   * 用户说「换便宜点」，结果换到更贵的房，比不换更糟。
   */
  const cheapest = { tier: 'budget', kind: '老式招待所', price: 130, feel: '' };
  for (let i = 0; i < 30; i++) {
    const next = rerollLodging(cheapest, rnd, false, 1, 'cheaper');
    /*
     * 到底了就该**原样返回**，而不是换一家更贵的。
     * 第一版换成了「县城宾馆 180」—— 用户说「换便宜点」，结果涨价 50。
     */
    assert.ok(next.price <= cheapest.price, `底价上还涨价了：${next.price} > ${cheapest.price}`);
    assert.equal(next.kind, cheapest.kind, '已经没有更便宜的了，却还换了一家');
  }
});

test('换房：说「住好点」要真的更好，可以是高档', () => {
  /*
   * 2026-11-06：原来这里只允许 view —— 于是用户「劝了好久换个好的酒店」，
   * 换到天花板也只是景观房。加高档之后，「住好点」可能直接进五星。
   * 断言只钉子两件事：档位不低于景观房、价格必须更高。
   */
  const budget = { tier: 'budget', kind: '县城宾馆', price: 180, feel: '' };
  const rnd = seq(11);
  for (let i = 0; i < 30; i++) {
    const next = rerollLodging(budget, rnd, false, 1, 'nicer');
    assert.ok(next.tier === 'view' || next.tier === 'luxury',
      `要住好点却进了 ${next.tier}`);
    assert.ok(next.price > budget.price, '要住好点却更便宜');
  }
});

test('换房：钱紧时「随便换」也换得起', () => {
  /*
   * 钱紧（poor）时掷房会把景观房压到两成。换房走的是同一支骰子，
   * 所以「钱紧还换到 900 的海景房」不该出现得太频繁 —— 但也不必一次都不出现。
   * 这里只钉住：钱紧时掷出来的房子，一半以上是普通房。
   */
  const cur = { tier: 'view', kind: '湖景客栈', price: 620, feel: '' };
  const rnd = seq(5);
  let budget = 0;
  for (let i = 0; i < 100; i++) {
    if (rerollLodging(cur, rnd, true, 1, 'any').tier === 'budget') budget++;
  }
  assert.ok(budget > 50, `钱紧时普通房只有 ${budget}/100 —— 骰子没跟着钱走`);
});

/* ---------------- 端到端：她真的能换 ---------------- */

function fakeHost() {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => ({ ...e, blobs: [] }),
    pushDeferred() {}, store: {}, drainPendingEvents: async () => [],
  };
}

const staying = (hereId, extra = {}) => ({
  phase: 'staying',
  hereId,
  tripStartedAt: '2026-11-01T00:00:00Z',
  stayStartedAt: '2026-11-02T00:00:00Z',
  stayDateKey: '2026-11-04',
  ...extra,
});

async function boot(trip, cfgOver = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-lodge-'));
  new StateStore(dir).save({ ...initialState('lanzhou'), ...trip });
  const origFetch = globalThis.fetch;
  // 断网：查酒店真名、查天气都失败 —— 换房不该因此办不成。
  globalThis.fetch = async () => { throw new Error('offline'); };
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', ...cfgOver },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-05T02:00:00Z'),
  });
  await world.start(fakeHost());
  const restore = () => { globalThis.fetch = origFetch; world.stop?.(); };
  return { world, dir, restore };
}

const lodgingTool = (w) => w.tools().find((t) => t.name === 'journey_lodging');

test('换房：不带参数只报现在住哪儿，不动数据', async () => {
  const { world, restore } = await boot(staying('tianshui'));
  try {
    const tool = lodgingTool(world);
    assert.ok(tool, '工具表里没有 journey_lodging —— 用户让它换酒店，它还是无路可走');
    const before = world.plan.lodging;
    const out = await tool.handler({});
    assert.match(out.text, /今晚住/, `回执不像在读房：${out.text}`);
    assert.match(out.text, /一晚\s*\d+\s*块/, '没报房价');
    assert.equal(world.plan.lodging.kind, before.kind, '只是看一眼却把房换了');
  } finally { restore(); }
});

test('换房：记账关着也能换（这就是「两种模式都打开」）', async () => {
  const { world, restore } = await boot(staying('tianshui'), { moneyEnabled: false });
  try {
    assert.equal(world.cfg.moneyEnabled, false);
    const before = world.plan.lodging;
    const out = await lodgingTool(world).handler({ change: true, reason: '楼下整夜有喇叭声' });
    assert.match(out.text, /换到/, `没换成：${out.text}`);
    /*
     * 原来是 `notEqual(kind, before.kind)` —— 判据是「类别变了」。
     * 2026-11-09 接入真实数据之后这条不成立了：换房是在**同一座城的同档**里换店，
     * 而真店的类别是从店名推的，两家二钻宾馆都可能叫「连锁商务酒店」。
     * 类别没变、店确实换了 —— 这时候旧断言会误报。
     *
     * 判据改成「名字 / 价格 / 类别 至少变一样」。
     */
    const ids = (x) => `${x.name ?? ''}|${x.price}|${x.kind}`;
    assert.notEqual(ids(world.plan.lodging), ids(before), `说换了，房没变：${ids(world.plan.lodging)}`);
    assert.match(out.text, /喇叭声/, '理由没带上');
    assert.equal(world.st.spent, 0, '记账关着却记了钱');
  } finally { restore(); }
});

test('换房：记账开着时差价照实记', async () => {
  const { world, restore } = await boot(staying('tianshui'), { moneyEnabled: true, budget: 5000 });
  try {
    const before = world.plan.lodging;
    const out = await lodgingTool(world).handler({ change: true, want: 'nicer', reason: '想睡个安静觉' });
    assert.match(out.text, /换到/, `没换成：${out.text}`);
    const after = world.plan.lodging;
    assert.ok(after.price > before.price, `要「住好点」，价没涨：${before.price} → ${after.price}`);
    assert.equal(world.st.spent, after.price - before.price, '差价没记进花销');
  } finally { restore(); }
});

test('换房：时间轴上那几句也跟着换，不留旧店名', async () => {
  /*
   * 作息表里写着「回${店名}。${体感}」。只把 plan.lodging 换个对象的话，
   * 晚上那条节点还会念出旧店名 —— 用户看到的是「她住进了 A，晚上回 B」。
   */
  const { world, restore } = await boot(staying('tianshui'));
  try {
    const before = world.plan.lodging.kind;
    await lodgingTool(world).handler({ change: true, reason: '热水不热' });
    const hotelBeats = world.plan.beats.filter((b) => b.kind === 'hotel');
    assert.ok(hotelBeats.length, '作息表里没有住宿节点');
    for (const b of hotelBeats) {
      assert.equal(
        String(b.what).includes(before) && before !== world.plan.lodging.kind,
        false,
        `住宿节点还在念旧店名：${b.what}`,
      );
    }
  } finally { restore(); }
});

test('换房：在路上时拒绝，不硬换一间', async () => {
  const { world, restore } = await boot({
    phase: 'traveling',
    hereId: '',
    tripStartedAt: '2026-11-01T00:00:00Z',
  });
  try {
    const out = await lodgingTool(world).handler({ change: true });
    assert.match(out.text, /路上|不在住处/, `在路上还以为能换房：${out.text}`);
  } finally { restore(); }
});

test('换房：want 写错时按「随便换」处理，不报错也不静默不动', async () => {
  const { world, restore } = await boot(staying('tianshui'));
  try {
    const before = world.plan.lodging;
    const out = await lodgingTool(world).handler({ change: true, want: 'cheapest' });
    assert.match(out.text, /换到/, `参数写错就办不成事：${out.text}`);
    /*
     * 判据从「类别变了」改成「名字 / 价格 / 类别 至少变一样」——
     * 理由同上面那条：接入真实数据后，同档两家店的类别可能都叫「连锁商务酒店」。
     */
    const ids = (x) => `${x.name ?? ''}|${x.price}|${x.kind}`;
    assert.notEqual(ids(world.plan.lodging), ids(before), `说换了，房没变：${ids(world.plan.lodging)}`);
  } finally { restore(); }
});

test('工具表：journey_lodging 标成写操作，参数只有三个', async () => {
  const { world, restore } = await boot(staying('tianshui'));
  try {
    const tool = lodgingTool(world);
    assert.ok(tool.tags.includes('write'), '它会改状态、改作息表，不该标成只读');
    assert.deepEqual(
      Object.keys(tool.parameters.properties ?? {}).sort(),
      ['change', 'reason', 'want'],
      '参数和设计不一致',
    );
  } finally { restore(); }
});
