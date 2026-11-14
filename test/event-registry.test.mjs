/**
 * 事件表与源码必须一一对应 —— 2026-11-14
 *
 * `JOURNEY_DESCRIBE.events` 上面写着「`events` 必须与源码里 push 的类型一一对应」，
 * 但 `journey.part` 从 2026-11-12 就在推、一直没登记。
 *
 * 漏登记的后果不在运行，在**排查**：面板里看不到它，市场卡片上也没有它，
 * 出问题时不会想起还有这一种事件。
 *
 * 这条测试是拿 144 天 money 长跑挂掉的时间抓出来的 —— 那次挂的是「重复推」，
 * 顺手一查才发现它还漏登记。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const { JOURNEY_DESCRIBE } = await import('../src/world.ts');

const SRC = new URL('../src/', import.meta.url);

/** 源码里真正会推出去的事件类型（扫 `push('journey.x'` 这一种写法）。 */
function pushedTypes() {
  const out = new Set();
  for (const f of readdirSync(SRC).filter((n) => n.endsWith('.ts'))) {
    const text = readFileSync(new URL(f, SRC), 'utf8');
    // push( 的第一个参数，允许中间换行；只认它字面写死的字符串
    for (const m of text.matchAll(/\.push\(\s*[\r\n]*\s*'(journey\.[a-z.]+)'/g)) out.add(m[1]);
  }
  return out;
}

test('每个推出去的事件都在 describe 表里登记过', () => {
  const declared = new Set(JOURNEY_DESCRIBE.events.map((e) => e.type));
  const missing = [...pushedTypes()].filter((t) => !declared.has(t));
  assert.deepEqual(missing, [], `这些事件在推、但没登记：${missing.join('、')}`);
});

test('describe 表里登记的事件，源码里真的在推', () => {
  /* 反向也查一遍：登记了却没人推的，是改代码时漏删的残留，会误导排查。 */
  const pushed = pushedTypes();
  const stale = JOURNEY_DESCRIBE.events.map((e) => e.type).filter((t) => !pushed.has(t));
  assert.deepEqual(stale, [], `这些事件登记了但源码里没在推：${stale.join('、')}`);
});

test('散伙事件在表里，且带一句人话说明', () => {
  const part = JOURNEY_DESCRIBE.events.find((e) => e.type === 'journey.part');
  assert.ok(part, 'journey.part 又漏登记了');
  assert.ok(part.description.zh.includes('散伙') || part.description.zh.includes('各走各的'),
    `描述没说清这是什么：${part.description.zh}`);
});
