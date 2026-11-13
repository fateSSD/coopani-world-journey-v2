/**
 * 「同一座城，街景对得上，吃的不对」—— 2026-11-07 用户反馈
 *
 * 原话：
 *   「同一个城，街景和『吃』是不是走的不是一套提示词」
 *   「我那那张街景对得上，湖面结冰、红石头都在」
 *   「换成吃的就变江南去了」
 *
 * 查下来确实不是一套：街景那条会拼上**视觉锚点 + 季节**（所以结冰的湖、红石头都在），
 * 而 `foodPrompt` 只用菜名的字面挑一套碗筷，**一个字都没提这座城**。
 * 于是不管在哪儿拍，出来的都是「白瓷大碗 + 红油泼辣子 + 一次性竹筷」——
 * 那套东西是江南/川渝路边馆子的默认值，模型自然就往那儿画。
 *
 * 这里守的是三件事：
 *   1. 食物提示词里必须有「这是哪儿」的证据（桌子、窗子），且按气候区分
 *   2. 中国以外不许出现中式那套（红油、竹筷、翠绿香菜）
 *   3. 冬天的高纬度是雪光，不是绿树 —— 两个题材的季节判断要一致
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { photoPrompt } = await import('../src/photo.ts');

const food = (over = {}) => photoPrompt({
  city: '华沙',
  cityId: 'warsaw',
  hour: 19,
  month: 1,
  day: 12,
  subject: 'food',
  dish: '波兰饺子',
  ...over,
});

test('中国以外的城：不许出现中式那套碗筷与红油', () => {
  const t = food();
  for (const cn of ['红油泼辣子', '一次性竹筷', '香油蒜泥', '干碟', '翠绿香菜']) {
    assert.ok(!t.includes(cn), `华沙的饺子配了「${cn}」—— 这就是那条反馈：换成吃的就变江南了\n${t}`);
  }
  assert.match(t, /华沙的波兰饺子/, `菜名没带上地名：${t}`);
  assert.match(t, /亚麻桌布/, `没给这张桌子一个「在波兰」的样子：${t}`);
});

test('中国的城：原来那套照旧，别改坏了', () => {
  const t = food({ city: '成都', cityId: 'chengdu', month: 6, dish: '甜水面', hour: 19 });
  assert.match(t, /红油泼辣子/, `成都的甜水面没给红油：${t}`);
  assert.match(t, /仿石桌面/, `成都的桌子不对：${t}`);
  /* 夏天不该有雪光 */
  assert.doesNotMatch(t, /雪光|水汽/, `六月的成都在下雪：${t}`);
});

test('冬天的高纬度：窗外是雪光，两个题材说法一致', () => {
  const t = food({
    city: '伊尔库茨克', cityId: 'irkutsk', month: 1, dish: '布扎', hour: 13,
  });
  assert.match(t, /雪光|水汽/, `伊尔库茨克一月没有冷的意思：${t}`);

  const street = photoPrompt({
    city: '伊尔库茨克', cityId: 'irkutsk', hour: 13, month: 1, day: 12, subject: 'street',
  });
  /*
   * 街景那条本来就会拼季节（用户说它「对得上」正是因为这一点）。
   * 这里只断言两边都不出现「绿叶」这种夏天意象 —— 一张雪地一张绿树，
   * 同一个城市同一天，看起来就不是一个地方。
   */
  assert.doesNotMatch(t, /绿叶|浓绿/, `食物那条把冬天画成了夏天：${t}`);
  assert.doesNotMatch(street, /绿叶|浓绿/, `街景那条把冬天画成了夏天：${street}`);
});

test('带汤的才冒热气；盘子里的饺子不冒', () => {
  const dumpling = food({ hour: 19 });
  assert.doesNotMatch(dumpling, /热气在(光里|灯下)升起来/, `一盘饺子在冒热气：${dumpling}`);
  assert.match(dumpling, /盘沿/, `盘子却说碗沿：${dumpling}`);

  const noodle = food({ city: '兰州', cityId: 'lanzhou', month: 11, dish: '牛肉面', hour: 19 });
  /* 2026-11-12：十九点兰州太阳已落下，光源只剩灯，措辞跟着换成「在灯下」。 */
  assert.match(noodle, /热气在(光里|灯下)升起来/, `一碗热面没有热气：${noodle}`);
  assert.match(noodle, /碗沿/, `碗却说盘沿：${noodle}`);
});

test('查不到城市时退回老口径，不因为缺一个 id 就乱掉', () => {
  const t = photoPrompt({ city: '某个地方', hour: 12, month: 6, day: 1, subject: 'food', dish: '一碗面' });
  assert.match(t, /某个地方的一碗面/, t);
  /* 没有 cityId 就当中国处理 —— 那是加题材之前的行为 */
  assert.match(t, /白瓷大碗/, `没有城市 id 时把老行为改掉了：${t}`);
  assert.match(t, /塑料桌布/, `没有气候区时该用默认桌面：${t}`);
});
