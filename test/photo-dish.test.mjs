/**
 * 一道菜一个形制 —— 2026-11-07 用户发来的一张图
 *
 * 他拍的是**担担面**，出来的是一碗清汤面：汤色清亮能看见碗底、浮着几片白萝卜、
 * 一撮香菜、表面一层红油。那是兰州牛肉面。
 *
 * 根因不是「模型不懂担担面」，是**我们只给了它一碗面**：
 * `WARE_CN.noodle` 把兰州牛肉面写死成了所有中国面食的通用碗 ——
 * 当时 81 道「命中 /面|粉/」的菜，全都被画成那一碗。
 *
 * 这里守四件事：
 *   1. 逐菜形制表（`DISH_LOOK`）先命中先用，担担面必须干拌、兰州必须是清汤；
 *   2. 分类先排除再认定 —— 面包、凉粉、粉红果仁糖塔都不是面条；
 *   3. 容器跟着菜走：粥在碗里、锅在锅里、酒在杯里、点心在碟里；
 *   4. 提示词里不许出现 markdown 星号（那是写注释的手滑，模型会当内容）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { photoPrompt, dishKind } = await import('../src/photo.ts');

const eat = (dish, over = {}) => photoPrompt({
  city: '成都', cityId: 'chengdu', hour: 19, month: 11, day: 8, subject: 'food', dish, ...over,
});

/* ------------------------------------------------------------------ 担担面 */

test('担担面是干拌：碗里没有汤，不许出现白萝卜和香菜', () => {
  const t = eat('担担面');
  assert.doesNotMatch(t, /汤色清亮|清汤|能看见碗底/, `担担面被画成了兰州牛肉面：${t}`);
  assert.doesNotMatch(t, /白萝卜|翠绿香菜/, `担担面里放上了兰州牛肉面的配菜：${t}`);
  assert.match(t, /没有汤/, `没告诉模型这碗是干的：${t}`);
  assert.match(t, /酥臊|芽菜/, `担担面的臊子不见了：${t}`);
  assert.match(t, /红油/, `担担面没有红油：${t}`);
});

test('兰州牛肉面还是清汤白萝卜 —— 别把正主一起改掉', () => {
  const t = eat('兰州牛肉面', { city: '兰州', cityId: 'lanzhou' });
  assert.match(t, /清汤/, `兰州牛肉面丢了清汤：${t}`);
  assert.match(t, /白萝卜/, `兰州牛肉面丢了白萝卜片：${t}`);
});

test('凡是干拌，一律不许写汤', () => {
  for (const dish of ['热干面', '炸酱面', '葱油拌面', '甜水面', '南昌拌粉', '桂林米粉', '海南粉']) {
    const t = eat(dish);
    assert.match(t, /没有汤|不见汤|干拌/, `${dish} 应该有「没有汤 / 干拌」这一句：${t}`);
    assert.doesNotMatch(t, /汤面浮着|汤只到碗的一半/, `${dish} 的碗里被倒了汤：${t}`);
  }
});

/* ------------------------------------------------------------------ 分类 */

test('面包、凉粉、糖塔都不是面条', () => {
  const cases = [
    ['粉红果仁糖塔 tarte aux pralines', 'cake'],
    ['Choripán 烤肠面包', 'bread'],
    ['苏打面包 soda bread', 'bread'],
    ['鸡豆凉粉', 'jelly'],
    ['浑源凉粉', 'jelly'],
    ['葛根粉', 'jelly'],
    ['小米（薯粉饺）', 'jelly'],
    ['纳瓦霍炸面包', 'bread'],
  ];
  for (const [dish, want] of cases) {
    assert.equal(dishKind(dish), want, `「${dish}」被判成了 ${dishKind(dish)}`);
  }
});

test('容器跟着菜走：粥在碗里、锅在锅里、酒在杯里、点心在碟里', () => {
  const wants = [
    ['艇仔粥', 'bowl'],
    ['铁锅炖大鹅', 'pot'],
    ['小鸡炖蘑菇', 'pot'],
    ['科隆啤酒 Kölsch', 'drink'],
    ['北京烤鸭', 'grill'],
    ['南翔小笼', 'tea'],
    ['片儿川', 'noodle'],
    ['波兰饺子 pierogi', 'plate'],
    ['红烧肉', 'plate'],
    ['毛血旺', 'bowl'],
  ];
  for (const [dish, want] of wants) {
    assert.equal(dishKind(dish), want, `「${dish}」被判成了 ${dishKind(dish)}`);
  }
});

test('啤酒是杯子，焦点在杯口；点心是碟，焦点在碟沿', () => {
  const beer = eat('科隆啤酒 Kölsch', { city: '科隆', cityId: 'cologne' });
  assert.match(beer, /玻璃杯/, `啤酒没装进杯子：${beer}`);
  assert.match(beer, /杯口/, `一杯酒却说对焦在别处：${beer}`);
  assert.doesNotMatch(beer, /陶盘|瓷盘/, `一杯酒装进了盘子：${beer}`);

  const tart = eat('萨赫蛋糕 Sachertorte', { city: '维也纳', cityId: 'vienna' });
  assert.match(tart, /碟/, `蛋糕没放在碟子里：${tart}`);
});

test('面包与凉粉不冒热气，粥和锅冒', () => {
  for (const dish of ['苏打面包 soda bread', '鸡豆凉粉']) {
    assert.doesNotMatch(eat(dish), /热气在(光里|灯下)升起来/, `${dish} 在冒热气`);
  }
  for (const dish of ['艇仔粥', '铁锅炖大鹅']) {
    /* 2026-11-12：夜里改成「在灯下升起来」—— 那时唯一的光源是灯。 */
    assert.match(eat(dish), /热气在(光里|灯下)升起来/, `${dish} 没有热气`);
  }
});

/* ------------------------------------------------------------------ 全量 */

/** 把 cities.ts 里的 FOODS 全抓出来 —— 分类规则要对着真数据验，不是对着我编的。 */
function allDishes() {
  const src = readFileSync(new URL('../src/geo/cities.ts', import.meta.url), 'utf8');
  const start = src.indexOf('const FOODS');
  const end = src.indexOf('\n};', start);
  const out = [];
  for (const m of src.slice(start, end).matchAll(/\[([^\]]*)\]/g)) {
    for (const q of m[1].matchAll(/'([^']+)'/g)) out.push(q[1]);
  }
  return [...new Set(out)];
}

test('全量菜名：分类不许把面包、凉粉、糖塔当面条', () => {
  const bad = [];
  for (const d of allDishes()) {
    if (dishKind(d) !== 'noodle') continue;
    if (/面包|凉粉|凉皮|糖塔|果仁糖|疙瘩|通心粉|面球|面饼/.test(d)) bad.push(d);
  }
  assert.deepEqual(bad, [], `这些被当成了面条：${bad.join('、')}`);
});

test('全量菜名：提示词里不出现 markdown 星号', () => {
  const bad = [];
  for (const d of allDishes()) {
    if (eat(d).includes('**')) bad.push(d);
  }
  assert.deepEqual(bad, [], `提示词里混进了 ** ：${bad.slice(0, 5).join('、')}`);
});

test('全量菜名：酒水必须是杯子，不能上盘', () => {
  const bad = [];
  for (const d of allDishes()) {
    if (dishKind(d) !== 'drink') continue;
    if (/陶盘|瓷盘|粗陶盘/.test(eat(d))) bad.push(d);
  }
  assert.deepEqual(bad, [], `这些酒水被装盘了：${bad.join('、')}`);
});
