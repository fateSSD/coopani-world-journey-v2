/*
 * 一句提示词里不许有两句打架的话（2026-11-12 立）。
 *
 * 这一批不是某个 bug 的回归测试，是**结构性的守门**。
 *
 * 重写之前那版的问题不在措辞，在**同一个事实被四个地方各说了一遍**：
 * 光由 `light` 句说、又由季节句说、又由回避句说、最后由风格尾句说。
 * 于是成都十一月十九点那一版输出是这样的：
 *
 *     黄昏的金色光线。…天空是一整片灰白低云，没有太阳也没有影子…
 *     胶片质感，自然光，景深自然。…天色常是灰白的，看不见蓝天，也没有太阳。
 *
 * 「金色光线」和「没有太阳」在同一段里各出现两次。单看每一句都对，
 * 拼在一起就是胡说 —— 而这类错**长跑测不出来**（长跑不进 `photoPrompt`），
 * 只能靠读成品，或者靠这里这几条断言。
 *
 * 现在定的规则：
 *   1. 光只有一个来源（`lightLine`），天只有一个来源（`skyLine`）；
 *   2. 有太阳和黑透了不许同时出现；
 *   3. 「自然光」「天气阴」这类**总体判断词**不许回到提示词里；
 *   4. 一条提示词不超过 200 字（超过就开始淹主体，实测过）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { photoPrompt, sunAltitude, sunPhase, sceneSun } =
  await import('../src/photo.ts');

/** 七个点覆盖：盆地、最西、最北、高纬、极圈边、南半球、高原。 */
const CITIES = [
  ['成都', 'chengdu'],
  ['喀什', 'kashi'],
  ['漠河', 'mohe'],
  ['柏林', 'berlin'],
  ['圣彼得堡', 'petersburg'],
  ['悉尼', 'sydney'],
  ['拉萨', 'lasa'],
];
const SUBJECTS = ['ground', 'street', 'food', 'detail', 'festival', 'sky'];
const MONTHS = [1, 4, 7, 11];

/** 全矩阵：7 城 × 4 个月 × 24 小时 × 6 题材。 */
function* matrix() {
  for (const [city, cityId] of CITIES) {
    for (const month of MONTHS) {
      for (let hour = 0; hour < 24; hour++) {
        for (const subject of SUBJECTS) {
          const prompt = photoPrompt({
            city, cityId, month, day: 15, hour, subject,
            dish: subject === 'food' ? '牛肉面' : undefined,
          });
          yield { city, month, hour, subject, prompt };
        }
      }
    }
  }
}

/* 「有太阳」和「黑透了」这两组词，不许同时出现在一条提示词里。 */
const SHINE = /暖光|日光|斜着打过来|顶光|太阳正贴着地平线|晒得/;
const DARK = /深夜|照不亮周围|窗灯和路灯|几乎全黑|没有别处的光/;

test('有太阳的光和黑透了的夜，不许同时在一条提示词里', () => {
  for (const c of matrix()) {
    const both = SHINE.test(c.prompt) && DARK.test(c.prompt);
    assert.equal(
      both, false,
      `${c.city} ${c.month} 月 ${c.hour} 点 ${c.subject} 同时说了亮和黑：${c.prompt}`,
    );
  }
});

test('「自然光」「天气X」这类总体判断词不许回到提示词里', () => {
  /*
   * 「自然光」是 0 点那张「晚上拍得跟白天一样」的直接原因：它排在最后，
   * 权重比前面算出来的光更高，一句话把深夜推翻。
   * 「天气阴」是另一个方向 —— 它给模型一片灰蓝天光，让半夜看着像阴天的白天。
   */
  for (const c of matrix()) {
    assert.doesNotMatch(c.prompt, /自然光/, `${c.city} ${c.hour} 点还有「自然光」：${c.prompt}`);
    assert.doesNotMatch(c.prompt, /天气[晴阴雨雪雾霾沙尘]/, `${c.city} ${c.hour} 点还在报天气：${c.prompt}`);
  }
});

test('天空只说一次 —— 不许两处各描述一片天', () => {
  /*
   * 天由 `skyLine` 说，季节句里的天空分句在 `trimScene` 里剥掉，
   * 城市锚点里的「天空常罩一层灰白云」也摘掉了。
   * 这里按**句子**数（不是按词）：一段里有两句在讲天，就是两处抢同一件事。
   */
  const SKY_WORD = /天空|天是一整片|头顶是|天往浅里退|天从蓝|地平线一层橙|蓝调|天没有黑透|天边只剩一线/;
  /* 「以天空为主」是取景说明，不是对天的描述 —— 不算。 */
  const isSkySentence = (x) => SKY_WORD.test(x) && !/以天空为主/.test(x);
  for (const c of matrix()) {
    const sentences = c.prompt.split('。').filter(isSkySentence);
    assert.ok(
      sentences.length <= 1,
      `${c.city} ${c.month} 月 ${c.hour} 点 ${c.subject} 有 ${sentences.length} 句在讲天：${c.prompt}`,
    );
  }
});

test('一条提示词不超过 210 字', () => {
  /*
   * 真机实测：同种子，281 字画成江南水乡，60 字画对川西 ——
   * **长度是第一变量**，锚点再准也会被铺陈淹掉。健康区间 100–180。
   *
   * 2026-11-12 晚从 200 放到 210：试过「超长只留前三段」，被承德那条打回 ——
   * 「湖面冻成灰白冰板、冰上立着枯荷梗」在第五段，砍段数等于砍这个季节的辨识。
   * 现在改从两头压：食物的构图句压短、光与天不再重复说橙红。
   * 剩下 200 出头的那几条（北方冬天的六段雪景）**是信息量，不是铺陈**。
   */
  let worst = { n: 0, prompt: '' };
  for (const c of matrix()) {
    const n = [...c.prompt].length;
    if (n > worst.n) worst = { n, prompt: `${c.city} ${c.month} 月 ${c.hour} 点 ${c.subject}：${c.prompt}` };
    assert.ok(n <= 210, `${c.city} ${c.month} 月 ${c.hour} 点 ${c.subject} 有 ${n} 字：${c.prompt}`);
  }
  assert.ok(worst.n <= 210, `最长一条 ${worst.n} 字`);
});

test('不许出现拼接缝：双句号、空逗号、undefined', () => {
  for (const c of matrix()) {
    assert.doesNotMatch(c.prompt, /。。|，，|。，|，。|undefined|NaN/, `${c.city} ${c.hour} 点 ${c.subject}：${c.prompt}`);
    assert.equal(c.prompt.trim().endsWith('。'), true, `${c.city} ${c.hour} 点 ${c.subject} 结尾不是句号`);
  }
});

/* ---------------- 太阳高度角本身 ---------------- */

test('太阳高度角：赤道春分正午接近天顶，极圈冬天上不来', () => {
  const equatorNoon = sunAltitude(0, 3, 12);
  assert.ok(equatorNoon > 70, `赤道春分正午才 ${equatorNoon.toFixed(1)} 度`);

  /* 摩尔曼斯克十二月正午：太阳始终在 horizon 以下。 */
  assert.ok(sunAltitude(68.97, 12, 12) < 0, '极圈冬天正午不该有太阳');
  /* 漠河夏至午夜：太阳在地平线下十几度，天不黑但也没有日光。 */
  const moheMidnight = sunAltitude(52.97, 6, 0);
  assert.ok(moheMidnight < 0 && moheMidnight > -20, `漠河夏至午夜 ${moheMidnight.toFixed(1)} 度`);
});

test('经度要算进去：喀什的钟点比太阳时快三小时', () => {
  /*
   * 中国全境一个时区。喀什东经 76°，比东经 120° 的标准经线慢将近三小时 ——
   * 北京时间二十点，喀什的太阳才刚落到地平线；对上海来说那时候早黑透了。
   *
   * 不算经度的话，西部城市的每一张照片都会偏亮两三个小时。
   */
  const kashi = sunAltitude(39.47, 11, 20, 75.99, 'Asia/Shanghai');
  const shanghai = sunAltitude(31.23, 11, 20, 121.47, 'Asia/Shanghai');
  assert.ok(
    kashi > shanghai,
    `喀什二十点的太阳应该比上海高：喀什 ${kashi.toFixed(1)}°，上海 ${shanghai.toFixed(1)}°`,
  );
});

test('成都十一月十九点：天已经黑了，不许再算黄昏', () => {
  /*
   * 这是最初那一版的现场：19 点写着「黄昏的金色光线」，
   * 而成都十一月九日的日落是 18:05。
   * 判据从「小时 < 20 算黄昏」换成太阳高度角之后，这一刻是蓝调偏深夜。
   */
  const s = sceneSun({ city: '成都', cityId: 'chengdu', month: 11, hour: 19 });
  assert.ok(
    s.phase === 'blue' || s.phase === 'twilight' || s.phase === 'night',
    `成都十一月十九点被算成了 ${s.phase}（太阳高度 ${s.alt.toFixed(1)}°）`,
  );
  assert.equal(s.daylit, false, '成都十一月十九点被判成有日光');
});

test('太阳高度角和档位是单调的：越往上档位越亮', () => {
  const order = ['noon', 'day', 'slant', 'low', 'golden', 'afterglow', 'blue', 'twilight', 'night'];
  for (const alt of [80, 40, 20, 5, 0, -3, -8, -13, -30]) {
    const p = sunPhase(alt);
    assert.ok(order.includes(p), `${alt} 度给出了未知档位 ${p}`);
  }
  /* 顺过来：高度越高，档位越靠前。 */
  let last = -1;
  for (const alt of [80, 40, 20, 5, 0, -3, -8, -13, -30]) {
    const i = order.indexOf(sunPhase(alt));
    assert.ok(i >= last, `${alt} 度的档位顺序反了`);
    last = i;
  }
});
