/**
 * 生活层（模拟鱼生）广播预算之后，钱袋判据必须还是**一套**。
 *
 * 2026-11-16 审查查出的三件事，这里逐条钉住：
 *   1. 广播的是实时余额，**不能再减 `spent`**（否则同一笔路费扣两回）；
 *   2. 广播 0 = 没钱了，要落 `empty`，**不等于**「手填预算 0 = 不限」；
 *   3. 阶段 / 住店 / 景区 / 票价 / 里程**全部**走同一个余钱来源，不许有的读广播、有的读手填。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { purseMethods } from '../src/world-purse.ts';

const ctx = (dir, over = {}) => ({
  ...purseMethods, // 方法之间用 this.xxx 互调，单独 call 一个也得把整组挂上
  cfg: { moneyEnabled: true, budget: 0 },
  st: { spent: 0, earned: 0, returning: false },
  opts: { dataDir: dir },
  fareOf: () => 100,
  ...over,
});
const broadcast = (dir, allowance, cash = allowance * 2) => {
  writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
    schema: 2, asleepUntil: '', ledger: { cash, travelAllowance: allowance },
  }));
};
const dir = () => mkdtempSync(join(tmpdir(), 'purse-life-'));

test('没装生活层：退回手填预算 − 净花销（老行为不变）', () => {
  const c = ctx(dir(), { cfg: { moneyEnabled: true, budget: 3000 }, st: { spent: 800, earned: 100, returning: false } });
  assert.equal(purseMethods.lifeAllowance.call(c), null);
  assert.equal(purseMethods.purseLeft.call(c), 3000 - (800 - 100));
});

test('生活层广播的是实时余额：不再减 spent', () => {
  const d = dir();
  broadcast(d, 3500);
  const c = ctx(d, { st: { spent: 3000, earned: 0, returning: false } });
  // 修之前：3500 - 3000 = 500（同一笔路费被扣两回）
  assert.equal(purseMethods.purseLeft.call(c), 3500);
  assert.equal(purseMethods.purseRangeKm.call(c), Math.max(200, (3500 * 0.5) / 0.4));
});

test('广播 0 = 没钱了，落 empty，不是「不限」', () => {
  const d = dir();
  broadcast(d, 0, 0);
  const c = ctx(d);
  assert.equal(purseMethods.purseLeft.call(c), 0);
  assert.equal(purseMethods.purseStage.call(c), 'empty');
  // 景区与回家这两处原来拿 `budget <= 0` 当「不限」，现在必须按没钱算
  assert.equal(purseMethods.spotSpendOk.call(c), false);
  assert.equal(purseMethods.canAffordTrip.call(c, 100), false);
  assert.equal(purseMethods.purseRangeKm.call(c), 600);
});

test('手填预算 0 且没装生活层 = 不限（老语义保留）', () => {
  const c = ctx(dir(), { cfg: { moneyEnabled: true, budget: 0 } });
  assert.equal(purseMethods.purseLeft.call(c), null);
  assert.equal(purseMethods.purseStage.call(c), 'ok');
  assert.equal(purseMethods.purseRangeKm.call(c), Infinity);
  assert.equal(purseMethods.spotSpendOk.call(c), true);
  assert.equal(purseMethods.canAffordTrip.call(c, 100), true);
});

test('手填预算 0 但生活层有广播：按广播算，有钱这个概念', () => {
  const d = dir();
  broadcast(d, 5000);
  const c = ctx(d, { cfg: { moneyEnabled: true, budget: 0 } });
  assert.equal(purseMethods.purseLeft.call(c), 5000);
  assert.equal(purseMethods.purseRich.call(c), true); // > 2500
  assert.equal(purseMethods.purseStage.call(c), 'ok');
});

test('生活层档位只按绝对地板：900 / 420 / 160', () => {
  for (const [allowance, want] of [[1000, 'ok'], [500, 'tight'], [300, 'low'], [100, 'empty']]) {
    const d = dir();
    broadcast(d, allowance);
    assert.equal(purseMethods.purseStage.call(ctx(d)), want, `allowance=${allowance}`);
  }
});

test('记账关着：生活层广播也不替她省钱', () => {
  const d = dir();
  broadcast(d, 0, 0);
  const c = ctx(d, { cfg: { moneyEnabled: false, budget: 0 } });
  assert.equal(purseMethods.purseLeft.call(c), null);
  assert.equal(purseMethods.purseStage.call(c), 'ok');
  assert.equal(purseMethods.purseRangeKm.call(c), Infinity);
});

test('moneyLine 在广播模式下报「还能动用」，不报「预算」', () => {
  const d = dir();
  broadcast(d, 3500);
  const line = purseMethods.moneyLine.call(ctx(d, { st: { spent: 3000, earned: 0, returning: false } }));
  assert.ok(line.includes('还能动用 3500'), line);
  assert.ok(!line.includes('预算'), line);
});

test('广播文件坏了：退回手填预算，不抛异常', () => {
  const d = dir();
  writeFileSync(join(d, 'life-public.json'), '{不是 json');
  const c = ctx(d, { cfg: { moneyEnabled: true, budget: 2000 } });
  assert.equal(purseMethods.lifeAllowance.call(c), null);
  assert.equal(purseMethods.purseLeft.call(c), 2000);
});

test('807 元低余额（travelAllowance=565）拦住从家远行/撑不起的出发，且 affordMode 拦住超出旅费一半的贵票', async () => {
  const { JourneyWorld } = await import('../src/world.ts');
  const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
  const { cityById } = await import('../src/geo/cities.ts');

  const d = dir();
  // 现金 807 -> travelAllowance = 565
  broadcast(d, 565, 807);
  const lz = cityById('lanzhou');
  const zs = cityById('zhoushan');
  const c = ctx(d, {
    cfg: { moneyEnabled: true, payFromLife: true, budget: 0 },
    fareOf: (id, km) => (id === 'plane' ? km * 0.4 : id === 'train' ? km * 0.21 : km * 0.33),
  });
  // 兰州到舟山往返 + 2天吃住远超 565
  const dep = purseMethods.homeDepartAffordable.call(c, lz, zs, 1800);
  assert.equal(dep.ok, false);
  assert.ok(dep.need > 565);

  // 565 元余额下 affordMode(1800, 0.5) 上限约 282.5 元，必须拦住飞机与 1800km 贵票
  const filter = purseMethods.affordMode.call(c, 1800, 0.5, false, { from: lz, to: zs });
  assert.equal(filter({ id: 'plane' }), false);

  // 真实 World：807 元现金时在家自主 depart()（即便选中远处）应留在家里攒钱
  const infos = [];
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', moneyEnabled: true, payFromLife: true, restDays: 0 },
    dataDir: d,
    botName: '大肥鱼',
    now: () => new Date('2026-11-27T04:00:00Z'), // 当地 12:00
  });
  await w.start({
    log: { trace() {}, debug() {}, info: (m) => infos.push(m), warn() {}, error() {} },
    pushEvent: async (e) => ({ ...e, cursor: 1, blobs: [] }),
    store: {},
    drainPendingEvents: async () => [],
  });
  // 跳过加载宽限
  w.bootedAt = new Date('2026-11-27T04:00:00Z').getTime() - 10 * 60_000;
  // 无论挑到什么城市，只要最低往返+2天住吃 > 565 就必须被拦在家里；用 pickNextLeg 固定挑舟山验证
  w.pickNextLeg = () => ({ city: zs, km: 1800 });
  await w.depart(new Date('2026-11-27T04:00:00Z'));
  assert.equal(w.st.phase, 'home', '807 元现金不应自主出发去远方');
  assert.ok(infos.some((m) => m.includes('不够往返') && m.includes('先在家攒钱')));
  await w.stop?.();
});
