/**
 * 当地租车 —— 2026-11-06
 *
 * 群里的反馈：「他说租车只是换城市用的，在城里玩还是只能靠腿」。
 * 城际选自驾确实会带出一辆车（`depart` 里建的），`planDay` 也确实在城里开车去景点；
 * 缺的是「在这座城里单独租一辆」的入口。
 *
 * 顺带修了一个死字段：`car.days` 从 0.7.22 起就写在 state 里，**从来没被读过** ——
 * 「租三天」永远不到期，异地出发那 600 块买到的是无限期。现在它真的会走。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');

function staying(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-car-'));
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', ...over },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-06T13:00:00Z'),
  });
  w.st = { ...w.st, phase: 'staying', hereId: 'chengdu', car: null };
  return w;
}

test('在城里租三天：车建起来，钱照扣', async () => {
  const w = staying({ moneyEnabled: true, budget: 5000 });
  const r = await w.rentCar(3, false);
  assert.equal(r.isError, undefined, `不该被拒：${r.text}`);
  assert.equal(w.st.car?.days, 3, '租期没记上 —— 那个字段又会变成摆设');
  assert.equal(w.st.car?.fuel, 'oil');
  assert.equal(w.st.spent, 600, `扣的钱不对：${w.st.spent}（一天 200 × 3）`);
  assert.match(r.text, /600 块/, `回执没报价：${r.text}`);
});

test('电车按电车算', async () => {
  const w = staying();
  await w.rentCar(2, true);
  assert.equal(w.st.car?.fuel, 'ev', '指定了电车却给了油车，油钱就按 0.7/km 算了');
});

test('已经有一辆车就不再租第二辆', async () => {
  const w = staying();
  w.st = { ...w.st, car: { fuel: 'oil', days: 2, km: 10 } };
  const r = await w.rentCar(3);
  assert.equal(r.isError, true);
  assert.match(r.text, /一辆够用|已经有车/, r.text);
});

test('在路上租不了 —— 「当地」得先落地', async () => {
  const w = staying();
  w.st = { ...w.st, phase: 'traveling' };
  const r = await w.rentCar(3);
  assert.equal(r.isError, true);
  assert.match(r.text, /路上/, r.text);
});

test('钱不够就直说，别答应下来', async () => {
  const w = staying({ moneyEnabled: true, budget: 500 });
  const r = await w.rentCar(3, false);
  assert.equal(r.isError, true, '钱不够还租，是替她许一个付不起的账');
  assert.match(r.text, /租不起|不够/, r.text);
  assert.equal(w.st.car, null, '被拒了却把车建起来了');
  assert.equal(w.st.spent, 0, '被拒了还扣了钱');
});

test('天数越界要夹住，不能租一年', async () => {
  const w = staying({ moneyEnabled: true, budget: 9000 });
  await w.rentCar(99, false);
  assert.equal(w.st.car?.days, 7, '上限 7 天没夹住');
  const w2 = staying({ moneyEnabled: true, budget: 9000 });
  await w2.rentCar(0, false);
  assert.equal(w2.st.car?.days, 1, '下限 1 天没夹住（0 是「自己的车」的语义，不能给租车）');
});

test('记账关着时不扣钱，但车照样租得到', async () => {
  /*
   * 2026-11-17：记账的**默认值改成开**（Mr.Q：「想去洛杉矶就得赚出相应的钱」），
   * 所以这一条要显式关掉才测得到「关着」的行为。
   * 断言本身没变 —— 开关还得好使，只是不再是默认那一档。
   */
  const w = staying({ moneyEnabled: false });
  const r = await w.rentCar(3, false);
  assert.equal(r.isError, undefined, r.text);
  assert.equal(w.st.spent, 0, '记账关着还扣钱，用户会莫名看到「今天花了六百」');
  assert.equal(w.st.car?.days, 3);
});

test('分三档：租金、档位都要对上', async () => {
  /*
   * Mr.Q：「租车也和酒店一样划分等级」。原来一律 200/天 ——
   * 她要一辆代步车还是一辆开得舒服的，账上没有任何区别。
   */
  const a = staying({ moneyEnabled: true, budget: 9000 });
  await a.rentCar(3, false, 'economy');
  assert.equal(a.st.spent, 300, `经济型三天该是 300：${a.st.spent}`);
  assert.equal(a.st.car?.tier, 'economy');

  const b = staying({ moneyEnabled: true, budget: 9000 });
  await b.rentCar(2, false, 'luxury');
  assert.equal(b.st.spent, 900, `豪华型两天该是 900：${b.st.spent}`);
  assert.equal(b.st.car?.tier, 'luxury');
});

test('不填档位就是原来那个价（200/天），老调用方不用改', async () => {
  const w = staying({ moneyEnabled: true, budget: 9000 });
  await w.rentCar(3, false);
  assert.equal(w.st.spent, 600);
  assert.equal(w.st.car?.tier, 'comfort');
});

test('已有的车要说清是哪一档，别只说「有车了」', async () => {
  const w = staying();
  await w.rentCar(2, false, 'luxury');
  const r = await w.rentCar(2, false, 'economy');
  assert.equal(r.isError, true);
  assert.match(r.text, /SUV|大一点/, `没说清现在这辆是什么：${r.text}`);
});

test('同开模拟鱼生时：未考驾照即使 cfg.hasLicense=true 也拦住租车，考下即放行', async () => {
  const { writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const w = staying({ moneyEnabled: true, budget: 5000, hasLicense: true });
  try {
    writeFileSync(join(w.opts.dataDir, 'life-public.json'), JSON.stringify({
      schema: 2,
      updatedAt: '2026-11-06T13:00:00Z',
      certs: [],
    }), 'utf8');
    const denied = await w.rentCar(2, false);
    assert.equal(denied.isError, true, '同开 life 且无驾照时应拒绝租车');
    assert.match(denied.text, /没考下驾照/);
    assert.equal(w.st.car, null);
    assert.equal(w.st.spent, 0);

    writeFileSync(join(w.opts.dataDir, 'life-public.json'), JSON.stringify({
      schema: 2,
      updatedAt: '2026-11-06T13:00:00Z',
      certs: ['驾照'],
    }), 'utf8');
    const okRes = await w.rentCar(2, false);
    assert.equal(okRes.isError, undefined, `考下驾照后应允许租车：${okRes.text}`);
    assert.equal(w.st.car?.days, 2);
    assert.equal(w.st.spent, 400);
  } finally {
    rmSync(w.opts.dataDir, { recursive: true, force: true });
  }
});
