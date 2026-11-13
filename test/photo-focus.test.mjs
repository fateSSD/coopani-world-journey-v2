/**
 * 她自己补的那句「怎么拍」（2026-11-09，1.0.7）。
 *
 * ## 起因
 *
 * Mr.Q 的截图：用户说「拍一下你在公交车上的风景」，她答
 * 「喏，车窗外这一段。我坐得挺靠后。」
 *
 * 前半句工具能表达（`subject` = 车窗外的风景），后半句不能 ——
 * 于是提示词里没有「靠后」这件事，图上自然也不会体现。
 *
 * ## 定的是方案 A（Mr.Q 选的）
 *
 * 只开「怎么拍」（取景、角度、坐在哪），不开「拍什么」。
 * 方案 B 是把整条提示词交给她写 —— 那样她会写出「九寨沟的樱花」，
 * 季节对不上，而且「只拍她真看到的」那条硬线就废了。
 *
 * 所以这条测试守两件事：
 *   1. 加进去的东西**真的进了提示词**（不加等于白做）；
 *   2. 加进去的东西**是干净的**（引号会被模型当招牌画出来，超长会把画面写成叙事）。
 */
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { photoPrompt } = await import('../src/photo.ts');

const base = { city: '成都', cityId: 'chengdu', month: 11, hour: 15, weather: '晴', spot: '宽窄巷子' };

/** 提示词里「她补的那句」都在这一行，按它判断更稳，不受别处措辞影响。 */
const FOCUS_LINE = /这一张想这么拍：([^。]*)/;

test('focus 真的进了提示词', () => {
  const p = photoPrompt({ ...base, focus: '靠后坐，前面好几个人挡着' });
  const m = FOCUS_LINE.exec(p);
  assert.ok(m, `提示词里没有这一句：\n${p}`);
  assert.match(m[1], /靠后坐/, m[1]);
});

test('不传 focus 就一个字都不多 —— 老调用方不受影响', () => {
  const a = photoPrompt({ ...base });
  const b = photoPrompt({ ...base, focus: '' });
  assert.doesNotMatch(a, FOCUS_LINE, '没传 focus 却多出了一句');
  assert.equal(a, b, '空串和没传应当完全一致');
});

test('六个题材都带得上 —— 不能只有风景那条认它', () => {
  /*
   * 这坑 2026-11-06 踩过：几个模板都是提前 return 的，只有 ground 那条拼了季节，
   * 于是「同一座城，街景对得上，换成吃的就变江南了」。focus 走的是同一条路，
   * 所以每个出口都得包一层。
   */
  for (const subject of ['ground', 'sky', 'food', 'street', 'festival', 'detail']) {
    const p = photoPrompt({ ...base, subject, focus: '镜头往上偏一点' });
    assert.match(p, FOCUS_LINE, `${subject} 那条没带上 focus：\n${p.slice(0, 160)}`);
  }
});

test('引号要清掉 —— 不然会被当成招牌画进画面', () => {
  /*
   * `doing` 那边踩过同样的坑：提示词里有「画面里没有文字」的约束，
   * 但挡不住引号里的字 —— 模型会把台词当店招画出来。
   */
  const p = photoPrompt({ ...base, focus: '招牌写着「老成都」的那面墙' });
  const m = FOCUS_LINE.exec(p);
  assert.ok(m, '没写进去');
  assert.doesNotMatch(m[1], /[「」『』“”"]/, `引号没清掉：${m[1]}`);
  assert.match(m[1], /老成都/, '把内容一起删了 —— 该只去壳');
});

test('超 40 字截断 —— 提示词不是叙事的地方', () => {
  const long = '这一段路两边的房子一栋比一栋旧，墙皮一块块掉下来，能看见底下的红砖和水泥，窗户大多空着';
  const p = photoPrompt({ ...base, focus: long });
  const m = FOCUS_LINE.exec(p);
  assert.ok(m, '没写进去');
  /* 省略号自己占一位，所以按 40 个字符 + 「…」判断。 */
  assert.ok(m[1].replace(/…$/, '').length <= 40, `没截断：${m[1].length} 字`);
});

test('太短的不算一句话 —— 一个字不进提示词', () => {
  /* `doing` 那边门槛是 4 字（那是「正在发生的事」，得成句）；focus 是取景补充，2 字起。 */
  for (const bad of ['', ' ', '拍', 'x']) {
    const p = photoPrompt({ ...base, focus: bad });
    assert.doesNotMatch(p, FOCUS_LINE, `「${bad}」不该进提示词`);
  }
  assert.match(photoPrompt({ ...base, focus: '靠后坐' }), FOCUS_LINE, '三个字该算数');
});

test('focus 只加开头不加结尾 —— 结尾那句「画面里没有文字」必须留在最后', () => {
  /*
   * `photoPrompt` 的各条模板都把「画面里没有文字/没有人」这类硬约束放在**末尾**，
   * 模型对最后一句最敏感。插在它后面等于把这句削弱。
   */
  const withFocus = photoPrompt({ ...base, focus: '靠后坐' });
  /*
   * 按位置比，不按「最后一行」—— 提示词是一整段、没有换行，
   * 第一版用 `slice(lastIndexOf('\n'))` 只切到最后一个字符，测试自己先假红了。
   *
   * 判据：focus 那句必须出现在末尾硬约束**之前**。
   */
  const focusAt = withFocus.indexOf('这一张想这么拍');
  const ruleAt = withFocus.indexOf('没有文字，没有水印，没有边框');
  assert.ok(focusAt > 0, '没写进去');
  assert.ok(ruleAt > 0, '取不到末尾那句硬约束，测试本身失效了');
  assert.ok(focusAt < ruleAt, `focus 落到了硬约束后面：${withFocus.slice(ruleAt - 40, ruleAt + 30)}`);
});
