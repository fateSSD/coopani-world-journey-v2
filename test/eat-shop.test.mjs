/**
 * 「特意去吃」时查到的店名是真的，或者干脆没有 —— 不许编。
 *
 * 2026-11-13，Discussion #586（DonahueMa）：
 * 「重庆美食池只有小面、毛血旺、酸辣粉，最标志性的火锅和串串啥的没有；
 *  我喊鱼自己去吃了 3 天她也没去，连续吃了两天串串。」
 *
 * 查下来是两件事：池子窄（数据），和她说出口的「去吃」没有对应的动作（提示词）。
 * 后者靠 `journey_eat` 补，前者靠两处：`FEATURES.food` 的招牌菜先入池，
 * 以及这个模块 —— 真店名只从高德来，查不到就是查不到。
 *
 * 这个文件只测后者：**过滤、缓存、失败路径**。真实接口留在手工验证里
 * （2026-11-13 实测「重庆 火锅」→ status 1 / count 600 / 真店名，见 `eatery.ts` 注释）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { EateryDirectory } = await import('../src/geo/eatery.ts');
const { cityById } = await import('../src/geo/cities.ts');
const assert = (await import('node:assert/strict')).default;
const { test } = await import('node:test');

/** 每个用例一个临时目录 —— 缓存文件互相别串。 */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'eat-'));
  return { file: join(dir, 'eatery-cache.json'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 把全局 fetch 换成假的，返回还原函数。**无论断言成败都要还原**，否则污染同进程的别的测试。 */
function stubFetch(handler) {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => { calls++; return handler(String(url)); };
  return { restore: () => { globalThis.fetch = real; }, calls: () => calls };
}

const ok = (pois) => ({
  ok: true,
  status: 200,
  json: async () => ({ status: '1', count: pois.length, pois }),
});

const COLD_POT = [
  { name: '丁眼镜火锅总店', address: '渝中区民生路', type: '餐饮服务;中餐厅;火锅店', biz_ext: { rating: '4.6' } },
  { name: '大彬火锅', address: '渝中区较场口', type: '餐饮服务;中餐厅;火锅店', biz_ext: { rating: '4.4' } },
  { name: '春红火锅(洪崖洞店)', address: '渝中区沧白路', type: '餐饮服务;中餐厅;火锅店', biz_ext: {} },
  { name: '陈胖子火锅(总店)', address: '', type: '餐饮服务;中餐厅;火锅店', biz_ext: {} },
];

test('查到的是真店名，最多三家 —— 报一长串像在念搜索结果', async () => {
  const s = scratch();
  const f = stubFetch(() => ok(COLD_POT));
  try {
    const d = new EateryDirectory('k', s.file);
    const list = await d.find(cityById('chongqing'), '火锅');
    assert.ok(list, '该查到');
    assert.equal(list.length, 3, '超过三家没截断');
    assert.equal(list[0].name, '丁眼镜火锅总店');
    assert.equal(list[0].rating, '4.6');
    assert.ok(list.every((x) => x.type.includes('火锅店')), '分类没带上来');
  } finally { f.restore(); s.done(); }
});

test('关门的店、卖底料的店不算能吃饭的地方', async () => {
  const s = scratch();
  const f = stubFetch(() => ok([
    { name: '老灶火锅(暂停营业)', address: '', type: '餐饮服务;中餐厅;火锅店', biz_ext: {} },
    { name: '桥头火锅底料批发', address: '', type: '购物服务;超级市场', biz_ext: {} },
    { name: '朝天门火锅', address: '', type: '餐饮服务;中餐厅;火锅店', biz_ext: {} },
  ]));
  try {
    const d = new EateryDirectory('k', s.file);
    const list = await d.find(cityById('chongqing'), '火锅');
    assert.ok(list, '剩一家也该返回');
    assert.deepEqual(list.map((x) => x.name), ['朝天门火锅']);
  } finally { f.restore(); s.done(); }
});

test('七天内再问同一家城同一样东西，不再发请求', async () => {
  const s = scratch();
  const f = stubFetch(() => ok(COLD_POT));
  try {
    const d = new EateryDirectory('k', s.file);
    await d.find(cityById('chongqing'), '火锅');
    assert.equal(f.calls(), 1);
    await d.find(cityById('chongqing'), '火锅');
    assert.equal(f.calls(), 1, '第二次不该再问一遍接口');
    await d.find(cityById('chongqing'), '小面');
    assert.equal(f.calls(), 2, '换一样东西该重新查');
  } finally { f.restore(); s.done(); }
});

test('查不到也记住七天 —— 别让「敦煌想吃螺蛳粉」每次撞一次接口', async () => {
  const s = scratch();
  const f = stubFetch(() => ok([]));
  try {
    const d = new EateryDirectory('k', s.file);
    assert.equal(await d.find(cityById('dunhuang'), '螺蛳粉'), null);
    assert.equal(await d.find(cityById('dunhuang'), '螺蛳粉'), null);
    assert.equal(f.calls(), 1, '失败没被记住');
  } finally { f.restore(); s.done(); }
});

test('没 key、国外、接口失败 —— 一律 null，上层退泛称', async () => {
  const s = scratch();
  const f = stubFetch(() => { throw new Error('no net'); });
  try {
    assert.equal(await new EateryDirectory('', s.file).find(cityById('chongqing'), '火锅'), null, '没 key 还发了请求');
    assert.equal(await new EateryDirectory('k', s.file).find(cityById('tokyo'), '拉面'), null, '国外高德查不到，不该发请求');
    assert.equal(await new EateryDirectory('k', s.file).find(cityById('chongqing'), '火锅'), null, '断网该返回 null');
    assert.equal(await new EateryDirectory('k', s.file).find(cityById('chongqing'), '  '), null, '空菜名该直接返回');
  } finally { f.restore(); s.done(); }
});

test('key 无效只提醒一次，之后不再打接口', async () => {
  const s = scratch();
  let warns = 0;
  const f = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ status: '0', info: 'INVALID_USER_KEY' }) }));
  try {
    const d = new EateryDirectory('bad', s.file, (lv) => { if (lv === 'warn') warns++; });
    assert.equal(await d.find(cityById('chongqing'), '火锅'), null);
    assert.equal(await d.find(cityById('chongqing'), '小面'), null);
    assert.equal(f.calls(), 1, 'key 错了还在反复请求');
    assert.equal(warns, 1, '提醒次数不对');
  } finally { f.restore(); s.done(); }
});

test('缓存落盘、重启还在 —— 不然一天重开几次就查几次', async () => {
  const s = scratch();
  const f = stubFetch(() => ok(COLD_POT));
  try {
    await new EateryDirectory('k', s.file).find(cityById('chongqing'), '火锅');
    assert.equal(f.calls(), 1);
    // 新实例 = 模拟重启：只读缓存文件，不该再上网
    const again = await new EateryDirectory('k', s.file).find(cityById('chongqing'), '火锅');
    assert.ok(again && again.length === 3, '重启后缓存没读回来');
    assert.equal(f.calls(), 1, '重启后又查了一遍');
  } finally { f.restore(); s.done(); }
});
