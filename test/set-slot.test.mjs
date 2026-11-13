/**
 * 改今天任意一格（2026-11-10，用户「清风乱域」的补丁）。
 *
 * ## 补丁原话
 *
 * 「我让我的 DSH 鱼改了一下。我自己用的是可以改作息改吃什么和景点。」
 *
 * `journey_plan_change` 只管景点。可「中午别吃面了」「别七点起了」这些话
 * 同样落不了地 —— 一个毛病：说出口的事在世界里没有对应的动作。
 *
 * ## 这条测试守六件事
 *
 * 1. **说类型词也认得** —— 用户说「午饭」，它不该逼模型去猜 12:30 还是 12:00；
 * 2. **钟点不精确也认** —— 表上排 18:30，用户说「19:00 吃晚饭」不该撞墙；
 * 3. **不说回头话** —— 已经过去的格子不动；
 * 4. **找不着要给替代** —— 只报错不给剩余时刻，她只能干瞪眼；
 *    **表上真没有、而那个时刻还没到，就新增一格**（2026-11-13）——
 *    日程从 07:00 起排，凌晨那几小时原本无格可改；
 * 5. **住处那格不许自由文本** —— 晚上能干什么由这家店真有的设施定，
 *    另有一条 `journey_hotel_night` 管着，从这儿改会说出这家店没有的东西；
 * 6. **老状态文件照读** —— 没有 `kind` 的补丁仍然只改活动格，行为一个字不变。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');

/** 成都当地 11:00 —— 早饭过去了，午饭还没到。 */
const NOON = new Date('2026-11-09T03:00:00Z');
/** 成都当地 23:30 —— 今天该吃的都吃完了。 */
const LATE = new Date('2026-11-09T15:30:00Z');

function world(t = NOON) {
  return new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: mkdtempSync(join(tmpdir(), 'jr-setslot-')),
    botName: '大肥鱼',
    now: () => t,
  });
}

/** 安排成「已经在成都待着」，并排好今天的表。 */
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

/** 小数小时 → `21:30`。跟工具回执同一个格式 —— 回执给什么，就得能读回什么。 */
const clock = (h) => {
  const whole = Math.floor(h);
  return `${String(whole).padStart(2, '0')}:${String(Math.round((h - whole) * 60)).padStart(2, '0')}`;
};

const beats = (w) => w.plan?.beats ?? [];
const ofKind = (w, k) => beats(w).filter((b) => b.kind === k);

test('说「午饭」就改午饭 —— 不用让模型猜 12:30 还是 12:00', async () => {
  const w = await settled();
  const lunch = ofKind(w, 'lunch')[0];
  assert.ok(lunch, '构造有问题：今天没有午饭格');

  const r = w.setSlot('午饭', '午饭，老火锅，鸳鸯锅');
  assert.equal(r.isError, undefined, `改失败：${r.text}`);
  assert.equal(ofKind(w, 'lunch')[0].what, '午饭，老火锅，鸳鸯锅');
});

test('钟点不精确也认：19:00 对得上 18:30 / 19:30 那顿晚饭', async () => {
  const w = await settled();
  const dinner = ofKind(w, 'dinner')[0];
  assert.ok(dinner, '构造有问题：今天没有晚饭格');

  const r = w.setSlot('19:00', '晚饭，火锅');
  assert.equal(r.isError, undefined, `就近匹配没兜住：${r.text}`);
  assert.equal(ofKind(w, 'dinner')[0].what, '晚饭，火锅');
});

test('不说回头话：23:30 的时候改午饭，拒', async () => {
  const w = await settled(LATE);
  const r = w.setSlot('午饭', '午饭，火锅');
  assert.equal(r.isError, true, '都半夜了还能改今天的午饭');
  assert.match(r.text, /过去/, r.text);
});

test('找不着格子要给替代：列出今天剩下的', async () => {
  const w = await settled();
  const r = w.setSlot('3:00', '凌晨三点起来看星星');
  assert.equal(r.isError, true, '凌晨 3 点居然有格子可改');
  assert.match(r.text, /今天剩下的/, `没给替代：${r.text}`);
});

/*
 * 新增一格（2026-11-13，mrlin97 在 Discussion #586 报的）。
 *
 * 原话：「`journey_set_slot` 只能改**已经存在的**格子」——他当地 01:06 想安排
 * 凌晨那一段，表上最早一格是 07:00 起床，`time="1:30"` 只能回「附近没有可改的格子」。
 * 日程表本身没排凌晨，这条路从一开始就是死的。
 *
 * 守两件事：① 未来且表上空的时刻能落成新的一格；
 * ② **重算之后还在** —— 贴一次就丢，等于「改了骗你」。
 */
test('表上空的时段能新增一格，重排之后还在', async () => {
  const w = await settled();
  assert.equal(ofKind(w, 'beat').length, 0, '构造有问题：今天本来就有 beat 格');

  // 成都当地 11:00；11:30 与最近的两格（09:30 / 12:30）都差一小时以上。
  const r = w.setSlot('11:30', '在城墙根下坐一会儿');
  assert.equal(r.isError, undefined, `新增失败：${r.text}`);

  const added = ofKind(w, 'beat').filter((b) => b.at === 11.5);
  assert.equal(added.length, 1, `新增的格没进日程：${JSON.stringify(ofKind(w, 'beat'))}`);
  assert.match(added[0].what, /城墙根下/, added[0].what);

  await w.rebuildPlan(NOON, 'full', 0);
  assert.equal(ofKind(w, 'beat').filter((b) => b.at === 11.5).length, 1, '重排之后新增的格丢了');
});

test('住处那格不许从这儿改 —— 晚上能干什么由这家店真有的设施定', async () => {
  const w = await settled();
  const hotel = ofKind(w, 'hotel')[0];
  assert.ok(hotel, '构造有问题：今天没有住处格');

  const r = w.setSlot(clock(hotel.at), '在泳池游了二十分钟');
  assert.equal(r.isError, true, '住处的格子被自由文本改了');
  assert.match(r.text, /journey_hotel_night/, r.text);
});

test('景点那格也不许从这儿改 —— 不然「坐公交去X」和「在家躺着」会同时挂在那儿', async () => {
  const w = await settled();
  const act = ofKind(w, 'activity').find((b) => b.at > 11);
  assert.ok(act, '构造有问题：11 点后没有活动格');

  const r = w.setSlot(clock(act.at), '下午，在家躺着');
  assert.equal(r.isError, true, '景点格被自由文本改了');
  assert.match(r.text, /journey_plan_change/, r.text);
  /* 关键：通勤那格还在说去哪儿 —— 两行对不上，所以这条路从一开始就不该通。 */
  assert.equal(ofKind(w, 'activity').find((b) => b.at === act.at).what, act.what, '原内容被动了');
});

test('改完重算还在 —— 不然她等于骗人', async () => {
  const w = await settled();
  await w.setSlot('午饭', '午饭，老火锅，鸳鸯锅');
  assert.equal(ofKind(w, 'lunch')[0].what, '午饭，老火锅，鸳鸯锅', '第一次就没改上');

  /* 刷新面板、钱紧、换酒店都会走这条重算。 */
  await w.rebuildPlan(NOON, 'full', 0);
  assert.equal(ofKind(w, 'lunch')[0].what, '午饭，老火锅，鸳鸯锅', '重算之后改动没了');
});

test('老状态文件照读：没有 kind 的补丁仍然只改活动格', async () => {
  const w = await settled();
  const act = ofKind(w, 'activity').find((b) => b.at > 11);
  assert.ok(act, '构造有问题：11 点后没有活动格');

  /* 1.0.9 之前写进去的补丁就是这个形状 —— 没有 kind 字段。 */
  w.st = {
    ...w.st,
    planPatches: [{
      dateKey: w.plan.dateKey,
      cityId: 'chengdu',
      at: act.at,
      what: '下午，在家躺着',
      spot: '',
    }],
  };
  w.plan = w.applyPlanPatches(w.plan, 'chengdu', w.plan.dateKey);

  assert.equal(ofKind(w, 'activity').find((b) => b.at === act.at)?.what, '下午，在家躺着', '老补丁没生效');
  /* 关键：不能顺带改到同一时刻的别的格 —— 这就是 kind 缺省当 activity 的原因。 */
  const sameAt = beats(w).filter((b) => b.at === act.at && b.kind !== 'activity');
  for (const b of sameAt) assert.ok(!b.what.includes('在家躺着'), `${b.kind} 那格被误伤了`);
});

test('在路上：没有日程可改', async () => {
  const w = world();
  w.st = { ...w.st, phase: 'traveling' };
  const r = w.setSlot('午饭', '午饭，火锅');
  assert.equal(r.isError, true);
  assert.match(r.text, /不在城里/, r.text);
});

/*
 * 2026-11-10 长跑抓到的：`commute` 的 at 是「活动时刻 - 路上分钟/60」，
 * 「走着去」这类 `ride.min` 可以是 0 —— 于是它和活动格**同一时刻**。
 * 按钟点找格从数组头开始找，先撞上通勤格，把「走着去武侯祠」改成了用户那句话，
 * 景点那格一动没动，两行还自相矛盾。
 */
test('通勤格和活动格撞在同一时刻时，不许拿通勤格开刀', async () => {
  const w = await settled();
  const act = ofKind(w, 'activity').find((b) => b.at > 11);
  assert.ok(act, '构造有问题：11 点后没有活动格');

  // 把活动格插在通勤格前面 —— 复刻「同 at」那个现场
  const fakeCommute = { at: act.at, kind: 'commute', what: '走着去某处' };
  w.plan = {
    ...w.plan,
    beats: [fakeCommute, ...beats(w)].sort((a, b) => a.at - b.at),
  };

  const r = w.setSlot(clock(act.at), '下午，在家躺着');
  assert.equal(r.isError, true, '同一时刻撞了两格却照改不误');
  assert.match(r.text, /journey_plan_change/, r.text);
  const after = beats(w).find((b) => b.kind === 'commute' && b.at === act.at);
  assert.equal(after?.what, '走着去某处', '通勤格被改成了用户那句话');
});

test('补丁只留今天 —— 昨天的补丁不会再被读到，留着只是撑大存档', async () => {
  const w = await settled();
  const today = w.plan.dateKey;

  w.st = {
    ...w.st,
    planPatches: [
      { dateKey: '2026-11-01', cityId: 'chengdu', at: 12.5, what: '昨天，火锅', spot: '', kind: 'lunch' },
      { dateKey: '2026-11-05', cityId: 'chengdu', at: 7.5, what: '前天，包子', spot: '', kind: 'breakfast' },
    ],
  };

  await w.setSlot('午饭', '午饭，老火锅');
  const left = w.st.planPatches.map((x) => x.dateKey);
  assert.ok(left.every((d) => d === today), `旧日期的补丁没清掉：${left.join(',')}`);
  assert.equal(left.length, 1, `今天的补丁应该只有一条，实际 ${left.length} 条`);
});
