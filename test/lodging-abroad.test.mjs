/**
 * 住宿的「词」也要认地方（2026-11-07，欧洲 37 城之后加）
 *
 * ## 为什么会有这个文件
 *
 * 城市的照片修好之后，紧接着冒出来的是同一类问题：
 * `rollLodging` 的四张池子全是**中国的住处** —— 快捷连锁、老式招待所、
 * 县城宾馆、湖景客栈、改造的老宅。这些词在中国都对，但她在柏林
 * 住进「县城宾馆」就是笑话，而这不是小概率：每座城每天掷一次。
 *
 * 修法不是改文案，是**分成两套池子**，由调用方按 `country` 选。
 *
 * ## 守什么
 *
 * 1. 国外那套里不许出现中国的住处词，国内那套里不许出现国外的；
 * 2. 价格量级要和当地实价对得上（柏林五百到三千，不是五十）；
 * 3. 「换便宜点」也得守同一套 —— 不然换着换着又换出「县城宾馆」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rollLodging, rerollLodging } = await import('../src/plan/lodging.ts');

/** 固定种子，跑起来可复现 —— 随机会让失败不可查。 */
function seeded(seed = 7) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

const CN_ONLY = /快捷连锁|老式招待所|县城宾馆|家庭旅店|老城民宿|湖景客栈|改造的老宅|通铺/;
const ABROAD_ONLY = /青年旅舍|连锁经济酒店|老牌大酒店|设计酒店|地下室改的房间/;

test('国外不出现中国的住处词，国内不出现国外的', () => {
  const rnd = seeded();
  const cn = new Set();
  const ab = new Set();
  for (let i = 0; i < 400; i++) {
    cn.add(rollLodging(rnd, false, 1.2, false, false).kind);
    ab.add(rollLodging(rnd, false, 2.0, false, true).kind);
  }
  const badAb = [...ab].filter((k) => CN_ONLY.test(k));
  const badCn = [...cn].filter((k) => ABROAD_ONLY.test(k));
  assert.deepEqual(badAb, [], `国外的池子里有中国的住处：${badAb.join('、')}`);
  assert.deepEqual(badCn, [], `国内被换成了国外的住处：${badCn.join('、')}`);
});

test('价格量级对得上当地实价：柏林不是五十块一晚', () => {
  const rnd = seeded(11);
  const prices = [];
  for (let i = 0; i < 200; i++) prices.push(rollLodging(rnd, false, 2.0, false, true).price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  assert.ok(lo >= 85, `柏林最低 ${lo} 元 —— 低于差店地板 85`);
  assert.ok(hi <= 3200, `柏林最高 ${hi} 元 —— 池子里最贵的是老牌大酒店，不该过三千二`);
});

test('换便宜点也守同一套词 —— 别换出「县城宾馆」', () => {
  const rnd = seeded(3);
  const start = rollLodging(rnd, false, 2.0, false, true);
  for (let i = 0; i < 12; i++) {
    const next = rerollLodging(start, rnd, false, 2.0, 'cheaper', false, true);
    assert.doesNotMatch(next.kind, CN_ONLY, `换房换出了中国的住处：${next.kind}`);
  }
});

test('不传最后那个参数，行为和以前一样（老调用方不用改）', () => {
  const a = seeded(5);
  const b = seeded(5);
  for (let i = 0; i < 30; i++) {
    const x = rollLodging(a);
    const y = rollLodging(b, false, 1, false, false);
    assert.equal(x.kind, y.kind, '默认参数下的结果变了 —— 老调用方会受影响');
    assert.equal(x.price, y.price);
  }
});
