/**
 * 同一天的计划表必须可重建、已发生的部分不许被改写（2026-11-07）
 *
 * ## 起因
 *
 * Mr.Q 的两张截图，同一时段、同一件事，内容却不一样：
 *
 * ```
 * 14:15  骑共享单车去锦里
 * 14:15  扫了辆电瓶车去锦里
 * ```
 *
 * 根因不是「推重了」，是 **plan 不可重建**：
 *
 * - `planDay` 的随机源是 `Math.random`（`inCityMode` 用它挑交通方式）；
 * - 单车 6 分钟/公里、电瓶车 4 分钟/公里 —— 挑中哪个，`beat.at` 也跟着变；
 * - plan 只活在内存里，Core 一重启就重建，**每次重建都重新掷骰子**；
 * - 于是同一件事既换了车，又因为 `at` 变了骗过 `lastBeatKey` 那道去重，推了第二遍。
 *
 * 更深一层：**已经发生过的事被改写了**。她 13:00 骑的是单车，14:00 重建后
 * 变成「14:15 扫电瓶车去的」—— 那不是重复通知，是篡改昨天。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { planDay } = await import('../src/plan/dayplan.ts');
const { CITIES, cityById } = await import('../src/geo/cities.ts');
const { rollLodging } = await import('../src/plan/lodging.ts');

/** 一个确定性的假随机源。同种子 → 同序列。 */
function lcg(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

const plan = (city, rnd, over = {}) => planDay({
  city, dateKey: '2026-11-07', shape: 'full',
  lodging: rollLodging(lcg(7)), rnd, ...over,
});

test('同一个随机源 → 同一张表（逐条一致，含通勤方式与时刻）', () => {
  const c = cityById('chengdu');
  const a = plan(c, lcg(42));
  const b = plan(c, lcg(42));
  assert.deepEqual(a.beats, b.beats, '同种子排出来的表不一样 —— planDay 还有别的不确定来源');
});

test('随机源不同 → 通勤方式可能不同（说明这个测试真能抓到东西）', () => {
  /*
   * 如果这条不成立，上面那条就是空过 —— 说明 `rnd` 根本没被用到。
   */
  const c = cityById('chengdu');
  const verbs = new Set();
  for (let s = 1; s <= 40; s++) {
    const p = plan(c, lcg(s));
    for (const b of p.beats) {
      if (b.kind === 'commute') verbs.add(b.what.slice(0, 6));
    }
  }
  assert.ok(verbs.size >= 2, `四十个种子只排出一种通勤方式，这条测试抓不到东西：${[...verbs]}`);
});

test('表里确实有「城内交通」这一类节点（不然上面两条测的是空气）', () => {
  const c = cityById('chengdu');
  const p = plan(c, lcg(42));
  const commute = p.beats.filter((b) => b.kind === 'commute');
  assert.ok(commute.length > 0, `成都一天里没有通勤节点，这条测试要换个城市：${p.beats.map((b) => b.kind)}`);
});

test('world 里调用 planDay 必须传种子随机 —— 否则每次重建都换车', () => {
  const src = readFileSync(new URL('../src/world.ts', import.meta.url), 'utf8');
  const at = src.indexOf('planDay({');
  assert.ok(at > 0, '找不到 planDay 的调用点');
  const seg = src.slice(at, at + 1600);
  assert.match(seg, /rnd:\s*seededRandom\(/, '调用 planDay 时没传种子随机，重建会重新掷骰子');
  assert.match(src, /const planSeed =/, '种子里没有日期/shape，同一天也会变');
});

test('world 重建计划时保留已推出的那一段', () => {
  /*
   * 种子随机让「同参数重建」幂等，但参数会变（钱紧、换酒店、shape）。
   * 那些变化只该影响还没发生的事 —— 已经说过的话不能被改写。
   */
  const src = readFileSync(new URL('../src/world.ts', import.meta.url), 'utf8');
  const at = src.indexOf('private async rebuildPlan');
  assert.ok(at > 0, '找不到 rebuildPlan');
  const end = src.indexOf('\n  private ', at + 10);
  const body = src.slice(at, end > 0 ? end : at + 6000);

  assert.match(body, /lastPushedAt\(/, '重建时没看「已经推到哪一刻」');
  assert.match(body, /prevPlan\.beats\.filter/, '没有保留旧表里已经推过的那些节拍');
  /*
   * 后半段一定来自「打补丁之后的新表」。
   *
   * 原来断言的是变量名 `fresh` —— 2026-11-09 加「改行程」时中间插了一道
   * `applyPlanPatches`，变量改名成 `patched`，这条就假红了。
   * 改按**形状**断言：谁接了 `> pushedAt` 那一半就是新表，变量叫什么都行。
   */
  assert.match(body, /\.beats\.filter\(\(b\) => b\.at > pushedAt\)/, '新表的后半段没接上');
});

test('lastPushedAt 的解析与 key 的生成对得上', () => {
  /*
   * 这一对我们抓过一次：`advanceBeats` 拼的是 `${dateKey}|${kind}|${at}`，
   * 如果哪天那边改了顺序，这里解析出来的就是垃圾 —— 而且不会报错，
   * 只会让「保留已推段」静默失效。
   */
  const src = readFileSync(new URL('../src/world.ts', import.meta.url), 'utf8');
  assert.match(src, /const key = `\$\{dateKey\}\|\$\{last\.kind\}\|\$\{last\.at\}`/,
    'lastBeatKey 的格式变了，lastPushedAt 要跟着改');
  const at = src.indexOf('private lastPushedAt');
  const body = src.slice(at, at + 700);
  assert.match(body, /split\('\|'\)/, 'lastPushedAt 没按 | 切');
  assert.match(body, /\[d, , at\]/, 'lastPushedAt 取错位了 —— 第二段是 kind，第三段才是 at');
});
