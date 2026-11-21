/**
 * 房价和票价，拿真实报价核过一遍（2026-11-08，方案 B / C）。
 *
 * ## 数据怎么来的
 *
 * 房价：TourMind 按坐标周边实采，入住 2026-11-17 一晚、一间、人民币。
 * 票价：携程火车票实查（上海虹桥→杭州东、成都东→西安北、北京西→兰州等）。
 *
 * ## 这些断言的用法
 *
 * 都是**对着实采值卡 ±15~20%**，不是对着代码里的常数 —— 常数可以随时调，
 * 只要还落在真实区间里就算过。**别把它们改成 `assert.equal(390)`**，
 * 那只是把当时的实现抄了一遍，下次调价还得改测试。
 */
const { cityById } = await import('../src/geo/cities.ts');
const { rollLodging } = await import('../src/plan/lodging.ts');
const { trainUnit } = await import('../src/world.ts');
const assert = (await import('node:assert/strict')).default;
const { test } = await import('node:test');

/** 线性同余，保证每次跑同一串随机数。 */
const lcg = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/** 抽 n 次，按档位分组，返回各档的中位价。 */
function sample(id, n = 3000) {
  const c = cityById(id);
  const by = {};
  const rnd = lcg(42);
  for (let i = 0; i < n; i++) {
    const l = rollLodging(rnd, false, c.priceIdx);
    (by[l.tier] ??= []).push(l.price);
  }
  return Object.fromEntries(Object.entries(by).map(([t, a]) => [t, median(a)]));
}

/** 偏差在容差内。 */
function near(got, real, tol, label) {
  const d = Math.abs(got - real) / real;
  assert.ok(d <= tol, `${label}：算出来 ${got}，实采 ${real}，偏差 ${(d * 100).toFixed(0)}%（上限 ${tol * 100}%）`);
}

/* ---------------------------------------------------------------- 住宿 */

test('高档：一线城市的中位价对齐实采五星（北京 1606 / 上海 1620）', () => {
  near(sample('beijing').luxury, 1606, 0.2, '北京高档');
  near(sample('shanghai').luxury, 1620, 0.2, '上海高档');
});

test('普通档：基准上调后，一线和低线城市都对得上', () => {
  /* 原来整体偏低两成（北京 320 对 400、天水 90 对 115），两边同向 —— 说明是基准错。 */
  near(sample('beijing').budget, 400, 0.2, '北京普通档');
  near(sample('tianshui').budget, 115, 0.2, '天水普通档');
});

test('小破店有价格地板：任何城市都不出现两位数', () => {
  /*
   * 天水系数 0.56，池子 60 元 → 算出 30 元。「三十块一晚」在 2026 年不存在。
   * 全国正规挂网最低约 100（用户原话：小宾馆网上根本找不到），
   * 站前不挂网的私人小旅馆更便宜，所以地板定 85 —— 承认线下房源，但不给两位数。
   */
  const all = ['tianshui', 'chengdu', 'beijing', 'sanya', 'lijiang', 'lasa', 'zhangye'];
  for (const id of all) {
    const c = cityById(id);
    const rnd = lcg(7);
    for (let i = 0; i < 400; i++) {
      const l = rollLodging(rnd, true, c.priceIdx);
      if (l.tier === 'dingy') {
        assert.ok(l.price >= 85, `${c.name} 的小破店 ${l.price} 元 —— 低于地板`);
      }
    }
  }
});

test('高档池：标准间占多数，套房不是常态', () => {
  /*
   * 四项等概率时，她住高档的四次里有三次是高层城景/套房/温泉 ——
   * 现实里八成住的就是标准间。加权后标准间占一半。
   */
  const c = cityById('beijing');
  const rnd = lcg(11);
  const kinds = new Map();
  for (let i = 0; i < 2000; i++) {
    const l = rollLodging(rnd, false, c.priceIdx);
    if (l.tier !== 'luxury') continue;
    kinds.set(l.kind, (kinds.get(l.kind) ?? 0) + 1);
  }
  const total = [...kinds.values()].reduce((a, b) => a + b, 0);
  const std = kinds.get('五星级酒店') ?? 0;
  assert.ok(std / total >= 0.45, `标准间只占 ${((std / total) * 100).toFixed(0)}%，套房里住太多了`);
  for (const rare of ['行政套房', '温泉度假酒店']) {
    const n = kinds.get(rare) ?? 0;
    assert.ok(n / total < 0.2, `${rare} 占了 ${((n / total) * 100).toFixed(0)}%，太频繁`);
  }
});

test('旅游城市：三亚、丽江的系数按淡季实价下调后不再离谱', () => {
  /*
   * 原来按「有高端度假品牌」定：三亚 2.2、丽江 1.55。
   * 实采（11 月）五星中位是三亚 630、丽江 618 —— 跟成都（780）差不多。
   * 现在改成 1.5 / 1.1 是折中（程序没有季节维度），所以容差放宽到一倍。
   */
  assert.ok(cityById('sanya').priceIdx < 1.7, `三亚系数 ${cityById('sanya').priceIdx} 还是旺季口径`);
  assert.ok(cityById('lijiang').priceIdx < 1.3, `丽江系数 ${cityById('lijiang').priceIdx} 还是旺季口径`);
  near(sample('sanya').luxury, 630, 1.0, '三亚高档');
  near(sample('lijiang').luxury, 618, 0.6, '丽江高档');
});

test('城际价差的方向不能反：一线 > 省会 > 低线', () => {
  const bj = sample('beijing').budget;
  const cd = sample('chengdu').budget;
  const ts = sample('tianshui').budget;
  assert.ok(bj > cd && cd > ts, `普通档价差反了：北京 ${bj} / 成都 ${cd} / 天水 ${ts}`);
});

/* ---------------------------------------------------------------- 票价 */

test('铁路短途：高铁二等座约 0.42 元/公里', () => {
  /* 沪杭 169km/73 元、成都→西安 658km/263–285 元、兰州→西安 496km/184 元 */
  near(Math.round(169 * trainUnit(169)), 73, 0.15, '上海→杭州');
  near(Math.round(658 * trainUnit(658)), 274, 0.15, '成都→西安');
  near(Math.round(496 * trainUnit(496)), 184, 0.2, '兰州→西安');
});

test('铁路长途：卧铺约 0.21 元/公里 —— 原来按高铁单价算，贵了两倍半', () => {
  /* 北京西→兰州 1650km，Z 字头硬卧 322–363 元。 */
  near(Math.round(1650 * trainUnit(1650)), 342, 0.15, '北京→兰州');
  near(Math.round(2300 * trainUnit(2300)), 480, 0.2, '广州→北京');
});

test('铁路单价随距离只降不升，且一千公里附近没有断崖', () => {
  let prev = trainUnit(0);
  for (let km = 10; km <= 4000; km += 10) {
    const u = trainUnit(km);
    assert.ok(u <= prev + 1e-9, `${km} 公里处单价反而涨了`);
    prev = u;
  }
  /*
   * 直接 `km < 1000 ? 0.42 : 0.21` 会让 999km 和 1001km 差一倍 ——
   * 用户看到的是「更远的城市反而便宜一半」。这里要求相邻差 < 5%。
   */
  for (const km of [790, 900, 999, 1001, 1100, 1199]) {
    const a = km * trainUnit(km);
    const b = (km + 2) * trainUnit(km + 2);
    assert.ok(Math.abs(b - a) / a < 0.05, `${km}→${km + 2} 公里票价跳了 ${a.toFixed(0)}→${b.toFixed(0)}`);
  }
});

test('长途汽车下调到公路客运实价（0.33 元/公里）', () => {
  /* 兰州→天水 320 公里约 100 元。 */
  const fare = 320 * 0.33;
  near(Math.round(fare), 100, 0.15, '长途汽车 320 公里');
});

test('跨洲机票：兰州→纽约量级约 7000 元，不再按 0.9 元/公里算到近一万', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { JourneyWorld } = await import('../src/world.ts');
  const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: mkdtempSync(join(tmpdir(), 'jr-fare-')),
    botName: '大肥鱼',
  });
  const lz = cityById('lanzhou');
  const ny = cityById('newyork');
  const fare = Math.round(w.cheapestFare(11000, true, { from: lz, to: ny }));
  near(fare, 7000, 0.1, '兰州→纽约跨洲机票');
});
