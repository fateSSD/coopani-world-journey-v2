/**
 * 节日与季节不许自相矛盾 —— 2026-11-07 子 agent 审计出的一批
 *
 * 四类错，都是**同一张图里两句互相否定**或**不可能的画面**：
 *   1. 南半球的圣诞：悉尼十二月画出一片压着薄雪的圣诞集市（那天三十度）
 *   2. 热带的一月：三亚/海口画出一层积雪的屋檐和檐下冰棱
 *   3. 二月下旬掉进秋天：三元链只覆盖到 2/20，21 号之后全国出一地银杏
 *   4. 视觉锚点里写死的冬季：柏林七月「屋顶压一层薄雪」+ 季节句「树荫浓绿」
 *
 * 加上一条更基础的：中秋的月亮不许「大得不成比例」——
 * 真实满月视直径半度，和拇指盖差不多，那种占满画面的月亮是长焦压缩，肉眼没有。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { photoPrompt } = await import('../src/photo.ts');

const shot = (over) => photoPrompt({
  hour: 14, month: 12, day: 20, subject: 'festival', ...over,
});

test('南半球的十二月：不下雪，是夏天', () => {
  const t = shot({ city: '悉尼', cityId: 'sydney' });
  assert.doesNotMatch(t, /薄雪|毛毡|羊毛袜|姜饼/, `悉尼十二月下雪了：${t}`);
  assert.match(t, /遮阳伞|露天座位/, `悉尼十二月该是露天座位：${t}`);
});

test('北半球的十二月：圣诞集市照旧', () => {
  const t = shot({ city: '柏林', cityId: 'berlin' });
  assert.match(t, /薄雪|姜饼|羊毛袜/, `柏林的圣诞集市没了：${t}`);
});

test('热带的一月：有灯笼，没有冰棱', () => {
  for (const [city, id] of [['三亚', 'sanya'], ['海口', 'haikou'], ['香港', 'xianggang']]) {
    const t = shot({ city, cityId: id, month: 1, day: 10 });
    assert.doesNotMatch(t, /雪压|冰棱|冰花/, `${city} 一月结了冰：${t}`);
    assert.match(t, /灯笼|年桔|桃花/, `${city} 一月该有年味：${t}`);
  }
});

test('北方的一月：雪压瓦片、檐下冰棱都在', () => {
  const t = shot({ city: '哈尔滨', cityId: 'haerbin', month: 1, day: 10 });
  assert.match(t, /雪压|冰棱/, `哈尔滨一月没有冬天：${t}`);
});

test('二月下旬不再掉进秋天', () => {
  for (const day of [21, 24, 28]) {
    const t = shot({ city: '北京', cityId: 'beijing', month: 2, day });
    assert.doesNotMatch(t, /银杏|柿子/, `2 月 ${day} 日出来一地银杏：${t}`);
  }
});

test('中秋的月亮不许大得不成比例', () => {
  const t = shot({ city: '杭州', cityId: 'hangzhou', month: 9, day: 15 });
  assert.doesNotMatch(t, /大得不成比例/, `月亮被画成了一轮巨月：${t}`);
  assert.match(t, /瓦当|拇指|一轮橙黄/, `月亮该写实际大小：${t}`);
});

test('视觉锚点里不再写死季节：柏林七月没有屋顶的雪', () => {
  const t = photoPrompt({ city: '柏林', cityId: 'berlin', hour: 14, month: 7, day: 10 });
  assert.doesNotMatch(t, /薄雪|积雪/, `柏林的七月屋顶有雪：${t}`);
  /* 季节句还在，两张图不能一个夏天一个冬天 */
  assert.match(t, /绿|叶/, `柏林七月的季节句不该是空的：${t}`);
});

test('札幌八月：没有雪墙，也没有一句季节句能纠正它', () => {
  const t = photoPrompt({ city: '札幌', cityId: 'sapporo', hour: 14, month: 8, day: 10 });
  assert.doesNotMatch(t, /积雪|雪墙|白雪/, `札幌八月还在下雪：${t}`);
});
