/**
 * 2026-11-07 的一次人工核实（携程 / 当地文旅局 / 政府门户 / 景区官网），
 * 把查出来的错钉在这里。**每一条都对应一个真实被查错的条目**，
 * 不是凭感觉写的断言。
 */
const { cityById } = await import('../src/geo/cities.ts');
const { pickHotel } = await import('../src/geo/hotels.ts');
const assert = (await import('node:assert/strict')).default;
const { test } = await import('node:test');

const monthsOf = (id, kw) => {
  const f = (cityById(id).festivals ?? []).find((x) => x.name.includes(kw));
  return f ? f.months : null;
};
const spotNames = (id) => cityById(id).spots.map((s) => s.split('：')[0]);

test('节日月份：农历节日的公历窗口不能只写一个月', () => {
  /* 泉州元宵灯会 2026 年是 3 月 1—8 日（正月十三到二十），只写 2 月会漏掉整场。 */
  assert.deepEqual(monthsOf('quanzhou', '元宵'), [2, 3]);
  /* 拗九节是正月廿九，公历在 2—3 月之间浮动，不是年年 3 月。 */
  assert.deepEqual(monthsOf('fuzhou', '拗九'), [2, 3]);
});

test('节日月份：开园期比「节日当天」长', () => {
  /* 西安城墙灯会 2026.1.1—3.22，只写 1、2 月会漏掉三月整月。 */
  assert.ok(monthsOf('xian', '灯会').includes(3), '三月还在展，应该算');
  /* 大连啤酒嘉年华 7.17—8.2，跨月。 */
  assert.deepEqual(monthsOf('dalian', '啤酒'), [7, 8]);
});

test('常德河街的非遗在三月，不是六月', () => {
  const f = (cityById('changde').festivals ?? []).find((x) => x.name.includes('非遗'));
  assert.ok(f, '常德的非遗活动不见了');
  assert.deepEqual(f.months, [3], `核实结论是三月整月，现在是 ${f.months.join('/')} 月`);
});

test('景点：查不实的条目已经换成真的', () => {
  const lz = spotNames('liuzhou');
  assert.ok(!lz.some((n) => n.includes('融水苗寨')), '「融水苗寨」查无此景区');
  assert.ok(lz.some((n) => n.includes('雨卜苗寨')), '应该换成融水雨卜苗寨');
  assert.ok(!lz.some((n) => n.includes('五星商业街')), '五星商业街是商圈，不是景点');

  const cd = spotNames('chengde');
  assert.ok(!cd.some((n) => n === '外八庙'), '外八庙是寺庙群统称，没有这张门票');
  assert.ok(cd.some((n) => n.includes('普乐寺')), '应该落到一座具体的寺');

  const changde = spotNames('changde');
  assert.ok(changde.some((n) => n.includes('壶瓶山大峡谷')), '开放的是大峡谷，主峰在保护区');
});

test('酒店：景观房必须真的沾景观', () => {
  /* 携程核实：万峰酒店是经济型（¥118，住宅楼里的公寓式），绿洲大酒店是市区 4 钻商务。
     高德把两家都标成「景观」，但名字里没有任何景观词。 */
  const pool = [
    { name: '万峰酒店', cost: null, tier: 'view' },
    { name: '绿洲大酒店', cost: null, tier: 'view' },
    { name: '青城山知宽私汤温泉度假酒店', cost: null, tier: 'view' },
  ];
  assert.equal(pickHotel([{ name: '万峰酒店', tier: 'view' }], 'view', Math.random), null);
  assert.equal(pickHotel([{ name: '绿洲大酒店', tier: 'view' }], 'view', Math.random), null);
  const ok = pickHotel(pool, 'view', Math.random);
  assert.ok(ok && /温泉/.test(ok.name), `景观档挑到了不沾景观的店：${ok?.name}`);
});

test('酒店：五星档不接收经济型连锁与「XX 宾馆」', () => {
  for (const name of ['OYO七里香大酒店(站北东街店)', '锦江之星(成都春熙路店)', '太成宾馆']) {
    assert.equal(pickHotel([{ name }], 'luxury', Math.random), null, `${name} 混进了五星档`);
  }
});

/* ---------------- 2026-11-07 第二次全量核实（20 批子 agent） ---------------- */

test('农历节日的公历窗口：火把节、三月街、首尔灯节', () => {
  /* 火把节是农历六月廿四，公历只会落在 7—8 月，6 月从不举办。 */
  assert.deepEqual(monthsOf('lijiang', '火把节'), [7, 8]);
  /* 三月街是农历三月十五起七天，2026 年落在 5/1—5/7。 */
  assert.deepEqual(monthsOf('dali', '三月街'), [4, 5]);
  /* 首尔灯节近三届都在 12 月开幕、跨到次年 1 月。 */
  assert.deepEqual(monthsOf('seoul', '灯节'), [12, 1]);
});

test('类型错：行政区、商圈、泛指都不是景点', () => {
  assert.ok(!spotNames('xinxiang').includes('牧野区'), '牧野区是行政区');
  assert.ok(spotNames('xinxiang').some((n) => n.includes('牧野公园')));
  assert.ok(!spotNames('zhangjiajie').includes('武陵源的小吃摊'));
  assert.ok(!spotNames('chengdu').some((n) => n === '玉林路'), '成都没有玉林路');
  assert.ok(spotNames('chengdu').some((n) => n.includes('玉林西路')));
  assert.ok(!spotNames('xianggelila').some((n) => n.includes('手工艺摊')));
});

test('归属错：跑出几百公里的要标出来', () => {
  assert.ok(spotNames('kashi').some((n) => n.includes('阿克陶')), '喀拉库勒湖在阿克陶县');
  assert.ok(spotNames('hanoi').some((n) => n.includes('广宁省')), '下龙湾在广宁省');
  assert.ok(spotNames('grandcanyon').some((n) => n.includes('西缘')), '天空步道在西缘');
  assert.ok(!spotNames('grandcanyon').includes('日落点'), '南缘没有「日落点」');
  assert.ok(spotNames('merida').every((n) => !n.includes('图卢姆')), '图卢姆隔着整个半岛');
});

test('改名与数字：甘海子、香妃墓、黑沙海滩、圣母教堂塔高', () => {
  assert.ok(spotNames('jiuzhaigou').some((n) => n.includes('爱情海')), '甘海子已改名爱情海');
  assert.ok(spotNames('kashi').some((n) => n.includes('香妃园')));
  assert.ok(spotNames('aomen').includes('黑沙海滩'));
  const bruges = cityById('bruges');
  assert.ok(bruges.spots.some((s) => s.includes('115.5 米')), '圣母教堂塔高是 115.5 米');
  assert.ok(!bruges.spots.some((s) => s.includes('122 米')), '122 米是攻略里的错数');
});
