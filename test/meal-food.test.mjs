/**
 * 一天三顿吃什么。
 *
 * 2026-11-07 三轮修改，每一轮都是用户当场看出来的：
 *
 * 1. 「早饭，洛阳水席」—— 水席是二十四道菜的宴席。
 *    原来 `foods[meal % len]` 把「最有名的菜」当成了「早饭」。
 * 2. 「每只鱼早餐在成都吃麻婆豆腐」—— 中国大部分地方的早饭是**通用的**
 *    （豆浆油条、包子粥、小面抄手），只有少数地方有离开这儿没有的早点。
 * 3. 「午餐晚餐最好抽签别按同一个顺序排」—— 一座城待三天，三顿的排列
 *    原来一模一样，像配给表。
 *
 * 现在的规矩：招牌早点优先 → 大区通用池 → 午饭晚饭按「城市 + 日期」抽签。
 */
const { CITIES, FEATURES, cityById } = await import('../src/geo/cities.ts');
const { pickFood } = await import('../src/plan/dayplan.ts');
const assert = (await import('node:assert/strict')).default;
const { test } = await import('node:test');

/** 早上不会吃的东西。和 `dayplan.ts` 里那张表同一个口径，故意分开写一遍。 */
const NOT_BREAKFAST =
  /宴|火锅|水席|啤酒|葡萄酒|威士忌|伏特加|清酒|烧酒|白酒|烤鸭|烤全羊|烤肉|烧鹅|烧腊|叉烧|刺身|生蚝|牛排|steak|猪肘|拼盘|青口锅|干锅|焖锅|地锅|石锅|汤锅|三下锅|一品锅|浑锅|大盘鸡|锅包肉/i;

const D1 = '2027-03-29';
const D2 = '2027-03-30';
const D3 = '2027-03-31';

test('全城扫描：早饭不是宴席、火锅或酒', () => {
  const wrong = [];
  for (const c of CITIES) {
    if (!c.foods.length) continue;
    for (const seed of [D1, D2, D3]) {
      const b = pickFood(c, 0, seed);
      if (NOT_BREAKFAST.test(b)) wrong.push(`${c.name} → ${b}`);
    }
  }
  assert.deepEqual(wrong, [], `这些城的早饭是硬菜：\n${wrong.join('\n')}`);
});

test('早饭不是招牌正餐 —— 成都早上不吃麻婆豆腐，北京不吃烤鸭', () => {
  /* 这三座城的 `foods` 第一样都是正餐，正是用户点出来的那几个。 */
  for (const seed of [D1, D2, D3]) {
    assert.doesNotMatch(pickFood(cityById('chengdu'), 0, seed), /麻婆豆腐|回锅肉/, `成都 ${seed} 早饭`);
    assert.doesNotMatch(pickFood(cityById('beijing'), 0, seed), /烤鸭/, `北京 ${seed} 早饭`);
    assert.doesNotMatch(pickFood(cityById('luoyang'), 0, seed), /水席/, `洛阳 ${seed} 早饭`);
  }
});

test('有招牌早点的地方，早饭就是招牌 —— 武汉热干面、西安肉夹馍', () => {
  for (const seed of [D1, D2, D3]) {
    assert.equal(pickFood(cityById('wuhan'), 0, seed), '热干面', '武汉早饭该是热干面');
    assert.match(pickFood(cityById('xian'), 0, seed), /肉夹馍/, '西安早饭该是肉夹馍');
  }
});

test('早饭会换花样：同一座城连着五天不吃同一样', () => {
  const days = ['2027-03-29', '2027-03-30', '2027-03-31', '2027-04-01', '2027-04-02'];
  const seen = days.map((d) => pickFood(cityById('chengdu'), 0, d));
  assert.equal(new Set(seen).size >= 4, true, `五天里只有 ${new Set(seen).size} 样：${seen.join('、')}`);
});

test('午饭晚饭按日期抽签：同一座城连吃三天不会同一套排列', () => {
  const rows = [D1, D2, D3].map((d) => [pickFood(cityById('chengdu'), 1, d), pickFood(cityById('chengdu'), 2, d)].join('/'));
  assert.ok(new Set(rows).size >= 2, `三天一模一样：${rows.join(' | ')}`);
});

test('三顿不撞车（三样菜以上的城）', () => {
  const dup = [];
  for (const c of CITIES) {
    if (c.foods.length < 3) continue;
    for (const seed of [D1, D2, D3]) {
      const [b, l, d] = [pickFood(c, 0, seed), pickFood(c, 1, seed), pickFood(c, 2, seed)];
      if (b === l || l === d || b === d) dup.push(`${c.name}@${seed}: ${b} / ${l} / ${d}`);
    }
  }
  assert.deepEqual(dup, [], `这些城三顿里有重复：\n${dup.join('\n')}`);
});

test('同一天重算必须同结果 —— 否则作息表和照片会对不上', () => {
  const c = cityById('chengde');
  const once = [pickFood(c, 0, D1), pickFood(c, 1, D1), pickFood(c, 2, D1)].join('/');
  for (let i = 0; i < 5; i++) {
    assert.equal([pickFood(c, 0, D1), pickFood(c, 1, D1), pickFood(c, 2, D1)].join('/'), once);
  }
});

test('没有菜名的城退回方向词，不是空串（拿假城市测，不靠数据里留空）', () => {
  /*
   * 2026-11-08：原来这条靠「数据里确实有 22 座空城」来跑，补完菜名之后就红了 ——
   * **断言挂在数据的缺失上，数据一修，测试就废**。改成自己造一座没有菜名的城。
   */
  const empty = { ...cityById('lanzhou'), id: 'fake-empty', name: '空城', foods: [] };
  for (const meal of [0, 1, 2]) {
    const v = pickFood(empty, meal, D1);
    assert.ok(typeof v === 'string' && v.trim().length, `第 ${meal} 顿的兜底是空的`);
  }
});

test('每座城至少三道菜 —— 少了就一定会「连续两顿吃同一个东西」', () => {
  /*
   * 2026-11-08 Mr.Q 发来两张饺子图：「连续两顿吃的同一个东西，不太行」。
   *
   * 查下来不是取法的问题：**22 座城一条菜名都没有**（东京、大阪、首尔、巴黎、
   * 纽约、罗马、莫斯科…），`pickFood` 退回 `foodHint` 的方向词，而方向词按城市
   * 标签算，一天三顿全是同一句。另外三座只有两道菜（优胜美地、拉斯维加斯、大峡谷）。
   *
   * 所以真正要守的不变量是**数据下限**：三道菜是「三顿饭能各不相同」的最低要求。
   * 将来再加一座城忘了写菜，这条会立刻红。
   */
  const short = CITIES.filter((c) => c.foods.length < 3)
    .map((c) => `${c.name}(${c.foods.length})`);
  assert.deepEqual(short, [], `菜名不足三道：${short.join('、')}`);
});

test('全部城市 × 十四天：连续两顿不重复（含隔夜）', () => {
  const days = Array.from({ length: 14 }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);
  const bad = [];
  for (const c of CITIES) {
    let prev = '';
    for (const d of days) {
      for (const meal of [0, 1, 2]) {
        const dish = pickFood(c, meal, d);
        if (dish && dish === prev) bad.push(`${c.name} ${d} 第${meal}顿：${dish}`);
        prev = dish;
      }
    }
  }
  assert.deepEqual(bad.slice(0, 8), [], `连续两顿一样：${bad.slice(0, 8).join('；')}`);
});

/* ---------------- 2026-11-08 成都：两碗红油饺子 ---------------- */

test('「形态」怎么分：包馅的一类，面与粉分开', async () => {
  /*
   * Mr.Q 在成都发来两张饺子图。那天早饭是「红油抄手」（大区通用池），
   * 午饭是「钟水饺」（城里的菜名）—— 名字不同、代码合法，可端上来是两碗一样的东西。
   *
   * 但面和粉**不能**并成一类：武汉早饭热干面，午饭要是连米粉都不能吃，
   * 十样池子会被榨到七样。
   */
  const { familyOf } = await import('../src/plan/dayplan.ts');
  assert.equal(familyOf('红油抄手'), familyOf('钟水饺'), '抄手和水饺没归成一类');
  assert.equal(familyOf('鲜虾馄饨'), familyOf('猪肉白菜饺子'));
  assert.notEqual(familyOf('担担面'), familyOf('螺蛳粉'), '面和粉不该并成一类');
  assert.notEqual(familyOf('担担面'), familyOf('钟水饺'));
  assert.equal(familyOf('鲅鱼水饺'), '饺');
  assert.equal(familyOf('过桥米线'), '粉');
});

test('成都：连住二十天，相邻两顿不重名，形态也基本不撞', async () => {
  const { familyOf } = await import('../src/plan/dayplan.ts');
  const cd = cityById('chengdu');
  /* 用她真实的口味：喜欢红油抄手（2026-11-06 记的）。 */
  const taste = { like: ['红油抄手'] };
  const days = Array.from({ length: 20 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
  const dup = [];
  let clash = 0;
  for (const d of days) {
    const m = [0, 1, 2].map((x) => pickFood(cd, x, d, taste));
    if (new Set(m).size !== 3) dup.push(`${d}：${m.join('/')}`);
    /* 只比「强形态」：抄手/水饺/面/粉/饭这类。`其他` 是个筐，不该互相排斥。 */
    const hard = m.map((x) => (familyOf(x) === '其他' ? '' : familyOf(x)));
    if (hard[0] && hard[0] === hard[1]) clash++;
    if (hard[1] && hard[1] === hard[2]) clash++;
  }
  assert.deepEqual(dup, [], `同一天里出现同一道菜：${dup.slice(0, 3).join('；')}`);
  /* 形态是「尽量避」不是「必须避」—— 全避会把池子榨干，只要求九成以上不撞。 */
  assert.ok(clash <= 4, `二十天里撞了 ${clash} 次形态`);
});

test('池子被「不想再吃」剔剩一条，也要补够三样', () => {
  /*
   * 成都只有三道菜。她要是把其中两道记成「不想再吃」，池子就剩一道 ——
   * 那样三顿只能是同一道。补的从大区家常菜里拿（宫保鸡丁那一类），
   * **而且不许掺她不想吃的**。
   */
  const cd = cityById('chengdu');
  const taste = { dislike: ['麻婆豆腐', '担担面'] };
  const m = [0, 1, 2].map((x) => pickFood(cd, x, '2026-11-08', taste));
  assert.ok(!m.includes('麻婆豆腐') && !m.includes('担担面'), `又排到不想吃的：${m.join('/')}`);
  assert.equal(new Set(m).size, 3, `三顿没排出三样不同的：${m.join('/')}`);
});

test('海外城市的早饭按国家给 —— 东京不给可颂', () => {
  const tokyo = cityById('tokyo');
  const seen = new Set();
  for (let i = 1; i <= 12; i++) seen.add(pickFood(tokyo, 0, `2026-11-${String(i).padStart(2, '0')}`));
  const all = [...seen].join('/');
  assert.match(all, /味噌汤|饭团|玉子烧/, `东京的早饭不是日式的：${all}`);
  assert.doesNotMatch(all, /可颂|贝果|司康/, `东京早饭落到西式池了：${all}`);
});

test('早饭不会正好是这座城的当家菜（纽约的贝果）', () => {
  const ny = cityById('newyork');
  const days = Array.from({ length: 10 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
  /* 前一天晚饭和第二天早饭不该是同一道。 */
  for (let i = 0; i + 1 < days.length; i++) {
    const dinner = pickFood(ny, 2, days[i]);
    const breakfast = pickFood(ny, 0, days[i + 1]);
    assert.notEqual(dinner, breakfast, `${days[i]} 晚饭 = ${days[i + 1]} 早饭：${dinner}`);
  }
});

test('每座城六十天里能吃到十样不同的菜（本地不够就用区域菜补）', () => {
  /*
   * 2026-11-08 Mr.Q：「吃的最好每个城市有 10 种，要是实在没有本地菜，就可以用
   * 区域菜来代替，实在不行就按南北方或者国家为单位来排。」
   *
   * 判据是**排得出来**，不是**数据里写了十条**：城里的菜 + 大区池 + 国家池，
   * 前一层够了就不往下补。六十天足够把池子走一遍。
   */
  const start = Date.UTC(2026, 0, 1);
  const short = [];
  for (const c of CITIES) {
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
      const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
      for (const m of [0, 1, 2]) seen.add(pickFood(c, m, d));
    }
    if (seen.size < 10) short.push(`${c.name}(${seen.size})`);
  }
  assert.deepEqual(short, [], `排不出十样：${short.join('、')}`);
});

test('招牌菜一定排得出来 —— 标签写了火锅，菜表里没有也得吃上', () => {
  /*
   * 2026-11-13，Discussion #586（DonahueMa）：
   * 「重庆小面、毛血旺、酸辣粉，最标志性的火锅和串串啥的没有。」
   *
   * 查下来两处数据自己打架：`FEATURES.chongqing.food = '火锅'`，
   * 可重庆那张菜表里根本没有火锅，成都一模一样。
   *
   * 判据：**标签写了什么，六十天里就必须吃到什么**（早饭不算 —— 早上不吃火锅）。
   */
  const start = Date.UTC(2026, 0, 1);
  const days = Array.from({ length: 60 }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  const miss = [];
  for (const c of CITIES) {
    const signature = FEATURES[c.id]?.food;
    if (!signature) continue;
    /* 三顿都算：肉夹馍、热干面、甜茶这些本来就是早饭那一类，只看午晚会误判。 */
    const eaten = days.flatMap((d) => [pickFood(c, 0, d), pickFood(c, 1, d), pickFood(c, 2, d)]);
    if (!eaten.includes(signature)) miss.push(`${c.name}(${signature})`);
  }
  assert.deepEqual(miss, [], `标签上的招牌菜吃不到：${miss.join('、')}`);
});
