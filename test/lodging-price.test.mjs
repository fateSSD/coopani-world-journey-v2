/**
 * 房价要对得上现实 —— 2026-11-07 用户发的两张截图
 *
 * 图一：他在携程搜「东晨宾馆滦河桥路店」，标价 **61 元/晚，经济型，2 星**。
 * 图二：她的面板写着「东晨宾馆（五龙桥路店）**（五星级酒店）980**」。
 *
 * 拆开是三个错：
 *   1. **档次**：一家「宾馆」被挂到 `luxury` 档上（`pickHotel` 的兜底把
 *      高德没表态的店一律捞进池子，名字里的「宾馆」没人看）。
 *   2. **价格**：980 是「五星级」的基准价，而承德的现实是
 *      挂牌五星平日 224–350、平台五星 490–560、旺季 700–1000。
 *   3. **国外**：池子已经是当地实价（人民币），却又乘了一遍 `priceIdx`
 *      （巴黎 5.5、纽约 11.1）—— 巴黎一间家庭旅馆算出来 1430 元，真实是 500–800。
 *
 * 这里守的是「落到数字上对不对」：用几个已知城市的真实价当标尺。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { cityById } = await import('../src/geo/cities.ts');
const { rollLodging, withHotel, abroadFactor } = await import('../src/plan/lodging.ts');
const { pickHotel, contradictsTier } = await import('../src/geo/hotels.ts');

/**
 * 这一档在这座城掷出来的价格区间（各掷 300 次）。
 *
 * `only` 用来把范围收到某一条房型上 —— 同一档里「青年旅舍六人间」和
 * 「连锁经济酒店」差一倍，混在一起算区间是没有意义的。
 */
function rangeOf(cityId, tier, only) {
  const c = cityById(cityId);
  const ps = [];
  for (let i = 0; i < 400; i++) {
    const l = rollLodging(Math.random, false, c.priceIdx, true, c.country !== 'CN');
    if (l.tier === tier && (!only || only.test(l.kind))) ps.push(l.price);
  }
  return ps.length ? [Math.min(...ps), Math.max(...ps)] : null;
}

test('五星级不再按「上海均价」当全国基准', () => {
  /*
   * 文旅部 2024Q3：全国重点城市五星 ADR 661，北京 899、上海 949、广州 720。
   * 基准 980 再乘一线系数 1.9–2.5，北京要报 1960 —— 那是旺季套房，不是标间。
   */
  const [bjLo, bjHi] = rangeOf('beijing', 'luxury', /五星级/);
  assert.ok(bjLo >= 600 && bjHi <= 1800, `北京的五星级落在 ${bjLo}–${bjHi}，超出一线平季 750–1300 太多`);

  const [tsLo, tsHi] = rangeOf('tianshui', 'luxury', /五星级/);
  assert.ok(tsHi <= 1000, `天水（县城系数）的五星档到 ${tsHi} 元，县城不该有这个价`);
});

test('承德：五星级不该报到 980', () => {
  /*
   * 承德唯一挂牌五星是嘉和国际饭店，平日 224–350；平台标五星的兆丰、万达嘉华
   * 490–560；旺季 700–1000。原来 980 属于「旺季山庄内园林酒店」那一档。
   */
  const c = cityById('chengde');
  const ps = [];
  for (let i = 0; i < 200; i++) {
    const l = rollLodging(Math.random, false, c.priceIdx, true, false);
    if (l.tier === 'luxury' && l.kind === '五星级酒店') ps.push(l.price);
  }
  assert.ok(ps.length, '承德掷不出五星级？池子不该空');
  assert.ok(Math.max(...ps) < 900, `承德「五星级酒店」报到 ${Math.max(...ps)} 元，高于挂牌五星的旺季价`);
});

test('国外的池子不乘第二遍系数：巴黎的家庭旅馆 400–900，青旅床位 200–350', () => {
  const [hoLo, hoHi] = rangeOf('paris', 'budget', /家庭旅馆/);
  assert.ok(hoLo >= 400 && hoHi <= 900, `巴黎的家庭旅馆落在 ${hoLo}–${hoHi}，真实是 500–800`);

  const [dpLo, dpHi] = rangeOf('paris', 'budget', /青年旅舍/);
  assert.ok(dpLo >= 180 && dpHi <= 400, `巴黎的青旅床位落在 ${dpLo}–${dpHi}，真实是 230–330`);
});

test('纽约可以贵，但不能贵十倍', () => {
  const [lo, hi] = rangeOf('newyork', 'luxury', /老牌大酒店|设计酒店/);
  assert.ok(lo >= 1500 && hi <= 4000, `纽约的高档房落在 ${lo}–${hi}，真实是 2000–3500`);
});

test('布拉格比巴黎便宜、东京比布拉格贵 —— 相对关系要对', () => {
  const prague = rangeOf('prague', 'budget');
  const paris = rangeOf('paris', 'budget');
  const tokyo = rangeOf('tokyo', 'budget');
  assert.ok(prague[0] < paris[0], `布拉格（${prague[0]}）不比巴黎（${paris[0]}）便宜，系数不对`);
  assert.ok(tokyo[0] > prague[0], `东京（${tokyo[0]}）不比布拉格（${prague[0]}）贵，系数不对`);
});

test('abroadFactor 落在合理区间，且单调', () => {
  assert.equal(Math.round(abroadFactor(5.5) * 100), 100); // 巴黎 = 1.0（基准就是西欧）
  assert.ok(abroadFactor(2.0) > 0.5 && abroadFactor(2.0) < 0.65); // 布拉格
  assert.ok(abroadFactor(11.1) <= 1.6); // 纽约截顶
  assert.ok(abroadFactor(0.8) >= 0.32); // 河内兜底
  assert.ok(abroadFactor(3) < abroadFactor(4));
});

/* ------------------------------------------------------------------ 那个截图本身 */

const POIS = [
  { name: '宽城东晨宾馆', address: '宽城县瀑河桥路', cost: 61 },
  { name: '承德嘉和国际饭店', address: '双桥区迎宾路 23 号', cost: 300 },
  { name: '承德兆丰国际酒店', address: '双桥区迎宾路 57 号', cost: 500 },
];

test('五星档不会挑中「宾馆」—— 那两张截图的第一层错误', () => {
  for (let i = 0; i < 50; i++) {
    const pick = pickHotel(POIS, 'luxury', Math.random);
    assert.ok(!pick || !pick.name.includes('宾馆'), `五星档挑到了 ${pick?.name}`);
  }
});

test('withHotel 最后一道闸：宾馆不挂五星', () => {
  const base = { tier: 'luxury', kind: '五星级酒店', price: 620, feel: '' };
  const out = withHotel(base, [{ name: '宽城东晨宾馆', address: '', cost: 61 }], Math.random, 1, false);
  assert.equal(out.name, undefined, `还是把宾馆挂上去了：${out.name}`);
  assert.equal(out.price, 620, '没挂名字时价格不该变');
});

test('contradictsTier：四个档次的反向词各自管用', () => {
  assert.equal(contradictsTier('东晨宾馆', 'luxury'), true);
  assert.equal(contradictsTier('嘉和国际饭店', 'luxury'), false);
  assert.equal(contradictsTier('承德避暑山庄大酒店', 'dingy'), true);
  assert.equal(contradictsTier('站前招待所', 'view'), true);
  assert.equal(contradictsTier('汉庭酒店', 'budget'), false);
});

/* ------------------------------------------------------------------ 分店名污染 */

test('分店名里的地名不算住宿类型：如家快捷不该进景观档', () => {
  /*
   * 2026-11-07 实测抓到的第二个错：承德的
   * 「如家快捷酒店(承德避暑山庄店)」被挂到 `view` 档，显示成
   * 「高档商务酒店 560」—— 因为名字里有「避暑山庄」，命中了「山庄」这个度假关键词。
   *
   * 括号里跟的是**地名**，不是住宿类型。`pickHotel` 现在先剥掉再匹配。
   */
  const pois = [
    { name: '如家快捷酒店(承德避暑山庄店)', cost: 190 },
    { name: '承德宾馆（避暑山庄店）', cost: 260 },
  ];
  assert.equal(pickHotel(pois, 'view', Math.random), null,
    '只有快捷酒店和宾馆的池子里，view 档应该返回 null，而不是硬配');

  /* 这两家都该乖乖待在 budget：主名里有「快捷」「宾馆」。 */
  for (let i = 0; i < 40; i++) {
    const p = pickHotel(pois, 'budget', Math.random);
    assert.ok(p && /快捷|宾馆/.test(p.name), `budget 挑错人了：${p?.name}`);
  }
});

test('主名判定：括号和破折号后面的地名不当关键词', () => {
  assert.equal(contradictsTier('如家快捷酒店(承德避暑山庄店)', 'view'), true);
  assert.equal(contradictsTier('承德宾馆（避暑山庄店）', 'luxury'), true);
  assert.equal(contradictsTier('维也纳国际酒店 - 火车站店', 'luxury'), false);
  assert.equal(contradictsTier('东晨宾馆（瀑河桥路店）', 'luxury'), true);
});

test('承德这一池子：五星档只会落在那两家真酒店上', () => {
  const pois = [
    { name: '宽城东晨宾馆（瀑河桥路店）', cost: 61 },
    { name: '承德嘉和国际饭店', cost: 300 },
    { name: '承德兆丰国际酒店', cost: 520 },
    { name: '承德宾馆（避暑山庄店）', cost: 260 },
    { name: '如家快捷酒店(承德避暑山庄店)', cost: 190 },
  ];
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const p = pickHotel(pois, 'luxury', Math.random);
    if (p) seen.add(p.name);
  }
  assert.deepEqual([...seen].sort(), ['承德兆丰国际酒店', '承德嘉和国际饭店'],
    `五星档挑到了不该挑的：${[...seen].join('、')}`);
});

/* ---------------------------------------------------------------- 真实数据校正 */

/** 确定性随机源 —— 这个文件原来没有，新加的两条要用。 */
const lcg = (seed) => {
  let x = seed >>> 0;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
};


test('真实数据：县城「大酒店」不许进五星档（TourMind / 携程核过）', () => {
  /*
   * 2026-11-09 Mr.Q 的截图：「汝阳轩源大酒店（温泉度假酒店）· 1350」，
   * 房间里还带私汤。他去携程查同一家店：**二钻、2020 年开业、经济双床房 92 元**。
   *
   * 下面这些价格和星级都是当天用 TourMind 和携程核出来的实价：
   *
   * | 店 | 实价 | 星级 |
   * |---|---|---|
   * | 汝阳轩源大酒店（洛阳汝阳） | 92 | 二钻 |
   * | 启政大酒店（洛阳龙门高铁站） | 167.9 | 2 星 |
   * | 洛阳中和大酒店（大学城店） | 145.72 | 3 星 |
   * | 承德兆丰国际酒店 | 520 | 5 星 |
   *
   * 判据：**「大酒店」这三个字跟档次无关**，中国县城十个里有八个这么叫。
   * 没价格、没星级、没品牌时，宁可不挂名字。
   */
  const county = [
    { name: '汝阳轩源大酒店', cost: null, rating: '4.5' },
    { name: '启政大酒店(洛阳龙门高铁站市政府新区店)', cost: null, rating: '4.3' },
    { name: '洛阳中和大酒店(洛阳高铁龙门站大学城店)', cost: null, rating: '4.1' },
  ];
  assert.equal(pickHotel(county, 'luxury', Math.random), null,
    '县城「大酒店」被挑进五星档了 —— 这就是「汝阳轩源」那次的错');

  /* 同城的真五星：有实价 520，必须还能挑到。 */
  const withReal = [...county, { name: '承德兆丰国际酒店', cost: 520 }];
  const got = new Set();
  for (let i = 0; i < 60; i++) {
    const p = pickHotel(withReal, 'luxury', Math.random);
    if (p) got.add(p.name);
  }
  assert.deepEqual([...got], ['承德兆丰国际酒店'], `挑到了不该挑的：${[...got].join('、')}`);
});

test('挂了真名之后，不许再许诺温泉/泳池/私汤', async () => {
  /*
   * 同一次事故的另一半：「温泉度假酒店」是**类别**，本来指「她今晚住的这一类地方」。
   * 一旦前面挂上真实店名，每个字都变成对那家店的承诺 —— 而它到底有没有温泉，
   * 我们根本不知道。汝阳轩源那家的设施清单只有餐厅和停车场。
   */
  const { withHotel, rollLodging } = await import('../src/plan/lodging.ts');
  const pois = [{ name: '承德兆丰国际酒店', cost: 520, address: '迎宾路57号' }];
  const FACILITY = /温泉|泳池|私汤|SPA|水疗|私汤|行政酒廊|大堂/;

  /* 各种档位都试一遍：只要挂上了名字，描述里就不许出现设施。 */
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const base = rollLodging(lcg(seed), false, 1, true, false, undefined);
    const h = withHotel(base, pois, lcg(seed + 100), 1);
    if (!h.name) continue; // 这一档没挂上真名，跳过
    assert.doesNotMatch(h.kind, FACILITY, `类别里带设施：${h.kind}`);
    assert.doesNotMatch(h.feel, FACILITY, `体感里带设施：${h.feel}`);
  }
});

test('不挂真名时描述保持不变 —— 那是「这一类地方」，可以有想象', async () => {
  /*
   * 反过来的边界：没挂真名时，说「这类地方有温泉」不算骗 ——
   * 那是她对今晚住处的预期，不是对某家具体酒店的承诺。
   * 这条守住「改过头」：把没挂名的描述也削平，就变成另一种单调。
   */
  const { withHotel, rollLodging } = await import('../src/plan/lodging.ts');
  const base = rollLodging(lcg(3), false, 1, true, false, undefined);
  const h = withHotel(base, [], lcg(7), 1);
  assert.equal(h.name, undefined, '空池子不该挂出名字');
  assert.equal(h.kind, base.kind, '没挂名却改了类别');
  assert.equal(h.feel, base.feel, '没挂名却改了体感');
});
