/**
 * 只能坐船去的地方（2026-11-25）
 *
 * ## 起因
 *
 * 读者来信：「鲸鲸想去涠洲岛，但是被买船票拦住了」（那句「城市表里没有」已由 2.10.3 修掉），
 * 紧接着的第二句是：「还有哪些景点是这种需要坐船去但是没有船过不去的情况」。
 *
 * 查下来是**市内交通没有船这一档**：`inCityMode()` 只看距离（一公里走路、三公里骑车、
 * 九公里以上公交或打车），而 `act()` 里的距离是种子给的假数 ——
 * 于是「去涠洲岛」会写成「坐地铁去涠洲岛」，去鼓浪屿也可能「骑共享单车去」。
 * 岛和陆之间没有桥的时候，这句话一眼就是假的。
 *
 * ## 这里守什么
 *
 * 1. 表里那几个岛：去的时候一定是船，不是地铁/公交/打车；
 * 2. 船票真的进了当天的交通花费；
 * 3. 陆路能到的「橘子洲」「太阳岛」**不许**被误伤成船 —— 它们名字里也有「岛」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { cityById, ferryTo, FERRY_PLAN } = await import('../src/geo/cities.ts');
const { planDay } = await import('../src/plan/dayplan.ts');
const { rollLodging } = await import('../src/plan/lodging.ts');

const LODGING = rollLodging(() => 0.2);
const DAYS = ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30'];

/** 连着几天去找「这一天排到了 spot」的那一版行程。 */
function dayWithSpot(city, spot) {
  for (const d of DAYS) {
    const day = planDay({ city, dateKey: d, shape: 'full', lodging: LODGING, dayIndex: 0 });
    const beats = day.beats ?? [];
    const hit = beats.find((b) => String(b.spot ?? '') === spot);
    if (hit) return { day, beats };
  }
  return null;
}

test('去岛上是坐船，不是坐地铁 —— 涠洲岛 / 鼓浪屿', () => {
  for (const [cityId, spot, price] of [['beihai', '涠洲岛', 80], ['xiamen', '鼓浪屿', 35]]) {
    const city = cityById(cityId);
    const found = dayWithSpot(city, spot);
    assert.ok(found, `${city.name} 五天都没排到 ${spot}，这条测试要换个写法`);

    /*
     * **只看「去这个岛」的那一条**，不是整天 —— 同一天里还有陆地景点
     * （北海这天就有「打车去银滩」），那一趟打车是对的，拿来判会误伤。
     */
    const ride = found.beats.find((b) => b.kind === 'commute' && String(b.what ?? '').includes(spot));
    assert.ok(ride, `没有「去${spot}」的交通那一条：${found.beats.map((b) => b.what).join(' | ')}`);
    const txt = String(ride.what);
    assert.match(txt, /坐渡船去/, `没坐船：${txt}`);
    assert.doesNotMatch(txt, /地铁|公交|打车|单车|电瓶车|开车/, `还在用陆路交通登岛：${txt}`);

    assert.ok(found.day.commute.modes.includes('渡船'), `交通集合里没有渡船：${found.day.commute.modes.join('/')}`);
    assert.ok(
      found.day.commute.price >= price,
      `船票没进当天花费：${found.day.commute.price} < ${price}`,
    );
  }
});

test('有车也开不上岛 —— 自驾与包车排在船后面', () => {
  const city = cityById('beihai');
  const found = dayWithSpot(city, '涠洲岛');
  assert.ok(found, '没排到涠洲岛');
  /*
   * 传一部车的配置进去，验证 ferry 那一支仍然先命中。原文：
   * 有一个读者就是开着房车去的北海，然后看到她「开车上涠洲岛」。
   */
  const withCar = planDay({
    city,
    dateKey: '2026-11-26',
    shape: 'full',
    lodging: LODGING,
    dayIndex: 0,
    car: { tier: 'comfort', fuel: 'gas' },
  });
  const ride = (withCar.beats ?? []).find((b) => b.kind === 'commute' && String(b.what ?? '').includes('涠洲岛'));
  if (ride) {
    assert.doesNotMatch(String(ride.what), /开车去/, `开车上岛了：${ride.what}`);
    assert.match(String(ride.what), /坐渡船去/, `有车也该坐船：${ride.what}`);
  }
});

test('陆路能到的「岛」不许被误伤 —— 橘子洲、太阳岛', () => {
  for (const [cityId, spot] of [['changsha', '橘子洲'], ['haerbin', '太阳岛']]) {
    assert.equal(ferryTo(cityId, spot), null, `${spot} 有桥，不该要船`);
    const city = cityById(cityId);
    const found = dayWithSpot(city, spot);
    if (!found) continue;      // 这五天没排到就只验数据层
    const all = found.beats.map((b) => String(b.what ?? '')).join(' | ');
    assert.doesNotMatch(all, /渡船/, `${city.name} 的 ${spot} 不该坐船：${all}`);
  }
});

test('ferryTo 的边界：同一座城里有的要船、有的不要', () => {
  /* 厦门：鼓浪屿要，环岛路不要。 */
  assert.deepEqual(ferryTo('xiamen', '鼓浪屿'), { ...FERRY_PLAN.short, tier: 'short' });
  assert.equal(ferryTo('xiamen', '环岛路'), null);
  /* 北海：涠洲岛要，银滩不要。 */
  assert.equal(ferryTo('beihai', '银滩'), null);
  /* 数据里的景点名带后缀（「海驴岛（4—10 月海上游，冬季停航）」）也要认。 */
  assert.equal(ferryTo('weihai', '海驴岛（4—10 月海上游，冬季停航）')?.tier, 'mid');
  /* 空输入、错城市，都返回 null，不抛。 */
  assert.equal(ferryTo('', '涠洲岛'), null);
  assert.equal(ferryTo('beihai', ''), null);
  assert.equal(ferryTo('lanzhou', '涠洲岛'), null);
});
