/**
 * 景区里的代步（2026-11-10）。
 *
 * ## 起因
 *
 * 用户截图：「腿酸就租个自行车呗～」
 * 她答：「这会儿还在路上……不过锦里那种巷子窄，骑车大概也得推着走。」
 *
 * 两件事同时不对：
 *
 * 1. **她手里没有「这儿能坐什么」这条事实**，只能答「等进去了我问问」。
 *    跟 1.0.8 那次「景区自行车她说找不到」、日记提醒那次是同一条规律 ——
 *    **不在时间轴里的事，对她就是不存在的。**
 * 2. 更硬的：`pickSpotExtra` 的 `comfortable` 来自 `purseRich()`，而它
 *    「记账关着就恒为 false」。于是**记账一关，索道、观光车、自行车、讲解一次都不会出现**，
 *    山上也只能走路。那不是随机没抽到，是硬开关。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { spotRideOptions } = await import('../src/plan/leisure.ts');
const { planDay } = await import('../src/plan/dayplan.ts');
const { cityById } = await import('../src/geo/cities.ts');

const LODGING = {
  kind: 'hotel', name: '测试酒店', price: 300, feel: '干净，窗外是对面楼的墙',
  address: '', star: 3, tier: 'mid',
};

/** 一天里有没有「这儿能坐/只能靠腿」这类事实句。 */
const rideFacts = (plan) => plan.beats.filter((b) => /这儿能坐|只能靠腿走/.test(b.what));

test('山上有索道，走路不是唯一选项', () => {
  const opts = spotRideOptions('峨眉山').map((o) => o.how);
  assert.ok(opts.includes('cableway'), '峨眉山连索道都没有，爬山就只能靠腿了');
});

test('步行街没有代步 —— 这是真的，不该硬编一个自行车', () => {
  const opts = spotRideOptions('锦里').filter((o) => o.how !== 'walk' && o.how !== 'guide');
  assert.equal(opts.length, 0, '锦里那种巷子确实骑不进去；给她一辆自行车就是编');
});

test('景区代步不受「手头宽不宽」支配', () => {
  /*
   * 记账关着（`spotRideOk: true`）时，山上排得进索道/滑道；
   * 传 false 就只剩自己走 —— 这是旧的 `comfortable` 行为，保留给「真没钱」。
   */
  const city = cityById('leshan') ?? cityById('chengdu');
  assert.ok(city, '找不到测试城市');

  const days = [0, 1, 2, 3].map((i) => planDay({
    city, dateKey: `2026-11-0${i + 1}`, shape: 'full', lodging: LODGING, dayIndex: i, spotRideOk: true,
  }));
  const anyRide = days.some((d) => d.beats.some((b) => /索道|观光车|自行车|滑道|滑竿/.test(b.what)));
  assert.equal(anyRide, true, '记账关着的时候，景区里仍然只靠腿走');
});

test('同一天里：山上有代步句，步行街没有', () => {
  /*
   * 成都这天正好是「青城山 + 锦里」—— 和用户截图里那一幕同城同日。
   * 该出现的只有山上那一句；锦里那条街本来骑不进去，不写。
   */
  const city = cityById('chengdu');
  const plan = planDay({
    city, dateKey: '2026-11-09', shape: 'full', lodging: LODGING, dayIndex: 1, spotRideOk: false,
  });
  const facts = rideFacts(plan);
  assert.equal(facts.length, 1, `代步句数量不对：${facts.map((f) => f.what).join(' / ')}`);
  assert.match(facts[0].what, /索道/, '山上那句应该说的是索道');
});

test('山上的景点：没坐也要说一句「这儿能坐什么」', () => {
  const city = cityById('huangshan') ?? cityById('emeishan') ?? cityById('taian');
  assert.ok(city, '找不到有山的测试城市');
  const plans = [0, 1, 2].map((i) => planDay({
    city, dateKey: `2026-11-0${i + 1}`, shape: 'full', lodging: LODGING, dayIndex: i, spotRideOk: false,
  }));
  const said = plans.some((p) => rideFacts(p).length > 0);
  assert.equal(said, true, '山上有索道却从来不提，被问腿酸她只能答「我问问」');
});
