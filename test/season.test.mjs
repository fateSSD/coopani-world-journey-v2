/**
 * 季节 × 地域的视觉修正 —— 2026-11-07
 *
 * Mr.Q 发来一张承德的图：零下二度，画面是「红灯笼 + 绿柳 + 湿石板路 + 白墙黑瓦」——
 * 江南水乡的意象。查下来视觉锚点是全的（128/128），锚点也写了「园林湖面开阔、古松成片」。
 *
 * 缺的是**一句「现在是冬天」**。模型只拿到「承德 + 湖 + 园林」，一联想就到江南了。
 *
 * 这组测试守三件事：
 *   1. 该冷的冷（承德冬天不能说成绿柳水巷）
 *   2. 不该冷的别冷（三亚不说羽绒、江南不说齐膝雪）
 *   3. 数据里的句子能原样进提示词（没有 markdown、没有双句号）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { photoPrompt } = await import('../src/photo.ts');
const { seasonLine, regionOf } = await import('../src/geo/season.ts');

/* 第 5 个参数是纬度 —— 南半球的季节是反的，不给就算北纬 45 度。 */
const C = (id, city, region, country = 'CN', lat = 45) => ({ id, city, region, country, lat });

test('承德十一月：说清是北方皇家园林，不是江南水乡', () => {
  const t = photoPrompt({
    city: '承德', cityId: 'chengde', spot: '避暑山庄', hour: 15, month: 11, day: 7, weather: '晴',
  });
  assert.match(t, /不是江南水乡/, '没有把「这里不是江南」说出口，模型就会往江南跑');
  assert.match(t, /青砖/, '没写墙是青砖 —— 白墙黑瓦就是这么来的');
  assert.match(t, /冰/, '十一月末湖面已经冻了，没写');
  assert.match(t, /冻成灰白冰板|冰板/, '湖面状态没写具体');
  assert.match(t, /枯荷/, '冰上的枯荷梗是这个季节最有辨识的一笔');
  /* 「红灯笼」是春节庙会才有，非节庆出现在画面里就是错的 */
  assert.doesNotMatch(t, /红灯笼/, '凭空多出红灯笼');
});

test('承德夏天不该套冬天的句子', () => {
  const t = photoPrompt({
    city: '承德', cityId: 'chengde', spot: '避暑山庄', hour: 10, month: 7, day: 7,
  });
  assert.doesNotMatch(t, /冰板|枯荷|青砖灰调/, `七月不该出现冬天的画面：${t.slice(0, 120)}`);
});

test('江南冬天是对的，别拿北方那套去改它', () => {
  const t = photoPrompt({
    city: '苏州', cityId: 'suzhou', spot: '拙政园', hour: 15, month: 1, day: 7,
  });
  assert.match(t, /石板/, '江南冬天的湿石板反光是对的，不该被抹掉');
  /*
   * 挡北方的雪**靠正面描述，不靠否定句**。
   * 生图模型经常把「没有积雪」读成「积雪」——所以要断言的是「画面里没有北方的元素」，
   * 而不是「提示词里有没有写『没有雪』」。
   */
  assert.doesNotMatch(t, /雪泥|冰板|暖气白汽|阔叶全秃/, `江南被套上了北方的冬天：${t.slice(0, 200)}`);
});

test('三亚一月不说羽绒，华南不做北方的账', () => {
  const t = photoPrompt({ city: '三亚', cityId: 'sanya', spot: '亚龙湾', hour: 14, month: 1, day: 7 });
  assert.doesNotMatch(t, /羽绒/, `三亚一月说羽绒是错的：${t.slice(0, 160)}`);
  assert.match(t, /短袖/, '一月三亚该是短袖');
});

test('成都冬天要画出灰白的天，不能给蓝天阳光', () => {
  const t = photoPrompt({ city: '成都', cityId: 'chengdu', spot: '宽窄巷子', hour: 14, month: 12, day: 7 });
  assert.match(t, /灰白/, '川渝冬天日照极少，画面基调是灰白的');
  /*
   * 2026-11-12 改：这一条原来钉的是「看不见蓝天 / 没有太阳」两句**否定句**，
   * 而否定句在生图模型上常被读成强调 —— 写「没有蓝天」等于把蓝天塞给它。
   * 现在由 `skyLine` 用正面的话说（「天是一整片灰白的云」），
   * 断言改成：基调是灰的，而且**不许出现蓝天和阳光**。
   */
  assert.doesNotMatch(t, /蓝调时刻|饱和的蓝|日光偏亮|暖光/, `成都冬天给画成晴天了：${t}`);
});

test('没查过的地方不加季节 —— 编一个比不说更糟', () => {
  /*
   * 2026-11-07 改过两次，这条守的规矩一直没变：
   * **没查过的地方，宁可一句不说，也不能硬套。**
   *
   * 起初钉的是巴黎（那时只有俄波有气候区）；后来欧洲查过一轮，换成纽约；
   * 现在第二批把日韩、东南亚、北美、中美、中东全配齐了 —— 世界上已经没有
   * 「没查过」的真城，所以只能拿一座**不存在的城**来守这条。
   */
  assert.equal(regionOf(C('atlantis', '某城', 'XX', 'XX')), null);
  const t = photoPrompt({ city: '某城', cityId: 'atlantis', spot: '海边', hour: 14, month: 1, day: 7 });
  assert.doesNotMatch(t, /阔叶|雪泥|冰板|梅雨|三角梅|草地和常绿灌木/,
    `没查过的地方被套了别处的季节：${t.slice(0, 160)}`);
});

test('纽约配上了气候区：一月是雪，不是空白', () => {
  /* 第二批（2026-11-07）：纽约归中欧大陆性 —— 落尽、雪能留几天。 */
  assert.equal(regionOf(C('newyork', '纽约', 'US', 'US', 40.7)), 'centralEurope');
  const t = photoPrompt({ city: '纽约', cityId: 'newyork', spot: '中央公园', hour: 14, month: 1, day: 7 });
  assert.match(t, /雪|秃/, `纽约一月该有冬天的样子：${t.slice(0, 160)}`);
});

test('第二批的城不再是一句空白：东京有梅雨，曼谷只有旱雨两季，迪拜是荒漠', () => {
  const tokyo = photoPrompt({ city: '东京', cityId: 'tokyo', hour: 14, month: 6, day: 20 });
  assert.match(tokyo, /梅雨/, `东京六月该有梅雨：${tokyo.slice(0, 160)}`);

  const bangkok = seasonLine(C('bangkok', '曼谷', 'TH', 'TH', 13.7), 7);
  assert.match(bangkok, /雨/, `曼谷七月该是雨季：${bangkok}`);

  const dubai = seasonLine(C('dubai', '迪拜', 'AE', 'AE', 25.2), 7);
  assert.match(dubai, /晒|白亮|无云/, `迪拜七月该是干热：${dubai}`);

  const sapporo = seasonLine(C('sapporo', '札幌', 'JP', 'JP', 43.06), 6);
  assert.doesNotMatch(sapporo, /梅雨/, `札幌六月不该有梅雨：${sapporo}`);
  assert.match(sapporo, /干爽|丁香|薰衣草/, `札幌六月该是干爽的：${sapporo}`);
});

test('欧洲的气候区是分开的：西欧冬天草地绿，中欧积雪留几天，南欧夏天枯黄', () => {
  /*
   * 2026-11-07 加。**这三条要是合成一条，欧洲的照片就白补了** ——
   * 伦敦和柏林同纬度，靠的正是「雪留不留得住」和「草绿不绿」分开。
   */
  const london = seasonLine(C('london', '伦敦', 'GB', 'GB', 51.5), 1);
  const berlin = seasonLine(C('berlin', '柏林', 'DE', 'DE', 52.5), 1);
  const nice = seasonLine(C('nice', '尼斯', 'FR', 'FR', 43.7), 7);

  assert.match(london, /草|常绿/, `伦敦一月该说草地是绿的：${london}`);
  assert.doesNotMatch(london, /积雪压|雪泥/, `伦敦冬天不该有积雪层：${london}`);
  assert.match(berlin, /雪/, `柏林一月该有雪：${berlin}`);
  assert.doesNotMatch(berlin, /草地和常绿灌木仍然是绿的/, '柏林和伦敦不能是同一句');
  assert.match(nice, /枯黄|柏树|橄榄/, `尼斯七月该是干热的：${nice}`);

  assert.notEqual(london, berlin, '伦敦和柏林拿到同一句季节 —— 气候区没起作用');
});

test('拍天和在路上不加地域季节', () => {
  const sky = photoPrompt({ city: '承德', cityId: 'chengde', spot: '避暑山庄', hour: 21, month: 11, view: 'sky' });
  assert.doesNotMatch(sky, /冰板|枯荷/, '抬头拍天，地上冻没冻跟这张无关');
  assert.match(sky, /天空|星|云/, '天空那张得讲天上有什么');

  const road = photoPrompt({ city: '承德', cityId: 'chengde', spot: '', hour: 15, month: 11, onRoad: true, mode: '火车' });
  assert.doesNotMatch(road, /冰板|枯荷/, '路上那张不属于某一座城');
});

test('数据里的句子能原样进提示词：没有 markdown、没有双句号', () => {
  /*
   * 这两条都是我自己写岔过的：句子末尾带句号 → 外面又加一个变 `。。`；
   * 注释里写 `**没在江南**` → 星号原样进了提示词。
   */
  const months = [1, 3, 5, 7, 9, 11, 12];
  const spots = [
    C('chengde', '承德', '河北'), C('haerbin', '哈尔滨', '黑龙江'), C('suzhou', '苏州', '江苏'),
    C('wuhan', '武汉', '湖北'), C('chengdu', '成都', '四川'), C('kunming', '昆明', '云南'),
    C('sanya', '三亚', '海南'), C('lhasa', '拉萨', '西藏'),
  ];
  for (const c of spots) {
    for (const m of months) {
      const line = seasonLine({ id: c.id, region: c.region, country: 'CN' }, m);
      assert.ok(line.length > 0, `${c.city} ${m} 月没有季节句`);
      assert.doesNotMatch(line, /\*\*/, `${c.city} ${m} 月的数据里混进了 markdown：${line}`);
      assert.doesNotMatch(line, /。$/, `${c.city} ${m} 月的数据末尾带句号 —— 外面会再加一个`);
    }
  }
});

test('每个中国城市都落进了一个气候区', async () => {
  const { CITIES } = await import('../src/geo/cities.ts');
  const lost = CITIES.filter((c) => c.country === 'CN' && !regionOf(c)).map((c) => `${c.name}(${c.region})`);
  assert.equal(lost.length, 0, `这些城没有气候区，冬天会退回「什么都不说」：${lost.join('、')}`);
});
