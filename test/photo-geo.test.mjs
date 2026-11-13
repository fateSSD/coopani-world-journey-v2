/**
 * 街景与光 —— 2026-11-07 子 agent 审计出的地理错
 *
 * 三类：
 *   1. **出了国不等于在欧洲**：原来的入口条件是 `country !== 'CN'`，
 *      而 `euLook` 的分支按气候区分，日本/美国没有气候区就掉进「西欧」那一支。
 *      东京的街画成布拉格老街，纽约的街拿到「铸铁壁灯挑在墙上」。
 *   2. **西北不是四合院**：青砖院墙、砖雕门楼、铜钉朱门、石狮子是华北/晋中的形制。
 *   3. **光只看钟点不看纬度**：柏林十二月 15:53 日落，18 点写「黄昏的金色光线」，
 *      而那一刻已经黑透两个多小时；漠河夏至整夜不黑，却写「满天星」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { photoPrompt, skyOf, lightBand } = await import('../src/photo.ts');

const street = (over) => photoPrompt({ hour: 10, month: 6, day: 10, subject: 'street', ...over });

test('东京的街不是布拉格：不给欧洲老城那套', () => {
  const t = street({ city: '东京', cityId: 'tokyo', cityIdx: 1.9 });
  assert.doesNotMatch(t, /联排楼|方形石块|铸铁的|米纸菜单|黑板/, `东京拿到了欧洲老城的街：${t}`);
  assert.match(t, /电线杆|竖排的招牌|自动售货机/, `东京的街没有电线杆和招牌：${t}`);
});

test('纽约的街不是欧洲：方格路网、消防栓', () => {
  const t = street({ city: '纽约', cityId: 'newyork', cityIdx: 2.2 });
  assert.match(t, /方格路网|消防栓|沥青/, `纽约没拿到北美那套：${t}`);
  assert.doesNotMatch(t, /方形石块|铸铁的/, `纽约拿到了欧洲老城的路面：${t}`);
});

test('欧洲的街照旧', () => {
  const t = street({ city: '柏林', cityId: 'berlin', cityIdx: 1.4 });
  assert.match(t, /联排楼|石块/, `柏林的街丢了欧洲的样子：${t}`);
});

test('西安/乌鲁木齐的街不是四合院', () => {
  for (const [city, id] of [['乌鲁木齐', 'wulumuqi'], ['兰州', 'lanzhou']]) {
    const t = street({ city, cityId: id, cityIdx: 1.0 });
    assert.doesNotMatch(t, /砖雕的斗拱|铜钉|石狮子/, `${city} 拿到了四合院的门楼：${t}`);
  }
});

test('深圳不是县城商业街：有塔楼的城市走天际线那一支', () => {
  const t = street({ city: '深圳', cityId: 'shenzhen', cityIdx: 1.9 });
  assert.match(t, /玻璃幕墙|地铁出入口/, `深圳的街没有高楼：${t}`);
});

test('光按纬度走：柏林十二月十八点已经黑透', () => {
  const t = photoPrompt({ city: '柏林', cityId: 'berlin', hour: 18, month: 12, day: 10 });
  assert.doesNotMatch(t, /暖光|金色|斜着打过来/, `柏林十二月十八点还有斜阳：${t}`);
  /* 2026-11-12：判据换成太阳高度角之后，柏林十二月十八点在地平线下十七度。 */
  assert.match(t, /黑|窗灯|路灯/, `没写出天已经黑了：${t}`);
});

test('光按纬度走：柏林六月二十一点还有天光', () => {
  const t = photoPrompt({ city: '柏林', cityId: 'berlin', hour: 21, month: 6, day: 21 });
  assert.doesNotMatch(t, /照不亮周围|窗灯和路灯/, `柏林六月二十一点已经入夜：${t}`);
  assert.match(t, /暖光|亮|光/, `没写出天还没黑：${t}`);
});

test('低纬度不受影响：兰州的十八点还是下午的斜光', () => {
  const t = photoPrompt({ city: '兰州', cityId: 'lanzhou', hour: 18, month: 6, day: 10 });
  /* 兰州六月十八点太阳还在二十六度：那个角度的影子已经斜了，但远没到黄昏。 */
  assert.match(t, /斜着打过来|日光/, `兰州的十八点被改坏了：${t}`);
});

test('极夜与白夜：档位判定', () => {
  /* 摩尔曼斯克 68.97°N，十二月是极夜 */
  assert.equal(lightBand(68.97, 12, 12), 'polarNight');
  /* 同城六月是极昼 */
  assert.equal(lightBand(68.97, 6, 0), 'polarDay');
  /* 圣彼得堡 59.9°N 六月是白夜 */
  assert.equal(lightBand(59.94, 6, 23), 'whiteNight');
  /* 柏林十二月十八点：天黑得早 */
  assert.equal(lightBand(52.52, 12, 18), 'darkEarly');
  /* 柏林六月十八点：正常白天，不该触发 */
  assert.equal(lightBand(52.52, 6, 18), '');
  /* 没有纬度就不判（老调用方的行为） */
  assert.equal(lightBand(0, 12, 18), '');
});

test('极夜的正午不是「蓝天和几朵散云」', () => {
  const t = photoPrompt({
    city: '摩尔曼斯克', cityId: 'murmansk', hour: 12, month: 12, day: 15, subject: 'sky',
  });
  assert.doesNotMatch(t, /蓝天和几朵散云|正午偏硬的光/, `极夜画出了晴天：${t}`);
  assert.match(t, /暮光|太阳始终没上来/, `极夜没写出太阳不上来：${t}`);
});

test('漠河夏至的午夜没有满天星', () => {
  const t = photoPrompt({
    city: '漠河', cityId: 'mohe', hour: 23, month: 6, day: 21, subject: 'sky',
  });
  assert.doesNotMatch(t, /满天星|银河斜过天顶/, `白夜画出了银河：${t}`);
  assert.match(t, /天不黑|灰蓝/, `没写出天不黑：${t}`);
});

test('skyoOf 不传纬度时保持老行为', () => {
  const s = skyOf(23, '晴');
  assert.match(s.told, /满天星/);
  assert.equal(s.stars, true);
});
