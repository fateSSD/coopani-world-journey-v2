/*
 * 照片的光要和钟点对得上（2026-11-10）。
 *
 * 起因是 Mr.Q 一张截图：「晚上拍的跟白天一样，这对嘛」。
 * 那是凌晨 0 点在火车上拍的，出来是一张傍晚的图 —— 晚霞、蓝天、绿油油的田。
 *
 * 查提示词，两处都在往亮里推：
 *
 *   1. `hour < 6` 一律写成「天还没亮的蓝调时刻」—— **0 点被当成了黎明**。
 *      蓝调时刻是日出前三四十分钟的事，半夜的窗外是一片黑。
 *   2. 末尾固定挂着「胶片质感，**自然光**，景深自然」。前一句刚说「深夜，天是黑的」，
 *      最后一句又说自然光 —— 而模型对靠后的句子更敏感，于是又往亮里画。
 *
 * 这个文件守的就是这两条：**分段要对，措辞不能自相矛盾。**
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { photoPrompt, lightBand } = await import('../src/photo.ts');

/** 凌晨在火车上看窗外 —— 就是出事那张的现场。 */
const ROAD = { city: '昆明', cityId: 'kunming', month: 11, weather: '晴', onRoad: true, mode: '火车', view: 'ground' };

const at = (hour) => photoPrompt({ ...ROAD, hour });

test('半夜是深夜，不是蓝调', () => {
  /*
   * 0 点 / 3 点：窗外全黑，只有远处零星的灯。
   * 写成「蓝调时刻」，模型就画一个黎明 —— 用户看到的是「晚上跟白天一样」。
   *
   * 2026-11-12 改判据：光不再按钟点分档，改成太阳高度角。
   * 昆明十一月 0–3 点太阳在地平线下三十多度，是天文夜 —— 断言守的
   * 还是「夜里不许写成黎明」这件事，只是不再钉具体措辞。
   */
  for (const hour of [0, 1, 3]) {
    const p = at(hour);
    assert.match(p, /黑|夜/, `${hour} 点没说是深夜：${p.slice(0, 80)}`);
    assert.doesNotMatch(p, /蓝调/, `${hour} 点被写成了蓝调时刻`);
  }
});

test('蓝调只在日出前后，不在半夜', () => {
  /*
   * 蓝调时刻（blue hour）是太阳在地平线下 4–10 度的那一小段，
   * 不是「六点以前」。昆明十一月日出在七点十分上下，蓝调落在七点。
   *
   * 原来这条钉的是 4–5 点 —— 那正是「半夜被写成黎明」的同一个错，
   * 只是它当时被写成了测试。
   */
  for (const hour of [0, 3, 5]) {
    assert.doesNotMatch(at(hour), /蓝调/, `${hour} 点不该是蓝调`);
  }
  assert.match(at(7), /蓝调/, '日出前那一段没给蓝调');
});

test('白天要有日光，别把白天也写成夜', () => {
  /*
   * 原来钉的是「自然光」这个词。2026-11-12 把它从尾句里删了 ——
   * 那是个总体判断词，排在最后，会把前面算出来的光全部推翻
   * （0 点那张「晚上跟白天一样」就是它干的）。
   *
   * 现在守语义：白天要有日光，夜里那几句一个字都不许出现。
   */
  for (const hour of [9, 12, 17]) {
    const p = at(hour);
    assert.match(p, /日光|斜光|斜着打过来|顶光|暖光/, `${hour} 点没有日光：${p.slice(0, 90)}`);
    assert.doesNotMatch(p, /深夜|蓝调|窗灯/, `${hour} 点写成了夜里`);
  }
  assert.doesNotMatch(at(12), /自然光/, '「自然光」又回尾句了 —— 它会把夜写成白天');
});

test('阴天不说「金色光线」—— 这条 todo 已经转正（2026-11-10）', () => {
  /*
   * 原来是挂着的 todo：19 点 + 天气阴，提示词是「黄昏的金色光线。天气阴。」
   * 两句在打架，注释写着「改成不说金色那天，把这条 todo 转成正式断言」。
   *
   * 2026-11-12：「天气阴」这三个字也从提示词里删了 —— 那是气象分类，画不出形状，
   * 还会给模型一片灰蓝天光。现在阴天由「天是一整片灰白的云」正面说出来。
   */
  const p = photoPrompt({ ...ROAD, hour: 17, weather: '阴' });
  assert.match(p, /灰|云/, '阴天没写出云');
  assert.doesNotMatch(p, /金色|暖光/, `阴天还在说暖光：${p.slice(0, 120)}`);
  /* 但阴天不等于没有傍晚 —— 时段本身要留着，只是把「金」去掉。 */
  assert.match(p, /灰|散|平/, '阴天把光整段删了，那是矫枉过正');
});

test('lightBand 只管特例，普通城市普通月份不该返回档位', () => {
  /*
   * 极圈 / 白夜 / 高纬早黑晚亮才返回档位，其余交给小时分段。
   * 昆明（25°N）十一月任何时刻都不该命中特例 —— 命中了就说明判定条件放太宽。
   */
  for (let h = 0; h < 24; h++) {
    assert.equal(lightBand(25, 11, h), '', `昆明 11 月 ${h} 点不该命中特例`);
  }
  /* 反例：哈尔滨（45.7°N）十二月 17 点早就黑透了。 */
  assert.equal(lightBand(45.7, 12, 17), 'darkEarly', '高纬冬天天黑得早，这条没生效');
});

test('阴雨天不许出现「阳光」「金色」 —— 一句提示词里不能有两句互斥的光', () => {
  /*
   * 2026-11-10 的同一次排查里发现的第二个矛盾：
   * 19 点 + 天气阴，提示词是「黄昏的**金色光线**。天气**阴**。」——
   * 模型挑哪句看运气。
   *
   * 这跟「深夜 + 自然光」是同一类错，所以按同一类守：
   * **写完读一遍，问这两句能同时成立吗。**
   */
  const base = { city: '昆明', cityId: 'kunming', month: 11, onRoad: true, view: 'ground' };
  for (const hour of [7, 9, 12, 15, 19]) {
    const t = photoPrompt({ ...base, hour, weather: '阴' });
    assert.doesNotMatch(t, /金色|明亮日光|低角度的暖光|斜着打过来/,
      `${hour} 点阴天还写着太阳：${t.slice(0, 120)}`);
  }
  /* 反过来：晴天该有的还得有，别为了消矛盾把晴天的光削平。
     昆明十一月十八点太阳还有六度，是低角度暖光；十九点已经落下去了。 */
  const clear = photoPrompt({ ...base, hour: 18, weather: '晴' });
  /* 措辞跟着实图改过一次：「暖」出现两次会烧成落日大片，现在只在天那一句说泛暖。 */
  assert.match(clear, /很低的角度|暖/, `晴天黄昏没给低角度光：${clear.slice(0, 120)}`);
});

test('入夜不写「灯光」这种泛词 —— 它会把夜画亮', () => {
  /*
   * 「入夜后的灯光」属于城市夜景（霓虹、橱窗、街灯连成一条）。
   * 而这条分支也走田野、村庄、公路 —— 在那儿写「灯光」，模型会给整条路铺一圈亮源。
   *
   * 现在的写法是「入夜，天已经黑透，只有零星的窗灯和车灯」：
   * 说清光从哪来、有多少，而不是「有灯光」这件事。
   */
  const base = { city: '昆明', cityId: 'kunming', month: 11, onRoad: true, view: 'ground' };
  for (const hour of [20, 22, 23]) {
    const t = photoPrompt({ ...base, hour, weather: '晴' });
    assert.doesNotMatch(t, /入夜后的灯光/, `${hour} 点还在说「灯光」`);
    assert.match(t, /黑/, `${hour} 点没说天黑：${t.slice(0, 120)}`);
  }
});


/* ---------------- 夜的语义：不是把白天调暗，是「看不见」（2026-11-10 第二轮） ---------------- */

test('夜里的天气不许写成「阴」—— 那会画出灰蓝的天', () => {
  /*
   * Mr.Q 看了实图说：「你这个我感觉是小雨天的白天。」
   *
   * 天空是压着云的灰蓝、田里能看清绿色 —— 那是阴雨天的傍晚。
   * 直接来源是提示词里的 `天气阴`：半夜其实什么天色都看不见，
   * 阴和晴在夜里长得一模一样，写上去只会让模型画一片灰蓝。
   *
   * 雨雪雾不一样：灯附近看得见，保留。
   */
  const base = { ...ROAD, weather: '阴' };
  for (const hour of [0, 2, 21, 23]) {
    const p = photoPrompt({ ...base, hour });
    assert.doesNotMatch(p, /天气阴/, `${hour} 点还写着「天气阴」：${p.slice(0, 100)}`);
  }
  /* 但雨天要保留 —— 雨在灯下看得见。2026-11-12 起不再写「天气雨」，
     改成写下雨看得见什么（雨丝、地面湿亮）。 */
  const rainy = photoPrompt({ ...ROAD, hour: 0, weather: '雨' });
  assert.match(rainy, /雨/, '夜里把雨也吞掉了，那是矫枉过正');
});

test('夜里要说「其余部分是暗的」，不能只说「深夜」', () => {
  /*
   * 第一版只换掉「光」那一句（深夜 / 暗光），结果图里田还看得清颜色。
   * 原因是场景描述「田野、村庄和路」本身是白天的语言 —— 默认可视、有颜色。
   *
   * 夜不是把白天的图调暗，夜是「看不见」。所以必须正面说清其余部分是暗的。
   */
  for (const hour of [0, 3, 22]) {
    const p = photoPrompt({ ...ROAD, hour, weather: '晴' });
    assert.match(p, /黑|暗|轮廓/, `${hour} 点没说暗`);
    /* 「景深自然」是说画面清楚，和夜拍冲突，夜里必须去掉。 */
    assert.doesNotMatch(p, /景深自然/, `${hour} 点还挂着「景深自然」（那是说画面清楚）`);
  }
  /* 白天这两个都该在，守住「别矫枉过正」。2026-11-12：尾部只剩「胶片颗粒」，
     「景深自然」也删了 —— 它和「自然光」一样是总体判断词。 */
  const noon = photoPrompt({ ...ROAD, hour: 12, weather: '晴' });
  assert.match(noon, /胶片颗粒/, '白天把胶片颗粒也删了');
  assert.doesNotMatch(noon, /暗部没有细节/, '正午说画面是暗的');
});

/* ---------------- 星星：看天气，不看钟点（2026-11-10） ---------------- */

test('阴雨夜禁星，晴夜不禁 —— 她抬头上天时星星是主角', async () => {
  /*
   * 我第一版把 `stars, moon, moonlight` 写死在夜间负向里，本意是修
   * 「阴天的夜空冒出三颗星」。Mr.Q 当天就纠回来：「星星得可以画，
   * 至少得在桌宠看星星的时候，能拍出来。」
   *
   * 判据：**看天气，不看钟点。** 阴雨夜确实不该有星；晴夜当然该有，
   * 哪怕只是路上顺手一张，天上带几颗也是真的。
   */
  const { nightNegative } = await import('../src/photo.ts');
  assert.match(nightNegative('阴'), /stars/, '阴天还不禁星，会画出三颗假星');
  assert.match(nightNegative('雨'), /stars/, '雨天要禁星');
  assert.doesNotMatch(nightNegative('晴'), /stars/, '晴夜把星也禁了 —— 看星星拍不出来');
  assert.doesNotMatch(nightNegative('多云'), /stars/, '多云夜在光污染低的地方看得见亮星');
  /* 「鱼肚白」那条跟天气无关，任何夜都要压。 */
  for (const w of ['阴', '晴', '多云']) {
    assert.match(nightNegative(w), /bright horizon/, `${w} 夜没压地平线亮边`);
  }
});

test('抬头拍天：天上有没有星由 skyOf 说，别再说「只有远处几个亮点」', async () => {
  const road = photoPrompt({ ...ROAD, hour: 0, weather: '晴', view: 'ground' });
  const skyShot = photoPrompt({ ...ROAD, hour: 0, weather: '晴', view: 'sky' });
  /* 路上的版本可以提灯，抬头的版本不能 —— 画面里没有路。 */
  assert.match(road, /窗灯|路灯/, '路上那张该有灯');
  assert.doesNotMatch(skyShot, /窗灯|路灯/, `抬头那张不该提路上灯：${skyShot.slice(0, 120)}`);
  /* 晴夜抬头，天上有星要说得出来。 */
  assert.match(skyShot, /星/, '晴夜抬头却没提星');
  /* 阴夜抬头，skyOf 会说云 —— 不许出现满天星。 */
  const cloudySky = photoPrompt({ ...ROAD, hour: 0, weather: '阴', view: 'sky' });
  assert.doesNotMatch(cloudySky, /满天星|银河/, `阴夜抬头却给了满天星：${cloudySky.slice(0, 140)}`);
});

/* ============ 重拍不该按「此刻几点」判夜（2026-11-11） ============ */

test('重拍一律不算夜拍 —— 提示词是他自己写的，别按我现在的钟点改写它', async () => {
  const { shotIsNight } = await import('../src/photo.ts');
  // 昆明，11 月，凌晨 2 点
  assert.equal(shotIsNight({ repaint: false, lat: 25, month: 11, hour: 2 }), true, '正常拍照，凌晨就是夜拍');
  assert.equal(
    shotIsNight({ repaint: true, lat: 25, month: 11, hour: 2 }),
    false,
    '重拍白天那张，哪怕现在是凌晨也不该套夜色负向',
  );
});

test('重拍判夜的修复不影响正常拍照', async () => {
  const { shotIsNight } = await import('../src/photo.ts');
  assert.equal(shotIsNight({ repaint: false, lat: 25, month: 11, hour: 14 }), false, '下午该是白天');
  assert.equal(shotIsNight({ repaint: false, lat: 25, month: 11, hour: 21 }), true, '晚上九点该是夜');
  // 重拍在白天也不该被判成夜（repaint 分支直接返回 false）
  assert.equal(shotIsNight({ repaint: true, lat: 25, month: 11, hour: 14 }), false);
});
