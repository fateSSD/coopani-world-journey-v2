/**
 * 改今天还没去的行程（2026-11-09，user mail：清风乱域）。
 *
 * ## 来信原话
 *
 * 「我的鱼说想更改安排，发现更改不了。本来她想去故宫，但是被安排推着去了颐和园。
 * 所以想要有个更改安排行程的功能。」
 *
 * ## 这条测试守四件事
 *
 * 1. **改得动** —— 下一处换成城里的另一个点，连通勤那一格一起换（不然会留下
 *    「坐公交去宽窄巷子」+「下午，青城山」两行自相矛盾）；
 * 2. **编不出来** —— 城里没有的地方明确拒绝并列出可选的，不许糊一个名字；
 * 3. **不说回头话** —— 已经过去的格子不动；路上的时候没有城内行程可改；
 * 4. **改完不被冲掉** —— 日程会重算，重算之后改动还在。这条是本功能最容易翻车的地方：
 *    不记账的话她说「改好了」，用户刷新一下又看见颐和园，那比根本没有这个功能更坏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { cityById } = await import('../src/geo/cities.ts');

/** 成都当地 11:00 —— 上午那一处已经过去，下午那一处还没到。 */
const NOON = new Date('2026-11-09T03:00:00Z');

function world(t = NOON) {
  return new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: mkdtempSync(join(tmpdir(), 'jr-planchange-')),
    botName: '大肥鱼',
    now: () => t,
  });
}

/** 安排成「已经在成都待着」的样子，并排好今天的表。 */
async function settled(t = NOON) {
  const w = world(t);
  w.st = {
    ...w.st,
    phase: 'staying',
    hereId: 'chengdu',
    currentCityId: 'chengdu',
    arrivedAt: '2026-11-08T02:00:00Z',
    days: 3,
    tripStartedAt: '2026-11-01T02:00:00Z',
  };
  await w.rebuildPlan(t, 'full', 0);
  return w;
}

/** 今天的活动格（按时刻）。 */
const acts = (w) => (w.plan?.beats ?? []).filter((b) => b.kind === 'activity');

test('改得动：下一处换成城里的另一个点，通勤那格跟着换', async () => {
  const w = await settled();
  const before = acts(w).find((b) => b.at > 11);
  assert.ok(before, '构造有问题：11 点后没有活动格');

  /* 挑一个今天没排到的地方，免得撞上「本来就要去」。 */
  const used = new Set(acts(w).map((b) => b.spot));
  const other = cityById('chengdu').slots.find((s) => !used.has(s));
  assert.ok(other, '成都的 slots 全被排完了，换个日期测');

  const r = await w.changePlan(other, '');
  assert.equal(r.isError, undefined, `改失败：${r.text}`);

  const after = acts(w).find((b) => b.at === before.at);
  assert.equal(after?.spot, other, '活动那格没换');
  assert.ok(after.what.includes(other), `what 里没写新地名：${after.what}`);

  /* 通勤那格：「坐公交去旧地方」要变成「坐公交去新地方」 */
  const rides = (w.plan?.beats ?? []).filter((b) => b.kind === 'commute' && b.at <= before.at);
  if (rides.length) {
    const last = rides[rides.length - 1];
    assert.ok(!last.what.includes(before.spot), `通勤那格还写着旧地名：${last.what}`);
    assert.ok(last.what.includes(other), `通勤那格没换：${last.what}`);
  }
});

test('编不出来：城里没有的地方明确拒绝，并列出能去的', async () => {
  const w = await settled();
  const r = await w.changePlan('故宫', '');
  assert.equal(r.isError, true, '成都居然能改去故宫');
  assert.match(r.text, /没有「故宫」/, r.text);
  /* 拒绝时必须让下一句有话可说 —— 只报错不给替代，她只能干瞪眼。 */
  assert.match(r.text, /能去的是/, `没列出这座城有什么：${r.text}`);
  assert.ok(r.text.includes(cityById('chengdu').slots[0]), '列的名单不对');
});

test('简称也对得上：说「宽窄」能匹配到「宽窄巷子」', async () => {
  const w = await settled();
  /* 先确认宽窄巷子今天确实还没去，不然这条测不到匹配逻辑。 */
  const used = acts(w).filter((b) => b.at > 11).map((b) => b.spot);
  if (used.includes('宽窄巷子')) return;
  const r = await w.changePlan('宽窄', '');
  assert.equal(r.isError, undefined, `简称没匹配上：${r.text}`);
  assert.ok(acts(w).some((b) => b.spot === '宽窄巷子'), '没改成宽窄巷子');
});

test('不说回头话：11 点之后没剩下什么就不让改', async () => {
  /* 推到深夜 23:30（成都当地），今天的活动都过去了。 */
  const late = new Date('2026-11-09T15:30:00Z');
  const w = await settled(late);
  const r = await w.changePlan('青城山', '');
  assert.equal(r.isError, true, '都夜里了还能改今天的行程');
});

test('在路上：没有城内行程可改', async () => {
  const w = world();
  w.st = { ...w.st, phase: 'traveling' };
  const r = await w.changePlan('青城山', '');
  assert.equal(r.isError, true);
  assert.match(r.text, /在路上/, r.text);
});

test('改完重算还在 —— 不然她等于骗人', async () => {
  const w = await settled();
  const before = acts(w).find((b) => b.at > 11);
  const used = new Set(acts(w).map((b) => b.spot));
  const other = cityById('chengdu').slots.find((s) => !used.has(s));

  await w.changePlan(other, '');
  assert.ok(acts(w).some((b) => b.spot === other), '第一次就没改上');

  /* 重算一次（换酒店、钱紧、刷新面板都会走这条） */
  await w.rebuildPlan(NOON, 'full', 0);
  const after = acts(w).find((b) => b.at === before.at);
  assert.equal(after?.spot, other, '重算之后改动没了 —— 用户会收到第二次「改了没用」');

  /* 再算一次也一样：补丁要能反复贴，不是一次性消耗品。 */
  await w.rebuildPlan(NOON, 'full', 0);
  assert.equal(acts(w).find((b) => b.at === before.at)?.spot, other, '第二次重算又变回去了');
});
