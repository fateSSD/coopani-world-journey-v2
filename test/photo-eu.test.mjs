/**
 * 出了国的照片：**别把这座城画成那座城**（2026-11-07，欧洲 37 城之后加）
 *
 * ## 这一批踩到的三件事
 *
 * 1. `streetPrompt` 用价格系数分档（metro / town / county），三档写的全是中国
 *    的街：空调外机、PVC 落水管、共享单车、卷帘门、白瓷砖自建房。
 *    欧洲城市的价格系数全在 1.1 以上 —— 于是**柏林的街会拿到「墙上挂着锈迹
 *    往下流的空调外机」**。
 * 2. `festivalPrompt` 整段是中国的节：红灯笼、青团、粽子、月饼。
 * 3. `foodPrompt` 的窗外按 `month === 1` 判冬天，没管南半球。
 *    布宜诺斯艾利斯一月的一碗面，配的是「窗玻璃上结着水汽、外面白亮的雪光」。
 *
 * 这三条有一个共同的形状：**模板是全球通用的，而世界不是。**
 * 所以守住的方式也只能是这个：**拿一座具体的城，断言画面里没有别处的东西。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { photoPrompt } = await import('../src/photo.ts');
const { CITIES, cityById } = await import('../src/geo/cities.ts');
const { regionOf, seasonLine } = await import('../src/geo/season.ts');

/** 中国街道才有的东西。欧洲的画面里一个都不许出现。 */
const CN_STREET = /空调外机|PVC 落水管|共享单车|卷帘门|外卖电动车|白瓷砖|喷绘布|红灯笼|竹竿晾|电动车/;

test('欧洲的街：不带中国的街头物件', () => {
  const problems = [];
  for (const c of CITIES.filter((x) => x.country !== 'CN')) {
    const t = photoPrompt({
      city: c.name, cityId: c.id, spot: c.spots[0] ?? '', hour: 15, month: 1, day: 9,
      subject: 'street', cityIdx: c.priceIdx,
    });
    const m = CN_STREET.exec(t);
    if (m) problems.push(`${c.name}：出现了「${m[0]}」`);
  }
  assert.deepEqual(problems, [], `出了国还在用中国的街：\n${problems.join('\n')}`);
});

test('欧洲的节：不带中国的节庆物件', () => {
  const problems = [];
  for (const c of CITIES.filter((x) => x.country !== 'CN')) {
    /* 十二月是圣诞集市那一档，最容易串。 */
    const t = photoPrompt({ city: c.name, cityId: c.id, spot: '', hour: 18, month: 12, day: 9, subject: 'festival' });
    const m = /红灯笼|宫灯|剪纸|青团|粽子|月饼|腊肉/.exec(t);
    if (m) problems.push(`${c.name}：出现了「${m[0]}」`);
  }
  assert.deepEqual(problems, [], `出了国还在过中国的节：\n${problems.join('\n')}`);
});

test('中国的街没被改坏 —— 成都还是那套', () => {
  /* 上面两条是「不许有什么」，这条反过来：**中国城市改回去就错了**。 */
  const t = photoPrompt({
    city: '成都', cityId: 'chengdu', spot: '宽窄巷子', hour: 15, month: 6, day: 9,
    subject: 'street', cityIdx: 1.2,
  });
  assert.match(t, /空调外机|共享单车|卷帘门/, `成都的街被换成了欧洲那套：${t.slice(0, 120)}`);
});

test('南半球的季节是反的：布宜诺斯艾利斯一月是盛夏', () => {
  /*
   * `slotOf()` 加了半球翻转，但如果没有城市用到它，这段代码是死的。
   * 这一条和下面那条合起来保证它**真的在跑**。
   */
  const ba = cityById('buenosaires');
  const jan = seasonLine(ba, 1);
  const jul = seasonLine(ba, 7);
  assert.match(jan, /浓绿|晒|无云/, `一月该是盛夏：${jan}`);
  assert.doesNotMatch(jan, /雪|光杆|秃/, `一月被画成了冬天：${jan}`);
  assert.match(jul, /光杆|半秃|冬|灰/, `七月该是冬天：${jul}`);
  assert.notEqual(jan, jul, '一月和七月拿到同一句 —— 半球翻转没生效');
});

test('南半球的吃：一月窗外不该是雪光', () => {
  const jan = photoPrompt({
    /* 2026-11-12：原来钉 20 点。布宜诺斯艾利斯一月日落就在 20:10 ——
       那一刻是黄金时刻（太阳贴着地平线），不是「开窗的盛夏正午」。
       判据换成太阳高度角之后，取 17 点（太阳三十四度）才验得到「夏天开窗」。 */
    city: '布宜诺斯艾利斯', cityId: 'buenosaires', hour: 17, month: 1, day: 12,
    subject: 'food', dish: '烤肉 asado',
  });
  assert.doesNotMatch(jan, /雪光|水汽/, `一月三十度的窗外被画成雪：${jan.slice(0, 160)}`);
  assert.match(jan, /亮得发白|窗开着/, `一月该是开窗的夏天：${jan.slice(0, 160)}`);

  const jul = photoPrompt({
    city: '布宜诺斯艾利斯', cityId: 'buenosaires', hour: 20, month: 7, day: 12,
    subject: 'food', dish: '烤肉 asado',
  });
  assert.notEqual(jan, jul, '一月和七月的吃食照片一样 —— 半球没起作用');
});

test('烤肉不是火锅：菜名分类别把「烤」并进锅里', () => {
  /*
   * 原来 `/火锅|锅|烤|串|烧/` 全进 `hotpot`，于是「布宜诺斯艾利斯的烤肉 asado」
   * 出来是「铸铁锅，汤在翻滚，表面一层橙红厚油」。
   * 「红烧肉」反过来又不能算烤 —— 它真在盘子里。
   */
  const asado = photoPrompt({
    /* 2026-11-12：原来钉 20 点。布宜诺斯艾利斯一月日落就在 20:10 ——
       那一刻是黄金时刻（太阳贴着地平线），不是「开窗的盛夏正午」。
       判据换成太阳高度角之后，取 17 点（太阳三十四度）才验得到「夏天开窗」。 */
    city: '布宜诺斯艾利斯', cityId: 'buenosaires', hour: 17, month: 1, day: 12,
    subject: 'food', dish: '烤肉 asado',
  });
  assert.doesNotMatch(asado, /汤在翻滚/, `烤肉被画成一锅汤：${asado.slice(0, 120)}`);
  assert.match(asado, /铁盘|铁丝网|木板|烤/, `烤肉该在架上或盘上：${asado.slice(0, 120)}`);

  const hongshao = photoPrompt({
    city: '成都', cityId: 'chengdu', hour: 19, month: 6, day: 12, subject: 'food', dish: '红烧肉',
  });
  assert.doesNotMatch(hongshao, /铁丝网|炭火/, `红烧肉被画成了烧烤：${hongshao.slice(0, 120)}`);
});

test('每座国外城市都要有气候区 —— 没有就一句季节都不生成', () => {
  /*
   * 这条是**清单**，不是要求现在就全配。
   *
   * `JOURNEY_SEASON_PENDING` 里是还没轮到批次的城（东京、纽约这些）。
   * 它们属于下一批，配气候区的时候要从这里**删掉**；
   * 而任何一座新加的外国城市，只要不在这里、又没配气候区，就会红。
   *
   * 为什么值得单列一张清单而不是「以后再说」：
   * 2026-11-07 加俄罗斯那天，`regionOf` 对非中国城市返回 null，
   * 于是**摩尔曼斯克一月的照片里树叶是绿的** —— 一句季节都没有，
   * 模型只能自由发挥。那时候也没有任何测试会红。
   */
  /*
   * 2026-11-07 第二批配齐了：这张清单现在是空的。
   * 下一次加外国城市时，要么在 `CLIMATE` 里给它一个区，
   * 要么把它加回这里 —— 两条路都比「一句季节都没有」强。
   */
  const PENDING = new Set([]);

  const missing = CITIES
    .filter((c) => c.country !== 'CN' && !regionOf(c) && !PENDING.has(c.id))
    .map((c) => `${c.country} ${c.name}(${c.id})`);

  assert.deepEqual(missing, [],
    `这些城没配气候区，照片里不会有季节：\n${missing.join('\n')}`);

  /* 反过来：清单里的城如果配上了，就该从清单里删掉 —— 免得清单越积越旧。 */
  const stale = [...PENDING].filter((id) => {
    const c = cityById(id);
    return c && regionOf(c);
  });
  assert.deepEqual(stale, [], `这些城已经配好气候区了，从 PENDING 里删掉：${stale.join(', ')}`);
});
