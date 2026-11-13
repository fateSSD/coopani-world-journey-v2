/**
 * 真名和档次不许打架 —— 第三轮。
 *
 * 0.9.5 修了「61 元的宾馆报成五星级」，0.9.6 修了「分店名里的地名骗过关键词」。
 * 2026-11-07 用 Mr.Q 本机缓存里的真实高德 POI（成都、天水各 24 家）再跑一遍，
 * 又抓出三类：
 *
 *   成都 五星档 → OYO七里香大酒店(站北东街店)   ← 经济连锁，靠「大酒店」三个字混进来
 *   成都 便宜档 → 金河宾馆大堂                  ← 大堂，不是酒店
 *   成都 景观档 → 博瑞花园酒店宴会厅 / 太成宾馆  ← 宴会厅；数据标了「景观」但名字是宾馆
 */
const { pickHotel, contradictsTier } = await import('../src/geo/hotels.ts');
const assert = (await import('node:assert/strict')).default;
const { test } = await import('node:test');

/** 每次挑 200 次，把结果收成集合。 */
function picks(items, tier, n = 200) {
  const s = new Set();
  for (let i = 0; i < n; i++) {
    const p = pickHotel(items, tier, Math.random);
    if (p) s.add(p.name);
  }
  return s;
}

test('经济连锁进不了五星档 —— OYO 不是靠「大酒店」三个字就能当五星', () => {
  const items = [
    { name: 'OYO七里香大酒店(站北东街店)', cost: 120 },
    { name: '7天酒店(成都春熙路店)', cost: 150 },
  ];
  assert.equal(pickHotel(items, 'luxury', Math.random), null, '便宜连锁被挑成了五星级');
});

test('附属设施不算酒店 —— 大堂、宴会厅、停车场一概不出现在任何一档', () => {
  const items = [
    { name: '金河宾馆大堂', cost: 60 },
    { name: '博瑞花园酒店宴会厅', cost: 300 },
    { name: '某某酒店停车场', cost: 0 },
  ];
  for (const tier of ['luxury', 'view', 'budget', 'dingy']) {
    assert.equal(pickHotel(items, tier, Math.random), null, `${tier} 档挑到了附属设施`);
  }
});

test('数据说它是景观档，但名字是「宾馆」—— 名字赢', () => {
  const items = [{ name: '太成宾馆', cost: 300, tier: 'view' }];
  assert.equal(pickHotel(items, 'view', Math.random), null, '宾馆挂上了景观房');
  assert.equal(contradictsTier('太成宾馆', 'view'), true);
});

test('正常的池子照旧能挑 —— 不能因为收紧就一间都挑不出来', () => {
  const items = [
    { name: '青城山知宽私汤温泉度假酒店', cost: 900, tier: 'view' },
    { name: '万峰酒店', cost: 500 },
    { name: '如家酒店·neo(成都春熙路新南门地铁站店)', cost: 180 },
    { name: '成都万兴宾馆', cost: 80, tier: 'dingy' },
  ];
  const view = picks(items, 'view');
  assert.ok([...view].every((n) => !/如家|万兴宾馆/.test(n)), `景观档混进了便宜店：${[...view].join('、')}`);
  assert.ok(view.size > 0, '景观档一间都挑不出来');

  const budget = picks(items, 'budget');
  assert.ok(budget.size > 0, '便宜档一间都挑不出来');
  assert.ok([...budget].every((n) => !/温泉|度假/.test(n)), `便宜档混进了度假店：${[...budget].join('、')}`);
});

test('同一个池子反复挑，五星档不会只出同一家', () => {
  const items = [
    { name: '锦江宾馆', cost: 800, tier: 'luxury' },
    { name: '成都香格里拉大酒店', cost: 1200, tier: 'luxury' },
    { name: '成都华尔道夫酒店', cost: 1600, tier: 'luxury' },
  ];
  const s = picks(items, 'luxury', 120);
  assert.ok(s.size >= 2, `五星档只有一家可选：${[...s].join('、')}`);
});
