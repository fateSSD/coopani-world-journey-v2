/**
 * 「特意去吃」这件事，必须真的发生（2026-11-13，Discussion #586）。
 *
 * ## 用户原话
 *
 * 「重庆小面、毛血旺、酸辣粉，最标志性的火锅和串串啥的没有；
 *  我喊鱼自己去吃了 3 天她也没去，连续吃了两天串串。」
 *
 * 前半句是数据（`FEATURES.food` 的招牌菜不在菜表里，见 `meal-food.test.mjs`），
 * 后半句是**动作缺位**：她答应了「去吃火锅」，世界里没有这个动作，
 * 日程一个字没动 —— 跟 `journey_rest` 当初完全是同一个病。
 *
 * ## 这条测试守四件事
 *
 * 1. **答应了就落地** —— 日程那一格真的改成要吃的东西，不是只在回执里说好；
 * 2. **店名是查来的** —— 查到了就写进去，且是接口里给的那家；
 * 3. **查不到不许编** —— 日程照写，但回执必须说清「别报店名」；
 * 4. **不在城里、没日程的时候要拦住**，不能凭空改出一格。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');

/** 重庆当地 11:00 —— 早饭过去了，午饭还没到。 */
const NOON = new Date('2026-11-09T03:00:00Z');

/** 把全局 fetch 换成假的；返回还原函数。 */
function stubFetch(handler) {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => { calls++; return handler(String(url)); };
  return { restore: () => { globalThis.fetch = real; }, calls: () => calls };
}

const okPois = (pois) => ({ ok: true, status: 200, json: async () => ({ status: '1', pois }) });

async function settled(t = NOON) {
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', amapKey: 'test-key' },
    dataDir: mkdtempSync(join(tmpdir(), 'jr-eat-')),
    botName: '大肥鱼',
    now: () => t,
  });
  w.st = {
    ...w.st,
    phase: 'staying',
    hereId: 'chongqing',
    currentCityId: 'chongqing',
    arrivedAt: '2026-11-08T02:00:00Z',
    days: 3,
    tripStartedAt: '2026-11-01T02:00:00Z',
  };
  await w.rebuildPlan(t, 'full', 0);
  return w;
}

const eatTool = (w) => w.tools().find((t) => t.name === 'journey_eat');
const lunchOf = (w) => (w.plan?.beats ?? []).find((b) => b.kind === 'lunch');

test('他喊去吃火锅，午饭那一格真的变成火锅，还带着查到的店名', async () => {
  const w = await settled();
  const before = lunchOf(w);
  assert.ok(before, '构造有问题：今天没有午饭格');

  const f = stubFetch(() => okPois([
    { name: '丁眼镜火锅总店', address: '渝中区民生路', type: '餐饮服务;中餐厅;火锅店', biz_ext: { rating: '4.6' } },
    { name: '大彬火锅', address: '渝中区较场口', type: '餐饮服务;中餐厅;火锅店', biz_ext: { rating: '4.4' } },
  ]));
  try {
    const r = await eatTool(w).handler({ dish: '火锅', time: '午饭' });
    assert.equal(r.isError, undefined, `调用失败：${r.text}`);
    // 1. 日程真的改了
    assert.match(lunchOf(w).what, /火锅/, `日程没改：${lunchOf(w).what}`);
    // 2. 店名是接口给的那家，不是编的
    assert.match(lunchOf(w).what, /丁眼镜火锅总店/, `店名没落进日程：${lunchOf(w).what}`);
    assert.match(r.text, /丁眼镜火锅总店/, '回执里没有店名，她说不出来');
    assert.match(r.text, /4\.6/, '评分没给');
    assert.match(r.text, /大彬火锅/, '附近还有哪家没说');
  } finally { f.restore(); }
});

test('查不到就退回泛称，并且明确说「别报店名」', async () => {
  const w = await settled();
  const f = stubFetch(() => okPois([]));
  try {
    const r = await eatTool(w).handler({ dish: '螺蛳粉', time: '午饭' });
    assert.equal(r.isError, undefined, `调用失败：${r.text}`);
    assert.match(lunchOf(w).what, /螺蛳粉/, '查不到也该把这一顿写下来');
    assert.doesNotMatch(lunchOf(w).what, /「/, '查不到却写了店名');
    assert.match(r.text, /别报店名|本地人排队/, `没提醒她别编店名：${r.text}`);
  } finally { f.restore(); }
});

test('断网也一样 —— 不吃不上饭，只是没有店名', async () => {
  const w = await settled();
  const f = stubFetch(() => { throw new Error('offline'); });
  try {
    const r = await eatTool(w).handler({ dish: '小面', time: '午饭' });
    assert.equal(r.isError, undefined, `断网不该把整件事拒掉：${r.text}`);
    assert.match(lunchOf(w).what, /小面/);
  } finally { f.restore(); }
});

test('不在城里待着就拦住 —— 路上不能凭空改出一顿饭', async () => {
  const w = await settled();
  w.st = { ...w.st, phase: 'onway' };
  const r = await eatTool(w).handler({ dish: '火锅' });
  assert.equal(r.isError, true, '在路上也让她去吃了');
  assert.match(r.text, /不在城里|停留/);
});

test('不给菜名就问回去，别自己挑一样', async () => {
  const w = await settled();
  const r = await eatTool(w).handler({});
  assert.equal(r.isError, true);
  assert.match(r.text, /吃什么|菜名/);
});

test('不说餐次就按当地时刻推断 —— 中午调就是午饭', async () => {
  const w = await settled(NOON);
  const f = stubFetch(() => okPois([{ name: '板凳面庄', address: '', type: '餐饮服务', biz_ext: {} }]));
  try {
    await eatTool(w).handler({ dish: '小面' });
    assert.match(lunchOf(w).what, /小面/, `没落到午饭那一格：${JSON.stringify((w.plan?.beats ?? []).map((b) => [b.kind, b.what]))}`);
  } finally { f.restore(); }
});
