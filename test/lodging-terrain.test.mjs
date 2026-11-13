/**
 * 景观房要看地理 —— 2026-11-07 子 agent 审计
 *
 * 原来住宿的景观池是固定的四间（山景 / 海景 / 老城民宿 / 湖景客栈），随机抽。
 * 于是**柏林能开出「山景房：窗对着雪线以上的岩壁」** —— 而柏林方圆一百公里
 * 最高的东西是电视塔。
 *
 * 这不是审美问题：她住进去，还会跟用户描述那扇窗。用户去过柏林，一眼就知道没有那座山。
 *
 * 这里守三件事：
 *   1. `terrainOf()` 的判定要对（柏林三样都没有，三亚只有海）；
 *   2. 没有地形就掷不出那种房；
 *   3. 一间隔间都没有的时候不能崩（池子空了 `pick` 会取到 undefined）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { cityById, terrainOf, CITIES } = await import('../src/geo/cities.ts');
const { rollLodging, rerollLodging } = await import('../src/plan/lodging.ts');

const t = (id) => terrainOf(cityById(id));

test('地形判定：柏林什么都没有，三亚只有海，桂林有山', () => {
  assert.deepEqual(t('berlin'), { sea: false, mountain: false, lake: false });
  assert.equal(t('sanya').sea, true);
  assert.equal(t('sanya').mountain, false);
  assert.equal(t('guilin').mountain, true);
  assert.equal(t('guilin').sea, false);
  assert.equal(t('hangzhou').lake, true);
});

test('内河码头不算海：重庆、曼谷没有海景房', () => {
  /*
   * 反例是 `port: true`。这套数据里它是「有码头、能坐船」，
   * 长江和湄南河都算 —— 早先按它判海，重庆和曼谷都开出了海景房。
   */
  for (const id of ['chongqing', 'bangkok', 'guilin']) {
    assert.equal(t(id).sea, false, `${id} 被当成了海边`);
  }
});

test('柏林掷不出海景/山景/湖景', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const l = rollLodging(Math.random, false, 1.4, true, true, t('berlin'));
    if (l.tier === 'view') seen.add(l.kind);
  }
  assert.ok(seen.size > 0, '柏林连景观房都没有了？池子不该空');
  assert.doesNotMatch([...seen].join(''), /海景|山景|湖景/, `柏林开出了不存在的景观：${[...seen]}`);
});

test('三亚能掷出海景房，但不会掷出山景房', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const l = rollLodging(Math.random, false, 1.1, true, false, t('sanya'));
    if (l.tier === 'view') seen.add(l.kind);
  }
  assert.match([...seen].join(''), /海景/, `三亚没有海景房了：${[...seen]}`);
  assert.doesNotMatch([...seen].join(''), /山景|湖景/, `三亚开出了山/湖景房：${[...seen]}`);
});

test('换房也守同一条：柏林不会因为「换好点」换出山景房', () => {
  for (let i = 0; i < 200; i++) {
    const cur = rollLodging(Math.random, true, 1.4, false, true, t('berlin'));
    const next = rerollLodging(cur, Math.random, false, 1.4, 'nicer', true, true, t('berlin'));
    assert.doesNotMatch(next.kind, /海景|山景|湖景/, `换房换出了不存在的景观：${next.kind}`);
  }
});

test('不传地形时行为不变 —— 老调用方一个参数都不用改', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const l = rollLodging(Math.random, false, 1.4, true, true);
    if (l.tier === 'view') seen.add(l.kind);
  }
  assert.ok(seen.size >= 3, `不传地形时景观池被改变了：${[...seen]}`);
});

test('每座城的景观房都和环境对得上 —— 全量扫一遍', () => {
  const problems = [];
  for (const c of CITIES) {
    const terrain = terrainOf(c);
    for (let i = 0; i < 40; i++) {
      const l = rollLodging(Math.random, false, c.priceIdx, true, c.country !== 'CN', terrain);
      if (/海景/.test(l.kind) && !terrain.sea) problems.push(`${c.name} 没海却有海景房`);
      if (/山景/.test(l.kind) && !terrain.mountain) problems.push(`${c.name} 没山却有山景房`);
      if (/湖景/.test(l.kind) && !terrain.lake) problems.push(`${c.name} 没湖却有湖景房`);
    }
  }
  assert.deepEqual([...new Set(problems)], [], `景观房和地理对不上：\n${[...new Set(problems)].join('\n')}`);
});
