/**
 * 城市数据本身（2026-11-07 扩表后加）
 *
 * 这一天同时做了三件事：给 128 座城补夜间去处/节日/演出，加了 10 座俄罗斯、
 * 8 座波兰城市，并把「演出」做成第二天晚上的一次安排。
 *
 * 数据类的错**不会报错**，只会让她说错话：「晚上去某剧院」而那剧院不存在，
 * 「赶上某某节」而那节在别的月份。所以这里守的是**形状与自洽**，
 * 而不是「某座城应该有哪一条」—— 后者会随数据变，前者是真约束。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { CITIES, cityById, cityByName, cityOfSpot, nightIn, nightText, showsIn, VISTA } = await import('../src/geo/cities.ts');
const { planDay } = await import('../src/plan/dayplan.ts');
const { rollLodging } = await import('../src/plan/lodging.ts');
const { seasonLine } = await import('../src/geo/season.ts');

const LODGING = rollLodging(() => 0.2);

test('每座城的数据形状都站得住', () => {
  const problems = [];
  for (const c of CITIES) {
    if (!c.name || c.name.length > 8) problems.push(`${c.id} 名字`);
    if (c.spots.length < 5) problems.push(`${c.id} 只有 ${c.spots.length} 个景点`);
    if (c.spots.some((s) => typeof s !== 'string' || !s.trim() || s.includes('\n'))) {
      problems.push(`${c.id} 景点里有空串或换行`);
    }
    /*
     * 演出有两种形状（2026-11-07）：字符串 = 全年，`{name, months}` = 只在那些月份。
     * 两种都要验 —— 对象那条是后加的，最容易写漏 months 或把月份写成 13。
     */
    for (const s of c.shows) {
      if (typeof s === 'string') {
        if (!s.trim() || s.includes('\n')) problems.push(`${c.id} 演出里有空串或换行`);
        continue;
      }
      if (!s.name?.trim() || s.name.includes('\n')) problems.push(`${c.id} 演出名是空的`);
      if (!Array.isArray(s.months) || s.months.length === 0) {
        problems.push(`${c.id} 演出「${s.name.slice(0, 8)}」没写月份（全年就该用字符串）`);
      } else if (s.months.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) {
        problems.push(`${c.id} 演出「${s.name.slice(0, 8)}」的月份越界：${s.months.join(',')}`);
      }
    }
    /*
     * 夜间去处也是两种形状（2026-11-07）：字符串 = 全年，`{text, months}` = 只在那些月份。
     * 后半部分是后加的，最容易写漏 months 或留一个空 text。
     */
    if (c.night !== null) {
      if (typeof c.night === 'string') {
        if (!c.night.trim()) problems.push(`${c.id} night 是空串（该写 null）`);
      } else {
        if (!c.night.text?.trim()) problems.push(`${c.id} night 的 text 是空的`);
        if (!Array.isArray(c.night.months) || c.night.months.length === 0) {
          problems.push(`${c.id} 的夜间去处没写月份（全年就该用字符串）`);
        } else if (c.night.months.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) {
          problems.push(`${c.id} 的夜间去处月份越界：${c.night.months.join(',')}`);
        }
      }
    }
    for (const f of c.festivals) {
      if (!f.name.trim()) problems.push(`${c.id} 有节日没名字`);
      if (!Array.isArray(f.months)) problems.push(`${c.id} ${f.name} 的 months 不是数组`);
      if (f.months.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) {
        problems.push(`${c.id} ${f.name} 月份越界：${f.months}`);
      }
    }
    if (!VISTA[c.id]) problems.push(`${c.id} 没有视觉锚点`);
    /* 一座城的价签不该是 0 —— 那会让「今晚住哪」算成免费。 */
    if (!(c.priceIdx > 0.2 && c.priceIdx < 20)) problems.push(`${c.id} 价格系数 ${c.priceIdx}`);
  }
  assert.deepEqual(problems, [], `数据有问题：\n${problems.join('\n')}`);
});

test('城市 id 与名字都不重复 —— 重名会让「照着名字找城」找错地方', () => {
  const ids = new Set();
  for (const c of CITIES) {
    assert.ok(!ids.has(c.id), `id 重复：${c.id}`);
    ids.add(c.id);
  }
  const seen = new Map();
  for (const c of CITIES) {
    const hit = seen.get(c.name);
    assert.ok(!hit, `${c.name} 出现了两次：${hit} 和 ${c.id}`);
    seen.set(c.name, c.id);
  }
  /* 抽查：按名字要能找回这几座新城 */
  for (const name of ['圣彼得堡', '喀山', '华沙', '克拉科夫', '扎科帕内', '台北', '台中', '台南', '高雄', '花莲']) {
    assert.ok(cityByName(name), `按名字找不到 ${name}`);
  }
});

test('俄罗斯 / 波兰：时区能解析、坐标在北半球、价格系数像那么回事', () => {
  const ru = CITIES.filter((c) => c.country === 'RU');
  const pl = CITIES.filter((c) => c.country === 'PL');
  assert.ok(ru.length >= 10, `俄罗斯只有 ${ru.length} 座城`);
  assert.ok(pl.length >= 8, `波兰只有 ${pl.length} 座城`);
  for (const c of [...ru, ...pl]) {
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: c.tz }), `${c.id} 时区`);
    assert.ok(c.lat > 30 && c.lat < 75, `${c.id} 纬度 ${c.lat} 不像这两个国家`);
    assert.ok(c.priceIdx >= 0.8 && c.priceIdx <= 4, `${c.id} 价格系数 ${c.priceIdx}`);
    /* 名字是中文，id 是 latin slug —— 后者要能进 URL 和协议 */
    assert.match(c.id, /^[a-z][a-z0-9]*$/, `${c.id} 不是合法的 slug`);
  }
});

test('第二天晚上去看演出，第一晚还是这座城本来的夜色', () => {
  /*
   * 苏州：有夜花园（night），也有昆剧院（shows）。两件事必须各占一天，
   * 不然「夜市」和「剧院」会被挤成一条。
   */
  const city = cityById('suzhou');
  assert.ok(city.night, '苏州没有夜间去处了？');
  assert.ok(city.shows.length, '苏州没有演出了？');

  const day1 = planDay({ city, dateKey: '2026-11-08', shape: 'full', lodging: LODGING, dayIndex: 0 });
  const day2 = planDay({ city, dateKey: '2026-11-09', shape: 'full', lodging: LODGING, dayIndex: 1 });

  assert.equal(day1.nightOption, city.night, '第一晚不该被演出顶掉');
  assert.ok(day2.nightOption?.includes('晚上'), `第二晚没有演出安排：${day2.nightOption}`);
  /* 场地名要出现在正文里，冒号不该被念出来 */
  assert.doesNotMatch(day2.nightOption, /：/, `把数据的冒号原样念了：${day2.nightOption}`);
});

test('没有演出的城市，第二天晚上跟以前一模一样', () => {
  const plain = CITIES.find((c) => !c.shows.length);
  assert.ok(plain, '所有城市都有演出了？那这条要换个写法');
  const day2 = planDay({ city: plain, dateKey: '2026-11-09', shape: 'full', lodging: LODGING, dayIndex: 1 });
  assert.equal(day2.nightOption, plain.night, `${plain.name} 的第二晚被改动了`);
});

test('演出只在第二天出现一次，第三天不重复', () => {
  const city = cityById('suzhou');
  const day3 = planDay({ city, dateKey: '2026-11-10', shape: 'full', lodging: LODGING, dayIndex: 2 });
  assert.equal(day3.nightOption, city.night, '第三天还在推演出 —— 天天看戏不真实');
});

test('季节：俄罗斯的冬天要下雪，索契不', () => {
  /*
   * 加俄罗斯之前，非中国城市**不生成任何季节句** —— 于是摩尔曼斯克一月的照片里
   * 树叶是绿的。这正是承德那次的老毛病：提示词里没有一句说「现在是冬天」。
   */
  const murmansk = cityById('murmansk');
  const winter = seasonLine(murmansk, 1);
  assert.match(winter, /雪|冰|铅灰/, `摩尔曼斯克一月没有冬天的画面：${winter}`);

  const sochi = cityById('sochi');
  const mild = seasonLine(sochi, 1);
  /*
   * **一个「雪」字都不许有。**
   * 原来那句写的是「看不见北方那种厚大衣和积雪」—— 否定句在生图模型上
   * 经常被读成强调，等于把雪塞进了它脑子里。所以断言比的是「出现了没有」，
   * 不是「有没有说『没有雪』」。
   */
  assert.doesNotMatch(mild, /雪|冰/, `索契是亚热带，一月的画面里不该有雪或冰：${mild}`);

  /* 波兰同理 */
  assert.match(seasonLine(cityById('warsaw'), 1), /雪|冰|铅灰/);
});

test('演出的文案不许写含糊档期 —— 这个字段没有季节', () => {
  /*
   * 2026-11-07 加汕尾时发现的：她的戏台是「妈祖诞前后连演一个多月」，
   * 而 `shows` 这一格**没有月份字段**，`nightOptionOf` 只说「第二天晚上有演出就去」。
   * 于是十一月排的行程里出现了「四月底到五月底连演」——
   * 她会在冬天的海边跑去等一场四月的戏。
   *
   * ## 但「写了月份」不等于错
   *
   * 第一版断言是「不许出现月份」，结果把一堆**诚实的数据**判死了：
   *   「琴台音乐厅：乐季从九月排到次年六月」
   *   「南座：十二月的大歌舞伎连演整月」
   *   「瓦津基公园：五到九月每周日下午两场露天钢琴」
   * 这些说的是**什么时候有戏**，念出来用户一听就懂。
   *
   * ## 真正的分界
   *
   * 明确区间（九月到次年六月、五到九月）→ 留，那是事实；
   * **含糊指向**（「前后」「一个多月」）→ 删，因为听的人无法判断今天去有没有。
   *
   * 底层缺陷仍在：代码不看月份，夏天也可能排「去听交响乐」。
   * 要根治得给 `shows` 加月份字段 —— 那是 88 座城数据的改动，这一版没做。
   */
  const bad = [];
  for (const c of CITIES) {
    for (const show of c.shows) {
      if (/前后|一个多月|档期不定/.test(show)) {
        bad.push(`${c.name}：${show.slice(0, 48)}`);
      }
    }
  }
  assert.deepEqual(bad, [], `这些演出写的是含糊档期，她不知道今天去有没有：\n${bad.join('\n')}`);
});

test('露天演出只在它有档期的月份里排 —— 一月不去桂林看刘三姐', () => {
  /*
   * 2026-11-07 加。`shows` 原来是 `string[]`，一律全年排：
   * 桂林《印象·刘三姐》是漓江上的露天实景演出，十二月停演；
   * 华沙瓦津基公园的肖邦露天钢琴只在五到九月；乐团的乐季是九月到次年六月。
   *
   * 这不是「不够浪漫」，是**让她说了一件不存在的事**。
   */
  const guilin = cityById('guilin');
  const july = planDay({ city: guilin, dateKey: '2026-07-09', shape: 'full', lodging: LODGING, dayIndex: 1 });
  assert.match(july.nightOption ?? '', /刘三姐/, `七月该有刘三姐：${july.nightOption}`);

  const jan = planDay({ city: guilin, dateKey: '2026-01-09', shape: 'full', lodging: LODGING, dayIndex: 1 });
  assert.doesNotMatch(jan.nightOption ?? '', /刘三姐/, `一月不该有刘三姐：${jan.nightOption}`);

  /* 停演的那一晚要退回这座城本来的夜色，而不是留空 */
  assert.equal(jan.nightOption, guilin.night, `停演的晚上没有退回 night：${jan.nightOption}`);
});

test('乐季之外的乐团不排 —— 柏林的乐季是九月到次年六月', () => {
  const warsaw = cityById('warsaw');
  const aug = planDay({ city: warsaw, dateKey: '2026-08-09', shape: 'full', lodging: LODGING, dayIndex: 1 });
  const jan = planDay({ city: warsaw, dateKey: '2026-01-09', shape: 'full', lodging: LODGING, dayIndex: 1 });
  /* 八月只剩国家爱乐厅（全年），肖邦纪念像那场停在五月到九月之外 —— 这里验的是「都没漏」 */
  assert.ok(aug.nightOption, '八月晚上什么都没有');
  assert.ok(jan.nightOption, '一月晚上什么都没有');
  const jun = planDay({ city: warsaw, dateKey: '2026-06-09', shape: 'full', lodging: LODGING, dayIndex: 1 });
  assert.ok(jun.nightOption, '六月晚上什么都没有');
});

test('showsIn：字符串全年算，对象只看月份', () => {
  const city = {
    shows: [
      '常设剧场：一年到头都演',
      { name: '露天实景：只在夏天', months: [6, 7, 8] },
    ],
  };
  assert.deepEqual(showsIn(city, 1), ['常设剧场：一年到头都演']);
  assert.deepEqual(showsIn(city, 7), ['常设剧场：一年到头都演', '露天实景：只在夏天']);
  assert.deepEqual(showsIn({ shows: [{ name: 'x', months: [6] }] }, 12), []);
});

test('夜间去处也认季节 —— 摩尔曼斯克六月没有极光', () => {
  /*
   * 2026-11-07。和演出同一个毛病：句子里写着「冬天」，却在任何一晚都说。
   * 摩尔曼斯克夏至前后天不黑（白夜），不可能看见极光；
   * 华沙维斯瓦河边的沙滩酒吧、德累斯顿的露天电影都只在夏天开。
   */
  const mur = cityById('murmansk');
  const june = planDay({ city: mur, dateKey: '2026-06-21', shape: 'full', lodging: LODGING, dayIndex: 0 });
  assert.equal(june.nightOption, null, `六月的摩尔曼斯克还在等极光：${june.nightOption}`);
  const jan = planDay({ city: mur, dateKey: '2026-01-15', shape: 'full', lodging: LODGING, dayIndex: 0 });
  assert.match(jan.nightOption ?? '', /绿色的光带/, `一月该有极光：${jan.nightOption}`);

  const waw = cityById('warsaw');
  const winter = planDay({ city: waw, dateKey: '2026-01-15', shape: 'full', lodging: LODGING, dayIndex: 0 });
  assert.doesNotMatch(winter.nightOption ?? '', /沙滩酒吧/, `一月还开着沙滩酒吧：${winter.nightOption}`);
});

test('nightIn / nightText：字符串全年，对象只看月份', () => {
  assert.equal(nightIn({ night: '夜市' }, 1), '夜市');
  assert.equal(nightIn({ night: { text: '极光', months: [12] } }, 7), null);
  assert.equal(nightIn({ night: { text: '极光', months: [12] } }, 12), '极光');
  /* nightText 收的是「那条去处」本身，不是城市 —— nightIn 才收城市 */
  assert.equal(nightText({ text: '极光', months: [12] }), '极光');
  assert.equal(nightText(null), null);
});

/* ---------------- 景点 → 所属城（2026-11-25） ---------------- */

test('景点名能查出它在哪座城 —— 不查就会被人当成「去不了的地方」', () => {
  /*
   * 来信：「鲸鲸想去涠洲岛，但是被买船票拦住了」。
   * 涠洲岛不是城，是北海 `SPOTS` 里的一个地方。`cityByName('涠洲岛')` 给 null，
   * 于是整条路以「城市表里没有」结束，而用户那边听到的是「船票买不了」。
   */
  assert.equal(cityOfSpot('涠洲岛')?.id, 'beihai');
  assert.equal(cityOfSpot('银滩')?.id, 'beihai', '同一座城的别的景点也要认');
  assert.equal(cityOfSpot('西湖')?.id, 'hangzhou');
  assert.equal(cityOfSpot('兵马俑')?.id, 'xian');
  assert.equal(cityOfSpot('青城山')?.id, 'chengdu');
});

test('景点反查的边界：带城名的能认，模糊的和城市名的不抢', () => {
  /* 「北海涠洲岛」这种把城名和景点连起来的说法很常见。 */
  assert.equal(cityOfSpot('北海涠洲岛')?.id, 'beihai');

  /*
   * **不做反向匹配**（景点名包含输入）。做了的话「老街」会命中
   * 「北海老街」「东门老街」…一大片，等于「哪座城都能去」——
   * 那不是答案，是把错误伪装成答案。
   */
  assert.equal(cityOfSpot('老街'), null);
  assert.equal(cityOfSpot('古城'), null);

  /* 城市名归 `cityByName` 管，这里不该抢 —— 否则「兰州市」会被景点表里
     某个含「兰州」的条目错配走。 */
  assert.equal(cityOfSpot('兰州市'), null);
  /* 太短的一律不认，避免「山」「湖」这种把半张表都命中的输入。 */
  assert.equal(cityOfSpot('山'), null);
  assert.equal(cityOfSpot(''), null);
});
