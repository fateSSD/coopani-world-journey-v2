/**
 * 视觉锚点也得看季节。
 *
 * Discussion #586（2026-11-07）：婺源十一月拍地面照，季节句写着「银杏金黄，乌桕转红」，
 * 画面正中却是一整片明黄的油菜花 —— 秋天和春天同框。
 *
 * 用户拿 ComfyUI 做了对照实验：只删掉锚点里「，油菜花田成片明黄」那半句，
 * 明黄像素从 9.7% 降到 2.3%。判据很直白：锚点里那半句就是唯一的触发源。
 */
const { vistaOf } = await import('../src/geo/cities.ts');
const { photoPrompt } = await import('../src/photo.ts');
const assert = (await import('node:assert/strict')).default;
const { test } = await import('node:test');

test('婺源：三月有油菜花，十一月没有', () => {
  assert.match(vistaOf('wuyuan', 3), /油菜花/);
  assert.doesNotMatch(vistaOf('wuyuan', 11), /油菜花/, '十一月还写着油菜花');
  /* 其余部分不许被误删 —— 只摘那一句 */
  assert.match(vistaOf('wuyuan', 11), /马头墙/);
  assert.match(vistaOf('wuyuan', 11), /溪水清浅/);
});

test('汉中、林芝、大阪：花期之外同样摘掉', () => {
  assert.doesNotMatch(vistaOf('hanzhong', 11), /油菜花/);
  assert.match(vistaOf('hanzhong', 3), /油菜花/);
  assert.doesNotMatch(vistaOf('linzhi', 11), /桃花/);
  assert.match(vistaOf('linzhi', 3), /桃花/);
  assert.doesNotMatch(vistaOf('osaka', 11), /樱花/);
  assert.match(vistaOf('osaka', 4), /樱花/);
});

test('不传月份 = 老行为，一个字不动', () => {
  assert.match(vistaOf('wuyuan'), /油菜花/);
  assert.match(vistaOf('wuyuan', 0), /油菜花/);
});

test('没有花的锚点一个字都不动', () => {
  const a = vistaOf('beijing', 1);
  const b = vistaOf('beijing', 7);
  assert.equal(a, b, '北京锚点被月份改动了');
  assert.ok(a.length > 10);
});

test('摘到一段不剩就原样返回 —— 宁可多一句花，也不要空锚点', () => {
  /* 造一个全靠花支撑的锚点不存在于真实数据里，这里只守「非空」这条线。 */
  for (const id of ['wuyuan', 'hanzhong', 'linzhi', 'osaka']) {
    for (const m of [1, 4, 7, 10, 12]) {
      assert.ok(vistaOf(id, m).trim().length > 0, `${id} ${m} 月锚点空了`);
    }
  }
});

test('生图提示词跟着月份走：十一月不再出现油菜花', () => {
  const nov = photoPrompt({ city: '婺源', cityId: 'wuyuan', spot: '篁岭', hour: 15, month: 11, day: 8, subject: 'ground' });
  assert.doesNotMatch(nov, /油菜花/, '十一月的地面照还带着油菜花');
  const mar = photoPrompt({ city: '婺源', cityId: 'wuyuan', spot: '篁岭', hour: 15, month: 3, day: 8, subject: 'ground' });
  assert.match(mar, /油菜花/, '三月的地面照没有油菜花了');
});
