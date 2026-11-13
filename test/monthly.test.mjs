/**
 * 月报生成器 —— 纯函数，喂数据验形状，不碰文件也不联网。
 *
 * 2026-11-05：Mr.Q 要「用每天她拍的照片和日记重组写一篇 HTML 格式的可视化报告」，
 * 还要「按照不同月份有不同的艺术风格」。所以这里钉的是三件事：
 * 十二套配色都在、图片路径拼得对、没东西的时候不硬填。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  monthlyReport, themeOf, mediaFile, citiesOfMonth, excerpt, monthTitle,
  pickPosters, seasonOf, seasonTrim, posterPrompt, dateStamp, POSTER_CAP, yearlyHtml,
} from '../src/monthly.ts';
import { featureOf } from '../src/geo/cities.ts';

test('月报：十二个月十二套配色，三月和十二月不能长得一样', () => {
  const mar = themeOf('2026-03');
  const dec = themeOf('2026-12');
  assert.notEqual(mar.accent, dec.accent, '三月和十二月同一个强调色，那就不叫「这个月的」月报');
  assert.notEqual(mar.bg, dec.bg, '底色一样');
  assert.notEqual(mar.name, dec.name);

  for (let m = 1; m <= 12; m++) {
    const k = `2026-${String(m).padStart(2, '0')}`;
    const t = themeOf(k);
    assert.ok(t?.name, `${m} 月没有配色 —— 会掉回默认`);
    // 颜色必须是合法值，`#d8a martian` 那种笔误要当场红
    assert.match(t.accent, /^#[0-9a-f]{6}$/i, `${m} 月的强调色不是合法色值：${t.accent}`);
    assert.match(t.bg, /^#[0-9a-f]{6}$/i, `${m} 月的底色不是合法色值：${t.bg}`);
  }
});

test('月报：图片句柄去掉 log: 前缀就是媒体库文件名', () => {
  assert.equal(mediaFile('log:ab12cd34.png'), 'ab12cd34.png');
  assert.equal(mediaFile('ab12cd34.png'), 'ab12cd34.png', '没有前缀时不该被啃掉');
  assert.equal(mediaFile(''), '');
});

test('月报：城市按待过的天数排，同一天不重复计数', () => {
  const c = citiesOfMonth(
    [
      { dateKey: '2026-11-01', cityName: '九寨沟', title: '', handle: '' },
      { dateKey: '2026-11-01', cityName: '九寨沟', title: '', handle: '' },
      { dateKey: '2026-11-03', cityName: '九寨沟', title: '', handle: '' },
      { dateKey: '2026-11-04', cityName: '成都', title: '', handle: '' },
    ],
    [{ dateKey: '2026-11-02', cityName: '九寨沟', body: '' }],
  );
  assert.equal(c[0].name, '九寨沟');
  assert.equal(c[0].days, 3, '同一天两张照片被算成了两天');
  assert.equal(c[1].days, 1);
});

test('月报：摘录切在句号上，不把一句话拦腰砍断', () => {
  const body = '今天走了很多路。腿很沉。但是看到了很好的东西，值得。';
  const e = excerpt(body, 20);
  assert.ok(e.length <= 21, `没截短：${e}`);
  assert.ok(e.endsWith('。') || e.endsWith('…'), `截断了却没给标点：${e}`);
});

test('月报：页面里有照片路径、有统计数，标题是「十一月」', () => {
  assert.equal(monthTitle('2026-11'), '十一月');
  assert.equal(monthTitle('2026-01'), '一月');

  const html = monthlyReport({
    monthKey: '2026-11',
    photos: [
      { dateKey: '2026-11-05', cityName: '九寨沟', title: '黄昏的中查沟', handle: 'log:aa11.png' },
    ],
    entries: [{ dateKey: '2026-11-05', cityName: '九寨沟', body: '走了一天。' }],
    // 这一段钉的是海报那一版；线圈本是另一套模板，另有测试。
    layout: 'poster',
  });
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.match(html, /\.\.\/media\/aa11\.png/, '照片路径拼错了 —— 打开以后图会全空');
  assert.match(html, /十一月/);
  assert.match(html, /1<span class="u">张/, '照片数没写对');
  assert.match(html, /1<span class="u">篇/, '日记数没写对');
});

test('月报：一个月什么都没有时，页面说清楚，不摆空图', () => {
  const html = monthlyReport({ monthKey: '2026-02', photos: [], entries: [], layout: 'poster' });
  assert.match(html, /一张都没拍/, '空月份该说清楚，不是留一大片空白');
  assert.equal(html.includes('<img'), false, '空月份还画了图片标签');
});

test('月报：日记里的尖括号不会把页面结构撑破', () => {
  const html = monthlyReport({
    monthKey: '2026-11',
    photos: [],
    entries: [{ dateKey: '2026-11-02', cityName: '成都', body: '<script>alert(1)</script> 看到了这种字。' }],
  });
  assert.equal(html.includes('<script>alert(1)</script>'), false, '日记正文没转义 —— 她写的字能改页面结构');
  assert.match(html, /&lt;script&gt;/);
});

/* ---------------- 封面：一个地方一张（2026-11-05） ---------------- */

const ph = (dateKey, cityName, title, handle, spot = '', cityId = '') =>
  ({ dateKey, cityName, title, handle, spot, cityId });

test('封面：一个地方只出一张，取日期居中的那天', () => {
  const photos = [
    ph('2026-11-03', '九寨沟', '黄昏的黄龙', 'log:a.png', '黄龙', 'jiuzhaigou'),
    ph('2026-11-04', '九寨沟', '黄昏的甘海子', 'log:b.png', '甘海子', 'jiuzhaigou'),
    ph('2026-11-05', '九寨沟', '中查沟的夜空', 'log:c.png', '中查沟', 'jiuzhaigou'),
  ];
  const picks = pickPosters(photos);
  assert.equal(picks.length, 1, '同一座城出了不止一张 —— 读起来会变成「这个月只去了一座城」');
  assert.equal(picks[0].dateKey, '2026-11-04', '取的不是中间那天：到的第一天和走那天多半在赶路');
  assert.equal(picks[0].spot, '甘海子', '封面大字该用具体地点，不是城市名');
});

test('封面：路上那张不算一个地方', () => {
  const photos = [
    ph('2026-11-03', '路上', '九寨沟一带的路上', 'log:r.png', '', 'road'),
    ph('2026-11-02', '天水', '黄昏的玉泉观', 'log:t.png', '玉泉观', 'tianshui'),
  ];
  const picks = pickPosters(photos);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].cityName, '天水', '把「路上」也当成了一个地方');
});

test('封面：城市比上限多时，待得久的先出，返回时按日期排', () => {
  const photos = [];
  // 九座城，第 i 座待 i 天。上限是 8，所以待得最少的那座该被挤掉。
  for (let i = 1; i <= 9; i++) {
    for (let d = 1; d <= i; d++) {
      photos.push(ph(`2026-11-${String(Math.min(d, 28)).padStart(2, '0')}`, `城${i}`, '黄昏的某处', `log:${i}${d}.png`, '某处', `c${i}`));
    }
  }
  const picks = pickPosters(photos);
  assert.equal(picks.length, POSTER_CAP, `上限没生效：出了 ${picks.length} 张`);
  assert.ok(!picks.some((p) => p.cityName === '城1'), '只待过一天的那座挤掉了待得久的');
  for (let i = 1; i < picks.length; i++) {
    assert.ok(picks[i - 1].dateKey <= picks[i].dateKey, '封面没按日期排');
  }
});

test('封面：季节换装饰 —— 春有花藤、夏有汽水、秋有枫叶、冬有雪人', () => {
  assert.equal(seasonOf('2026-03'), 'spring');
  assert.equal(seasonOf('2026-07'), 'summer');
  assert.equal(seasonOf('2026-11'), 'autumn');
  assert.equal(seasonOf('2026-01'), 'winter');
  assert.match(seasonTrim('2026-04'), /花|藤蔓/);
  assert.match(seasonTrim('2026-08'), /汽水|海/);
  assert.match(seasonTrim('2026-10'), /枫叶/);
  assert.match(seasonTrim('2026-12'), /雪人/);
});

test('封面提示词：不让模型写字，只留一块空地', () => {
  /*
   * 2026-11-05 实测四张，「玉泉观」被拆成「玉泉 / 泉观」，「甘海子」写成「甘子」，
   * 「九寨沟」写成「九海沟」。会漏字会换字的渲染器，不能用来写地名。
   * 所以提示词现在反过来要求：**画面里一个字都不要有**。
   */
  const p = posterPrompt({
    cityName: '九寨沟', spot: '中查沟', title: '中查沟的夜空',
    dateKey: '2026-11-05', monthKey: '2026-11',
  });
  assert.match(p, /画面里不要出现任何文字/, '没禁止写字 —— 它就会写错');
  assert.match(p, /留出一大片干净的旧纸/, '没给它留放标题的空地');
  assert.ok(!p.includes('第 7 页'), '又让模型画页码了');
  assert.ok(p.includes('中查沟') && p.includes('九寨沟'), '地名还是要进去的：它得知道画哪儿');
  assert.ok(!p.includes('〇'), '提示词里还有「〇」');
});

test('封面提示词：小红书那几条排版纪律在位', () => {
  // 抄的是纪律，不是「高级感」三个字 —— 每条都能被一张图违反。
  const p = posterPrompt({
    cityName: '天水', spot: '玉泉观', title: '黄昏的玉泉观',
    dateKey: '2026-11-02', page: 1, monthKey: '2026-11',
  });
  assert.match(p, /底色不要纯白/, '没写死「不要纯白」—— 复古感全靠这条');
  assert.match(p, /不要纯黑/, '文字色没约束，出来是屏幕黑而不是油墨');
  assert.match(p, /绝不画封闭的四边框/, '边框没约束，画面会被框闷');
  assert.match(p, /压在照片或手绘的边缘上/, '胶带/邮票没要求参与构图，会变成孤立贴纸');
  assert.match(p, /留白不少于三分之一/, '留白没量化');
  assert.ok(p.includes('枫叶'), '十一月该贴枫叶，提示词里没有');
});

test('封面叠字：地名、日期、页码、她自己的原话都由排版印上去', () => {
  /*
   * 同一个理由：那几行字必须逐字正确，所以不交给画图的，交给 `monthlyReport`。
   * 这里钉的是「叠上去了」——排版层写错字，只有这一条能发现。
   */
  const html = monthlyReport({
    monthKey: '2026-11',
    photos: [ph('2026-11-04', '九寨沟', '黄昏的甘海子', 'log:b.png', '甘海子', 'jiuzhaigou')],
    entries: [{ dateKey: '2026-11-04', cityName: '九寨沟', body: '水在入夜之后还留着颜色。' }],
    posters: [{
      dateKey: '2026-11-04', cityName: '九寨沟', spot: '甘海子',
      file: 'posters/2026-11/x.png', line: '水在入夜之后还留着颜色。',
    }],
    layout: 'poster',
  });
  assert.ok(html.includes('>甘海子<'), '地名没叠上去');
  assert.ok(html.includes('2026 · 11 · 04'), '日期没叠上去');
  assert.ok(html.includes('第 1 页'), '页码没叠上去');
  assert.ok(html.includes('水在入夜之后还留着颜色。'), '日记原话没叠上去');
  assert.ok(html.includes('class="hand"'), '那句话没按手写批注排');
  /*
   * 字号按字数算，封顶 12cqw：三个字是 42/3=14，被上限压到 12 —— 12% × 3 = 36% 宽，
   * 正好落在提示词留的那 40% 空地里。字数再多就继续缩，绝不换行。
   */
  assert.match(html, /font-size:12\.0cqw/, '地名没按字数放大');
});

test('封面：月度报告里有一节专门放它，并且说明了「不是照片」', () => {
  const html = monthlyReport({
    monthKey: '2026-11',
    photos: [ph('2026-11-04', '九寨沟', '黄昏的甘海子', 'log:b.png', '甘海子', 'jiuzhaigou')],
    entries: [{ dateKey: '2026-11-04', cityName: '九寨沟', body: '今天走了一整天。' }],
    posters: [{ dateKey: '2026-11-04', cityName: '九寨沟', spot: '甘海子', file: 'posters/2026-11/x.png' }],
    layout: 'poster',
  });
  assert.ok(html.includes('posters/2026-11/x.png'), '封面路径没排进去');
  assert.ok(html.includes('封面 · 一处一张'), '没有单独一节');
  assert.ok(html.includes('不是照片'), '没告诉看的人这张是画的 —— 那就成了拿画当照片');
  // 真照片那一节不能因为有了封面就消失
  assert.ok(html.includes('../media/b.png'), '真照片被封面挤掉了');
});

test('dateStamp：连字符换成间隔点', () => {
  assert.equal(dateStamp('2026-11-05'), '2026 · 11 · 05');
});

/* ---------------- 图片日记（线圈本，2026-11-05） ---------------- */

const NB_ENTRIES = [
  { dateKey: '2026-11-03', cityName: '九寨沟', body: '黄龙的水是另一种蓝。走栈道走得腿软。' },
  { dateKey: '2026-11-04', cityName: '九寨沟', body: '甘海子的水清得能看见底下的树。' },
];

test('图片日记：一天一段，Day 序号按日期排，照片左右错着贴', () => {
  const html = monthlyReport({
    monthKey: '2026-11',
    photos: [
      ph('2026-11-04', '九寨沟', '黄昏的甘海子', 'log:b.png', '甘海子', 'jiuzhaigou'),
      ph('2026-11-03', '九寨沟', '黄昏的黄龙', 'log:a.png', '黄龙', 'jiuzhaigou'),
    ],
    entries: NB_ENTRIES,
  });
  const d1 = html.indexOf('Day 1.');
  const d2 = html.indexOf('Day 2.');
  assert.ok(d1 > 0 && d2 > d1, 'Day 序号不在页面上，或者顺序反了');
  // 03 那天早于 04，所以 Day1 后面紧跟的应该是黄龙那张
  // 页面上是 mediaFile 之后的文件名（log: 前缀被剥掉了）
  assert.ok(html.indexOf('media/a.png') < html.indexOf('media/b.png'), '照片没按日期排');
  assert.match(html, /class="day flip"/, '两段都贴在同一边 —— 参考图是错开的');
});

test('图片日记：右上角清单列的是她真的到过的地方，不重复', () => {
  const html = monthlyReport({
    monthKey: '2026-11',
    photos: [
      ph('2026-11-03', '九寨沟', '黄昏的黄龙', 'log:a.png', '黄龙', 'jiuzhaigou'),
      ph('2026-11-04', '九寨沟', '黄昏的黄龙', 'log:b.png', '黄龙', 'jiuzhaigou'),
      ph('2026-11-05', '九寨沟', '中查沟的夜空', 'log:c.png', '中查沟', 'jiuzhaigou'),
    ],
    entries: [],
  });
  const box = html.slice(html.indexOf('class="check"'), html.indexOf('</aside>'));
  assert.equal((box.match(/黄龙/g) || []).length, 1, '同一个地方在清单里出现了两次');
  assert.match(box, /中查沟/, '第二个地方没进清单');
});

test('图片日记：便签用她自己写的原话，不编', () => {
  const html = monthlyReport({
    monthKey: '2026-11',
    photos: [ph('2026-11-04', '九寨沟', '黄昏的甘海子', 'log:b.png', '甘海子', 'jiuzhaigou')],
    entries: NB_ENTRIES,
  });
  assert.match(html, /甘海子的水清得能看见底下的树。/, '便签不是她写的那句');
  /*
   * 没有日记就不摆便签 —— 那是这张图上唯一一处「不是她的东西」的位置，
   * 一旦让模型补，整页就有一句是编的。
   */
  const empty = monthlyReport({
    monthKey: '2026-11',
    photos: [ph('2026-11-04', '九寨沟', '黄昏的甘海子', 'log:b.png', '甘海子', 'jiuzhaigou')],
    entries: [],
  });
  assert.equal(empty.includes('class="tip"'), false, '没写日记却摆了一张便签');
});

test('图片日记：照片原样 —— 不加滤镜、不裁比例', () => {
  const html = monthlyReport({
    monthKey: '2026-11',
    photos: [ph('2026-11-04', '九寨沟', '黄昏的甘海子', 'log:b.png', '甘海子', 'jiuzhaigou')],
    entries: NB_ENTRIES,
  });
  // 只在 .pic img 的规则里找 filter —— 加了滤镜，那句「照片是那天的照片」就不成立了
  assert.equal(/\.pic img\s*\{[^}]*filter\s*:/.test(html), false, '给照片加了滤镜');
  assert.equal(/\.pic img\s*\{[^}]*object-fit\s*:/.test(html), false, '把照片裁成了统一比例');
});

test('图片日记：标题用城市名，日期区间取到第一天和最后一天', () => {
  const html = monthlyReport({
    monthKey: '2026-11',
    photos: [
      ph('2026-11-03', '九寨沟', '黄昏的黄龙', 'log:a.png', '黄龙', 'jiuzhaigou'),
      ph('2026-11-05', '九寨沟', '中查沟的夜空', 'log:c.png', '中查沟', 'jiuzhaigou'),
    ],
    entries: [],
  });
  assert.match(html, /九寨沟旅行日记/, '标题没带上城市');
  assert.match(html, /2026\.11\.03 — 11\.05/, '日期区间不对');
});

test('图片日记：一个月什么都没有时，说清楚，不崩', () => {
  const html = monthlyReport({ monthKey: '2026-02', photos: [], entries: [] });
  assert.match(html, /没有留下照片/, '空月份没说清');
  assert.equal(html.includes('<img'), false, '空月份还画了图');
});

test('图片日记：便签不重复正文里已经说过的话', () => {
  /*
   * 第一版便签取「最后一天的日记」，结果 Day5 旁边又贴了同一句 ——
   * 一页纸上把同一句话说了两遍。现在从后往前找第一句没用过的。
   */
  const html = monthlyReport({
    monthKey: '2026-11',
    photos: [
      ph('2026-11-04', '九寨沟', '黄昏的甘海子', 'log:b.png', '甘海子', 'jiuzhaigou'),
      ph('2026-11-05', '九寨沟', '中查沟的夜空', 'log:c.png', '中查沟', 'jiuzhaigou'),
    ],
    entries: [
      { dateKey: '2026-11-04', cityName: '九寨沟', body: '甘海子的水清得能看见底下的树。' },
      { dateKey: '2026-11-05', cityName: '九寨沟', body: '夜里冷得厉害，星星倒是多。' },
      // 同一天的第二篇：正文只取每天第一篇，所以这一句还没被用过
      { dateKey: '2026-11-04', cityName: '九寨沟', body: '晚上吃了碗面，热的一路暖到胃里。' },
    ],
  });
  const tip = html.slice(html.indexOf('class="tip"'), html.indexOf('</aside>', html.indexOf('class="tip"')));
  assert.match(tip, /晚上吃了碗面/, '便签没去找那句没用过的');
  assert.equal(tip.includes('星星倒是多'), false, '便签和 Day5 说了同一句话');

  // 所有句子都在正文里用过了，就干脆不摆便签 —— 宁可不说话，也不重复
  const dup = monthlyReport({
    monthKey: '2026-11',
    photos: [ph('2026-11-04', '九寨沟', '黄昏的甘海子', 'log:b.png', '甘海子', 'jiuzhaigou')],
    entries: [{ dateKey: '2026-11-04', cityName: '九寨沟', body: '甘海子的水清得能看见底下的树。' }],
  });
  assert.equal(dup.includes('class="tip"'), false, '只剩重复的话时还是贴了一张便签');
});

/* ---------------- 季节涂鸦与横格（2026-11-05） ---------------- */

const oneDay = (m) => ({
  monthKey: m,
  photos: [ph(`${m}-05`, '九寨沟', '黄昏的甘海子', 'log:b.png', '甘海子', 'jiuzhaigou')],
  entries: [{ dateKey: `${m}-05`, cityName: '九寨沟', body: '水清得能看见底下的树。' }],
});

test('图片日记：纸面有写字横线，行高与横线同一步长', () => {
  const html = monthlyReport(oneDay('2026-11'));
  assert.match(html, /repeating-linear-gradient\(to bottom,\s*transparent 0 33px, #ece0c7 33px 34px\)/,
    '纸面没有横格线');
  assert.match(html, /\.say \{[^}]*line-height: 34px/, '正文行高没跟横线对齐，字会骑在线上');
});

test('图片日记：四季的涂鸦各不一样，而且不止两三件', () => {
  const count = (h) => (h.match(/class="doodle"/g) || []).length;
  const spring = monthlyReport(oneDay('2026-04'));
  const summer = monthlyReport(oneDay('2026-07'));
  const autumn = monthlyReport(oneDay('2026-11'));
  const winter = monthlyReport(oneDay('2026-01'));
  for (const [name, h] of [['春', spring], ['夏', summer], ['秋', autumn], ['冬', winter]]) {
    assert.ok(count(h) >= 5, `${name}天的涂鸦只有 ${count(h)} 个 —— 太少了`);
  }
  // 每一季有一样只属于它自己的东西（花、汽水、枫叶、雪人）
  assert.match(spring, /stroke="#d98aa8"/, '春天没有花');
  assert.match(summer, /stroke="#e0894f"/, '夏天没有汽水');
  assert.match(autumn, /stroke="#c06a34"/, '秋天没有枫叶');
  assert.match(winter, /stroke="#7fa6cf"/, '冬天没有雪人');
  // 冬天不该还挂着太阳
  assert.equal(/stroke="#e0b25f"/.test(winter), false, '冬天还画着太阳');
});

test('图片日记：胶带一条一种，连着四天不重样', () => {
  const photos = [1, 2, 3, 4].map((d) =>
    ph(`2026-11-0${d}`, '九寨沟', '黄昏的某处', `log:${d}.png`, '某处', 'jiuzhaigou'));
  const html = monthlyReport({ monthKey: '2026-11', photos, entries: [] });
  for (const kind of ['kraft', 'grid', 'stripe', 'roll']) {
    assert.ok(html.includes(`tape--${kind}`), `缺了 ${kind} 那种胶带`);
  }
});

/* ---------------- 年报（2026-11-05） ---------------- */

test('年报：十二个月各一块，总量与逐月对得上', () => {
  const photos = [
    ph('2026-03-04', '杭州市', '黄昏的湖', 'log:a.png', '西湖', 'hangzhou'),
    ph('2026-11-04', '九寨沟', '黄昏的甘海子', 'log:b.png', '甘海子', 'jiuzhaigou'),
  ];
  const entries = [
    { dateKey: '2026-11-04', cityName: '九寨沟', body: '水清得能看见底下的树。' },
  ];
  const html = yearlyHtml({ year: '2026', photos, entries });
  assert.match(html, /旅行年报/);
  assert.match(html, />03</, '三月那块没排出来');
  assert.match(html, />11</, '十一月那块没排出来');
  assert.match(html, /<b>2<\/b>/, '总量没写');
  assert.ok(html.includes('media/a.png') && html.includes('media/b.png'), '两个月的图都没排');
  // 只有两个月有东西，就不该摆十二块空牌子
  assert.equal((html.match(/class="mo"/g) || []).length, 2, '空月份也被排成了块');
});

test('年报：她记下的那座城会用自己的题图', () => {
  const photos = [
    ph('2026-11-01', '九寨沟', '清晨的沟口', 'log:1.png', '沟口', 'jiuzhaigou'),
    ph('2026-11-05', '九寨沟', '中查沟的夜空', 'log:2.png', '中查沟', 'jiuzhaigou'),
  ];
  const html = yearlyHtml({
    year: '2026', photos, entries: [],
    tastes: [{ monthKey: '2026-11', name: '九寨沟', photo: 'log:2.png', note: '抬头就是星' }],
  });
  // 题图该是她在口味里挑的那张（2.png），而不是默认的「中间那张」
  assert.ok(html.includes('media/2.png'), '没按口味里的那张当题图');
  assert.match(html, /抬头就是星/, '口味那句话没排进去');
});

test('年报：一年什么都没有时说清楚，不摆空页', () => {
  const html = yearlyHtml({ year: '2026', photos: [], entries: [] });
  assert.match(html, /还没攒下/, '空年份没说清');
  assert.equal(html.includes('<img'), false, '空年份还画了图');
});

/* ---------------- 城市特色（2026-11-05） ---------------- */

test('城市特色：九寨沟有地标和吃食，兰州有市花，查不到的城市给空对象', () => {
  const jz = featureOf('jiuzhaigou');
  assert.equal(jz.landmark, '五花海');
  assert.equal(jz.food, '牦牛肉汤');
  assert.equal(featureOf('lanzhou').flower, '玫瑰');
  assert.deepEqual(featureOf('不在表里的城'), {}, '查不到时不该瞎给一个');
});

test('月报：页眉带上这座城的三样招牌', () => {
  const html = monthlyReport({
    monthKey: '2026-11',
    photos: [ph('2026-11-04', '九寨沟', '黄昏的甘海子', 'log:b.png', '甘海子', 'jiuzhaigou')],
    entries: [],
  });
  assert.match(html, /地标<\/b>五花海/, '地标没写进页眉');
  assert.match(html, /吃<\/b>牦牛肉汤/, '吃食没写进页眉');
});
