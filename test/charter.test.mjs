/**
 * 包车期间不再另叫城市交通（2026-11-11）
 *
 * 起因：鱼鱼出行作者发来的接口申请。对方按小时卖包车（4 / 8 / 20 小时），
 * 那笔钱是一次性付掉的；可她一出门，这边仍然按 `inCityMode` 叫一辆公交、
 * 或者再叫一辆出租 —— 同一个下午两笔车费，日记里两段交通。
 *
 * 这一组盯三件事：
 *   1. `charter: true` 时通勤只剩一段，而且写的是「坐包车去 X」
 *   2. 那段**不计费**（钱在订单里付过了），但里程照算（车总要开过去）
 *   3. 包车优先于自有车 —— 两样同时在手时用包车，不然按小时付的钱白扔
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { planDay } = await import('../src/plan/dayplan.ts');
const { cityById } = await import('../src/geo/cities.ts');
const { rollLodging } = await import('../src/plan/lodging.ts');
const { spotRideOptions } = await import('../src/plan/leisure.ts');

function lcg(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

const plan = (city, rnd, over = {}) => planDay({
  city,
  dateKey: '2026-11-11',
  shape: 'full',
  lodging: rollLodging(lcg(7)),
  rnd,
  ...over,
});

test('包车期间：通勤写「坐包车去 X」，不叫公交/地铁/出租', () => {
  const c = cityById('xian');
  const p = plan(c, lcg(42), { charter: true });
  const commutes = p.beats.filter((b) => b.kind === 'commute');
  assert.ok(commutes.length > 0, `包车那天一个通勤节点都没有：${p.beats.map((b) => b.kind)}`);
  for (const b of commutes) {
    assert.match(b.what, /^坐包车去/, `包车期间还在叫别的车：${b.what}`);
  }
  /*
   * 对照：同种子、不传 charter，交通方式里不会出现「包车」。
   * 没有这一条，上面那条可能只是恰好撞上了。
   */
  const normal = plan(c, lcg(42));
  const normalCommutes = normal.beats.filter((b) => b.kind === 'commute');
  assert.ok(
    normalCommutes.every((b) => !/包车/.test(b.what)),
    `没有包车却排了包车：${normalCommutes.map((b) => b.what)}`,
  );
});

test('包车期间：不产生车费，但趟数照记', () => {
  const c = cityById('xian');
  const p = plan(c, lcg(42), { charter: true });
  assert.equal(p.commute.price, 0, `包车期间还收了 ${p.commute.price} 块城市交通费 —— 会跟订单重复收费`);
  assert.ok(p.commute.trips > 0, '趟数没记 —— 面板上会像「今天没出过门」');
  assert.ok(p.commute.modes.includes('包车'), `交通方式里没有包车：${p.commute.modes}`);
});

test('包车优先于自有车 —— 按小时付的钱不能白扔', () => {
  const c = cityById('xian');
  const p = plan(c, lcg(42), { charter: true, car: { fuel: 'gas', tier: 'comfort' } });
  const commutes = p.beats.filter((b) => b.kind === 'commute');
  for (const b of commutes) {
    assert.match(b.what, /^坐包车去/, `两样都在手时没用包车：${b.what}`);
  }
  assert.equal(p.commute.price, 0, '包车期间不该再收油钱');
});

test('包车的通勤时刻和平时不一样 —— 说明这一支真的接管了', () => {
  /*
   * 不写「那一段占多少分钟」：`commute.at` 是「活动时刻 − 路上分钟」，
   * 而**不是每一天都有那格活动**（西安这个种子排出来只有饭点和回酒店），
   * 拿「下一个节点减它」会算成几个小时，那不是通勤时长。
   *
   * 所以换一个更硬的判据：同城同种子，传不传 `charter` 出来的通勤时刻应当不同 ——
   * 包车走自驾那套（`km * 1.6 + 5` 分钟），平时走 `inCityMode` 的公交/地铁/单车，
   * 两套速度不一样。**时刻一样就说明 `charter` 那一支根本没被走到。**
   */
  const c = cityById('xian');
  const charter = plan(c, lcg(42), { charter: true });
  const normal = plan(c, lcg(42));
  const a = charter.beats.filter((b) => b.kind === 'commute');
  const b = normal.beats.filter((b) => b.kind === 'commute');
  assert.equal(a.length, b.length, '包车改变了通勤段数 —— 它只该换交通方式，不该增减节点');
  const diff = a.some((x, i) => Math.abs(x.at - b[i].at) > 1 / 3600);
  assert.ok(diff, '包车和平时排出完全一样的通勤时刻 —— charter 那一支没生效');
});

test('没有包车时行为和原来一样', () => {
  const c = cityById('xian');
  const a = plan(c, lcg(42));
  const b = plan(c, lcg(42), { charter: false });
  assert.deepEqual(a.beats, b.beats, '传 false 和不传，结果不一样');
});

/* ---------------- world 层：包车判定与下一站（2026-11-11） ---------------- */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

/** 造一个 she 在西安待着的 world，时钟固定（当地 10:00 = UTC 02:00）。 */
function makeWorld(localIso = '2026-11-11T02:00:00Z') {
  const dir = mkdtempSync(join(tmpdir(), 'jr-charter-'));
  new StateStore(dir).save({
    ...initialState('lanzhou'),
    phase: 'staying',
    hereId: 'xian',
    stayDateKey: '2026-11-11',
  });
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', bridgeSpend: true },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(localIso),
  });
  return { w, dir };
}

function writeLive(dir, over = {}) {
  writeFileSync(join(dir, 'ride-live.json'), JSON.stringify({
    schema: 1,
    active: true,
    id: 'ride-1',
    service: 'charter',
    status: 'riding',
    car: '帕萨特',
    plate: '陕A·12345',
    from: '西安钟楼',
    to: '兵马俑',
    cityName: '西安',
    fare: 480,
    progress: 10,
    secondsToPickup: 0,
    secondsToDropoff: 900,
    /* 两小时后过期：真实时刻，不是世界时刻。 */
    expiresAt: new Date(Date.parse('2026-11-11T02:00:00Z') + 2 * 3600_000).toISOString(),
    ...over,
  }), 'utf8');
}

test('charterNow：没有 ride-live.json 就是没有包车', () => {
  const { w } = makeWorld();
  assert.equal(w.charterNow(), null);
});

test('charterNow：service=charter 且没过期且 to 非空 → 认得出来', () => {
  /*
   * **先写文件，再问。** 反过来不行：`readLive` 有 1 秒缓存，而测试里时钟是固定的，
   * `real - cache.at < 1000` 永远成立 —— 先问一次 null，之后写什么文件都还是 null。
   */
  const { w, dir } = makeWorld();
  writeLive(dir);
  const got = w.charterNow();
  assert.ok(got, 'ride-live.json 摆在那儿却没认出来');
  assert.equal(got.to, '兵马俑');
});

test('charterNow：叫车（service=ride）不算包车', () => {
  const { w, dir } = makeWorld();
  writeLive(dir, { service: 'ride' });
  assert.equal(w.charterNow(), null, '普通叫车被当成了包车 —— 那会让她一整天都不叫车');
});

test('charterNow：过期的包车不算', () => {
  const { w, dir } = makeWorld();
  writeLive(dir, { expiresAt: '2026-11-11T01:00:00Z' }); // 早于 now
  assert.equal(w.charterNow(), null, '过期的包车还在生效，她会一直白坐车');
});

test('charterNow：订单目的地还空着时不算 —— 不能因此不安排交通', () => {
  const { w, dir } = makeWorld();
  writeLive(dir, { to: '' });
  assert.equal(w.charterNow(), null, 'to 空着就当成有包车，她那天会不叫任何车');
});

test('nextStop：给出下一个带地名的活动，时刻是世界时刻', () => {
  const { w } = makeWorld();
  w.plan = {
    dateKey: '2026-11-11',
    meals: [],
    beats: [
      { at: 9, kind: 'breakfast', what: '早饭' },
      { at: 10, kind: 'commute', what: '坐包车去兵马俑' },
      { at: 10.5, kind: 'activity', what: '在兵马俑', spot: '兵马俑', until: 13 },
      { at: 14, kind: 'activity', what: '在城墙', spot: '城墙', until: 16 },
    ],
    lodging: { kind: 'chain', name: '某宾馆', price: 200, feel: '' },
    commute: { trips: 1, price: 0, modes: ['包车'] },
    sunriseHour: null, sunsetHour: null, weather: null,
    neighbors: [], invites: [], pool: 0,
  };
  const ns = w.nextStopForPublic();
  assert.ok(ns, '有活动却给不出下一站');
  assert.equal(ns.name, '兵马俑');
  /* 当地 10:30（西安 UTC+8）= 世界 02:30Z。给的是世界时刻，对方直接跟 clock.worldNow 比。 */
  assert.equal(ns.at, '2026-11-11T02:30:00.000Z');
});

test('nextStop：路上/没有作息表都给 null', () => {
  const { w } = makeWorld();
  assert.equal(w.nextStopForPublic(), null, '没有作息表却给了下一站');
  w.plan = {
    dateKey: '2026-11-11', meals: [], beats: [],
    lodging: { kind: 'chain', name: 'x', price: 1, feel: '' },
    commute: { trips: 0, price: 0, modes: [] },
    sunriseHour: null, sunsetHour: null, weather: null,
    neighbors: [], invites: [], pool: 0,
  };
  assert.equal(w.nextStopForPublic(), null, '空表却给了下一站');
});

/* ---------------- 交通分支不许吞掉景点（2026-11-12） ---------------- */

test('有车：开车去之后必须真的有景点，不是开一天车', () => {
  /*
   * Mr.Q 截图抓到的那天：
   *
   * ```
   * 09:15  开车去莫高窟
   * 12:30  午饭，澜宝说这家泡儿油糕…
   * 14:15  开车去鸣沙山
   * ```
   *
   * **一整天在开车，一个景点都没进去。**
   *
   * 根因：`args.car` 和 `args.charter` 两支写完 `push(commute)` 就 `return`，
   * 把后面整段「到了之后怎么逛」全跳过了 —— 而那段是挂在 `push(at,'activity',…)`
   * 之后的，公交通勤走完会到，开车和包车永远到不了。
   *
   * 交叉验证：同一天同种子，没车的版本有 activity，有车的版本没有 —— 这就是活的 bug。
   */
  const c = cityById('dunhuang');
  const noCar = plan(c, lcg(42));
  const withCar = plan(c, lcg(42), { car: { fuel: 'oil', tier: 'comfort' } });

  const acts = (p) => p.beats.filter((b) => b.kind === 'activity');
  assert.ok(acts(noCar).length > 0, '基准不成立：没车的那天本来就没景点，这条测试抓不到东西');
  assert.ok(
    acts(withCar).length > 0,
    `有车那天一个景点都没有 —— 她开了一天车。节点：${withCar.beats.map((b) => `${b.kind}:${b.what}`).join(' | ')}`,
  );
  /* 开车那一段也得在，别修过头把交通删了。 */
  assert.ok(
    withCar.beats.some((b) => b.kind === 'commute' && /^开车去/.test(b.what)),
    '开车那一段没了',
  );
});

test('包车：同样不许吞掉景点', () => {
  const p = plan(cityById('dunhuang'), lcg(42), { charter: true });
  const acts = p.beats.filter((b) => b.kind === 'activity');
  assert.ok(acts.length > 0, '包车那天一个景点都没有 —— 跟有车那支同一个 bug');
  assert.ok(
    p.beats.some((b) => b.kind === 'commute' && /^坐包车去/.test(b.what)),
    '包车那一段没了',
  );
});

test('有车的油钱算得出来，不是 NaN', () => {
  /*
   * `CAR_TIERS[tier].per` 的键是 `oil` / `ev`（`state.ts` 里 fuel 的联合类型也是这两个）。
   * 传错值 → `per[undefined]` → `km * undefined` → **NaN 会一路污染 `spent`**。
   */
  const p = plan(cityById('dunhuang'), lcg(42), { car: { fuel: 'oil', tier: 'comfort' } });
  assert.ok(Number.isFinite(p.commute.price), `交通费是 ${p.commute.price} —— 账会被污染`);
  assert.ok(p.commute.price > 0, '有车那天油钱是 0');
});

/* ---------------- 有故事的地方必须有讲解（2026-11-12） ---------------- */

test('莫高窟这类地方提供讲解 —— 正则别漏词', () => {
  /*
   * Mr.Q：「莫高窟没讲解还行」。
   *
   * 查下来不是概率问题：`spotRideOptions` 的 `story` 正则会话写的是「石窟」，
   * 而**「莫高窟」三个字里没有「石窟」** —— 它连候选都没进。
   * 同类漏网：兵马俑、长城、都江堰。
   *
   * 这条守的是「这些地方至少要有讲解这个选项」，不管买不买。
   */
  const need = ['莫高窟', '龙门石窟', '兵马俑', '长城', '故宫', '大雁塔', '都江堰'];
  for (const spot of need) {
    assert.ok(
      spotRideOptions(spot).some((o) => o.how === 'guide'),
      `${spot} 没有讲解选项 —— 这种地方不听讲解等于白来`,
    );
  }
  /* 自然景观不该硬塞讲解：鸣沙山没人给你讲沙子的故事。 */
  assert.ok(
    !spotRideOptions('鸣沙山').some((o) => o.how === 'guide'),
    '鸣沙山被塞了讲解 —— 自然景观不该硬配',
  );
});

test('鸣沙山是沙丘：有骆驼，没有缆车', () => {
  /*
   * Mr.Q：「敦煌鸣沙山，讲道理那不是山，是沙丘，没有缆车只有骆驼」。
   *
   * 它名字里带「山」，一直走 MOUNTAIN 那支 —— 给她排 140 元索道、
   * 50 元下山滑道。这类错不报错，只是**让她说了假话**：
   * 日记里会写「坐索道上去的，缆车在钢索上轻轻晃」，那地方从来没索道。
   *
   * 判据：名字里的地形词不可信。沙丘、戈壁的「山/坡/梁」都不是石头山。
   */
  const opts = spotRideOptions('鸣沙山');
  assert.ok(opts.some((o) => o.how === 'camel'), '鸣沙山没有骆驼选项 —— 那儿只有骆驼');
  assert.ok(
    !opts.some((o) => o.how === 'cableway' || o.how === 'sedan'),
    `鸣沙山被配了索道/滑竿：${opts.map((o) => o.label).join('、')}`,
  );
  /* 沙坡头同理（宁夏中卫）。 */
  assert.ok(
    !spotRideOptions('沙坡头').some((o) => o.how === 'cableway'),
    '沙坡头也被配了缆车',
  );
});

test('真的石头山还得有索道 —— 别修过头', () => {
  for (const spot of ['泰山', '华山', '黄山']) {
    assert.ok(
      spotRideOptions(spot).some((o) => o.how === 'cableway'),
      `${spot} 的索道被误删了`,
    );
  }
});
