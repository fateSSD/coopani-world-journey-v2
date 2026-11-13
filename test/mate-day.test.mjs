/**
 * 日程里，同伴不能只出现在晚饭那一格（2026-11-08，1.0.4）。
 *
 * ## 反馈原话
 *
 * Mr.Q 截了一张日程面板：「现在互动事件只有吃饭嘛」。
 *
 * 截图里那天是：
 *
 * ```
 * 14:30  下午，玉林西路（小酒馆）
 * 16:15  还在玉林西路（小酒馆），人比刚进来的时候多了
 * 18:30  晚饭，和慕容悠、玄月的大肥鱼、风子家的鱼宝宝一起，担担面
 * 20:15  九眼桥那一带的夜
 * 21:30  回成都大丰客栈……
 * ```
 *
 * 一天五格，只有晚饭那格有人。而且那格的写法是「和 A、B、C 一起，担担面」——
 * **人只是状语**，把名字抠掉句子照样成立，读起来是个标签，不像有人在场。
 *
 * ## 这条测试守什么
 *
 * 1. 一天至少两处提到同伴（不能只剩晚饭）；
 * 2. 那个人**做一件事**，不是挂在句子前面的状语；
 * 3. 一群人时用「他们」—— 全名塞进任何一句都会把句子挤爆；
 * 4. 看演出那格不接人（台上在演，没人说话）。
 */
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { cityById } = await import('../src/geo/cities.ts');
const { planDay } = await import('../src/plan/dayplan.ts');

const ROOM = (tier = 'budget') => ({ tier, kind: '快捷连锁', price: 390, feel: '干净、标准' });
const WEATHER = { dayWeather: '晴', nightWeather: '晴', wet: false };
const MANY = '慕容悠、玄月的大肥鱼、风子家的鱼宝宝';

const days = (n) => Array.from({ length: n }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);

/** 确定性骰子：同一个种子同一串数。`Math.random` 会让「重算两次」那条必然红。 */
const lcg = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function plan(cityId, dateKey, mate, seed = 7) {
  return planDay({
    city: cityById(cityId),
    dateKey,
    shape: 'full',
    startHour: 0,
    lodging: ROOM(),
    weather: WEATHER,
    dayIndex: 1,
    comfortable: true,
    mate,
    rnd: lcg(seed),
  });
}

/** 这句里提到那个人了没有。 */
const mentions = (what, who) => what.includes(who);

test('一天至少两处提到同伴 —— 不能只剩晚饭', () => {
  /*
   * 各处独立掷骰时，偶尔会出现「早中晚景点夜里全不中」，那天就只剩晚饭一格带人 ——
   * 正是截图里的样子。所以有保底：其余四处全没中就把午饭打开。
   */
  for (const id of ['chengdu', 'xian', 'sanya', 'haerbin', 'lijiang']) {
    for (const d of days(12)) {
      const p = plan(id, d, MANY);
      const hits = p.beats.filter((b) => mentions(b.what, '小伙伴们'));
      assert.ok(hits.length >= 2, `${id} ${d} 只有 ${hits.length} 处提到同伴：\n${p.beats.map((b) => b.what).join('\n')}`);
    }
  }
});

test('不能处处都是 —— 一天最多五处，平均在三上下', () => {
  /*
   * 第一版五处都给宽（早四成、午八成五、夜七成五、中段五成），
   * 出来一天平均 4.2 处、最多 6 处 —— 那不是一起旅行，那是每格填名字。
   */
  let total = 0;
  let days_ = 0;
  let max = 0;
  for (const id of ['chengdu', 'xian', 'sanya', 'lijiang']) {
    for (const d of days(15)) {
      const n = plan(id, d, MANY).beats.filter((b) => mentions(b.what, '小伙伴们')).length;
      total += n;
      days_ += 1;
      if (n > max) max = n;
    }
  }
  const avg = total / days_;
  assert.ok(avg >= 2 && avg <= 3.6, `平均一天提到 ${avg.toFixed(1)} 处`);
  assert.ok(max <= 5, `有一天提到了 ${max} 处`);
});

test('人是主语，不是状语 —— 把名字抠掉句子还得成句', () => {
  /*
   * 「晚饭，和 A、B、C 一起，担担面」抠掉名字只剩「，担担面」，那是个标签。
   * 「他们点了担担面，你跟着也来一份」抠掉名字还剩一整句。
   */
  let checked = 0;
  for (const d of days(12)) {
    const p = plan('chengdu', d, '小满');
    for (const b of p.beats) {
      if (!mentions(b.what, '小满')) continue;
      const stripped = b.what.replace(/小满/g, '').replace(/^(早饭|午饭|晚饭)，/, '');
      assert.ok(stripped.length >= 8, `「${b.what}」把人抠掉就没了 —— 人还是状语`);
      checked += 1;
    }
  }
  assert.ok(checked >= 12, `只查到 ${checked} 处，样本太少`);
});

test('称呼分三级：一个人用名字，两个人列名字，三个人以上叫「小伙伴们」', () => {
  /*
   * 第一版写的是「他们」，Mr.Q 看了截图退回来：
   * 「改成小伙伴们、或者把名字列出来比较好」。
   *
   * 他是对的 ——「他们」既没有辨识度，也不像认识的人。一起走的是**伙伴**。
   */
  for (const d of days(10)) {
    const three = plan('chengdu', d, MANY);
    const one = plan('chengdu', d, '小满');
    const two = plan('chengdu', d, '小满、风子');
    const threeText = three.beats.map((b) => b.what).join('\n');
    const oneText = one.beats.map((b) => b.what).join('\n');
    const twoText = two.beats.map((b) => b.what).join('\n');

    /*
     * 三个人以上：叫「小伙伴们」，绝不出现全名。
     * **不断言「没有『他们』」** —— 景点讲解里本来就有「他们那时候…」这种句子，
     * 那是数据里的字，不是同伴的称呼。这一条我自己踩过两次。
     */
    assert.doesNotMatch(threeText, /慕容悠/, `${d} 日程里塞了全名`);
    assert.match(threeText, /小伙伴们/, `${d} 三个人以上没叫「小伙伴们」`);

    /* 两个人：把名字列出来。「小满和风子」比「小伙伴们」具体，也不算长。 */
    assert.match(twoText, /小满和风子/, `${d} 两个人没列名字`);
    assert.doesNotMatch(twoText, /小伙伴们/, `${d} 两个人不该用集合称呼`);

    /*
     * 一个人时只查「别人的名字没了」和「自己的名字在」。
     * 不查「他们」—— 景点讲解里本来就有「他们那时候…」这种句子，那是数据里的字。
     */
    assert.doesNotMatch(oneText, /慕容悠|玄月|小伙伴们/, `${d} 一个人却串进了别人`);
    assert.match(oneText, /小满/, `${d} 一个人的名字没了`);
  }
});

test('没有同伴时一个人名都不出现 —— 老行为不变', () => {
  /*
   * 只查**人名**，不查「他们」：景点说明里本来就有「他们那时候…」这种句子
   * （讲解、来历），那是数据里的字，不是同伴带进来的。
   */
  for (const d of days(6)) {
    const p = plan('chengdu', d, undefined);
    const text = p.beats.map((b) => b.what).join('\n');
    assert.doesNotMatch(text, /小满|慕容悠/);
  }
});

test('夜景那句另起一句，不往选项后面硬接', () => {
  /*
   * `nightOption` 不是「九眼桥那一带的夜」那种短名词短语，实际是整句描述：
   *
   * ```
   * 晚上，悦来茶园，成都市川剧院，折子戏常演，周末有整本
   * ```
   *
   * 第一版直接 `${night}，${who}说这条街跟她想的不一样` —— 出来是
   * 「…周末有整本，某某说这条街跟她想的不一样」，**人在茶园里评价一条街**。
   */
  let nightChecked = 0;
  for (const d of days(15)) {
    const p = plan('chengdu', d, '小满');
    const night = p.beats.find((b) => b.kind === 'night');
    if (!night || !night.what.includes('小满')) continue;
    /*
     * 人那一句必须**另起一句**（句号之后），不能在逗号后面接着来。
     *
     * 1.0.5 起允许两种起句：`。小满…` 和 `。你问…小满…`。
     * 加第二种是因为夜里七条原来全以「小满说」开头，连看七天像七句同一句话；
     * 让两条从「你」起句，一问一答才像两个人在过。
     * **守的是「句号」这个位置，不是「名字必须是第一个词」。**
     */
    assert.match(night.what, /。(?:小满|你)/, `人接在逗号后面了：${night.what}`);
    nightChecked += 1;
  }
  assert.ok(nightChecked > 0, '十五天里一次都没挂上，样本不对');
});

test('看演出那格不接人 —— 台上在演，没人说话', () => {
  /* 找一座有 `shows` 的城，确认演出那格不带同伴的人。 */
  for (const id of ['pingyao', 'guilin', 'suzhou', 'warsaw', 'hangzhou']) {
    for (const d of days(15)) {
      const p = plan(id, d, '小满');
      for (const b of p.beats.filter((x) => x.kind === 'night')) {
        if (!b.what.includes('《')) continue;
        assert.doesNotMatch(b.what, /小满/, `演出那格挂人了：${b.what}`);
      }
    }
  }
});

test('同一个日子重算两次，结果一模一样', () => {
  /* 全是确定性哈希，不许有 `Math.random` —— 面板刷新一次就换一套说法，比不动还糟。 */
  for (const d of days(6)) {
    const a = plan('chengdu', d, MANY).beats.map((b) => b.what).join('|');
    const b = plan('chengdu', d, MANY).beats.map((b) => b.what).join('|');
    assert.equal(a, b, `${d} 重算换了说法`);
  }
});
