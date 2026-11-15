/**
 * 「他说去哪、怎么去」—— `journey_go_to`（2026-11-05）
 *
 * 起因是一封用户来信（鱼酥）：
 *
 *   「我喊桌宠坐高铁从常熟去上海，桌宠刚答应但是插件转头安排它蹬自行车 80 公里去上海」
 *   「能不能加一个让桌宠可以自己选择交通工具的功能，不是强制分配」
 *
 * 两句话是同一件事：**整条路上没有「交通方式」这个输入**。目的地能记（draw_to）、
 * 回家能叫（return_home），唯独「用什么去」永远由 `pickMode` 掷骰子。
 *
 * 这里守三件事：说了方式就照办、走不了就说清、绝不静默替换。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');
const { cityById } = await import('../src/geo/cities.ts');
const { pickMode } = await import('../src/plan/journey.ts');
const { distanceKm } = await import('../src/geo/distance.ts');

function fakeHost(events) {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => { events.push(e); return { ...e, blobs: [] }; },
    pushDeferred() {}, store: {}, drainPendingEvents: async () => [],
  };
}

async function boot(trip, nowISO) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-goto-'));
  new StateStore(dir).save({ ...initialState('lanzhou'), ...trip });
  const events = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(nowISO),
  });
  await world.start(fakeHost(events));
  const restore = () => { globalThis.fetch = origFetch; world.stop?.(); };
  return { world, events, restore };
}

const staying = (hereId, extra = {}) => ({
  phase: 'staying',
  hereId,
  tripStartedAt: '2026-11-01T00:00:00Z',
  stayStartedAt: '2026-11-02T00:00:00Z',
  stayDateKey: '2026-11-04',
  ...extra,
});
const NOW = '2026-11-05T02:00:00Z';
const goTo = (w) => w.tools().find((t) => t.name === 'journey_go_to').handler;

/* ---------------- 说了就照办 ---------------- */

test('说了坐高铁就坐高铁 —— 不再被骰子改成自行车', async () => {
  /*
   * 反馈原样：常熟 → 上海约 90 公里，`short` 这一档里自行车原来固定权重 5（比火车 3 还高），
   * 于是「坐高铁」最可能被实现成「蹬自行车」。现在两处都改了：
   * 权重跟着距离走，并且**用户点名的方式优先级最高**。
   */
  const { world, events, restore } = await boot(staying('changshu'), NOW);
  try {
    const out = await goTo(world)({ city: '上海', mode: '高铁' });
    assert.ok(!out.isError, `没走成：${out.text}`);
    assert.equal(world.st.phase, 'traveling');
    assert.equal(world.st.leg?.toId, 'shanghai');
    assert.equal(world.st.leg?.modeId, 'train', `要的是高铁，安排成了 ${world.st.leg?.modeId}`);
    const depart = events.filter((e) => e.type === 'journey.depart');
    assert.equal(depart.length, 1);
    assert.match(String(depart[0].text), /常熟/, '出发那句没出发地');
  } finally { restore(); }
});

test('几种常见说法都认得：飞机 / 自驾 / 大巴 / 船', async () => {
  const cases = [
    ['飞机', 'plane', 'lasa'],
    ['自驾', 'car', 'xian'],
    ['大巴', 'bus', 'xian'],
  ];
  for (const [word, want, dest] of cases) {
    const { world, restore } = await boot(staying('lanzhou'), NOW);
    try {
      const out = await goTo(world)({ city: cityById(dest).name, mode: word });
      assert.ok(!out.isError, `「${word}」没走成：${out.text}`);
      assert.equal(world.st.leg?.modeId, want, `「${word}」被安排成了 ${world.st.leg?.modeId}`);
    } finally { restore(); }
  }
});

test('不说方式就她自己挑 —— 照旧能走，不报错', async () => {
  const { world, restore } = await boot(staying('lanzhou'), NOW);
  try {
    const out = await goTo(world)({ city: '西安' });
    assert.ok(!out.isError, `没走成：${out.text}`);
    assert.equal(world.st.phase, 'traveling');
    assert.ok(world.st.leg?.modeId, '没选交通方式');
  } finally { restore(); }
});

/* ---------------- 走不了就说清，不许偷换 ---------------- */

test('点名的方式走不了：说清为什么，并列出能用的，不偷偷换成别的', async () => {
  /*
   * 京都：没有民航机场。从上海「飞」过去是不成立的 ——
   * 但**不能**因为她说了飞就改成火车（上海到京都也没有陆路）。
   */
  const { world, restore } = await boot(staying('shanghai'), NOW);
  try {
    const out = await goTo(world)({ city: '京都', mode: '飞机' });
    assert.equal(out.isError, true, `上海飞京都居然走成了：${out.text}`);
    assert.match(String(out.text), /机场|没有/, `没说清是机场的事：${out.text}`);
    assert.equal(world.st.phase, 'staying', '被拒了却动了身');
  } finally { restore(); }
});

test('认不出的说法：别猜，把能用的摆出来', async () => {
  const { world, restore } = await boot(staying('lanzhou'), NOW);
  try {
    const out = await goTo(world)({ city: '西安', mode: '坐火箭' });
    assert.equal(out.isError, true);
    assert.match(String(out.text), /火车|飞机|自驾/, `没列可用方式：${out.text}`);
  } finally { restore(); }
});

/* ---------------- 四条不该走的边界 ---------------- */

test('去「家」那座城：交给 journey_return_home，不走这条', async () => {
  /*
   * 到家意味着一趟结束：结账、进休息期、推 `journey.home`。
   * `moveOn` 不知道这些 —— 真送回去，她会在「家」继续当旅行中。
   */
  const { world, restore } = await boot(staying('xian'), NOW);
  try {
    const out = await goTo(world)({ city: '兰州' });
    assert.equal(out.isError, true);
    assert.match(String(out.text), /return_home|回家/, `没指向回家那条路：${out.text}`);
    assert.equal(world.st.phase, 'staying');
  } finally { restore(); }
});

test('在路上 / 在家休息不许出发；手上有约定时，他开口了约定让位', async () => {
  // 在路上
  {
    const { world, restore } = await boot({
      phase: 'traveling',
      hereId: 'xian',
      tripStartedAt: '2026-11-01T00:00:00Z',
      leg: {
        id: 'x', fromId: 'xian', toId: 'chengdu', modeId: 'train', km: 700,
        durationWorldHours: 6, departedAt: '2026-11-05T01:30:00Z',
        arriveAt: '2026-11-05T07:30:00Z', speed: 1, viaIds: [], createdAt: '2026-11-05T01:30:00Z',
      },
    }, NOW);
    try {
      const out = await goTo(world)({ city: '上海' });
      /*
       * 契约 2026-11-15 变了：在路上**不新建一段**，但也不再一句硬拒绝把他
       * 的话丢掉 —— 来信原话是「刚跟她说要不要去西安，她就被拉到去西双版纳
       * 的车上」，硬拒绝让她对他的目的地完全失明。现在记进 `wishes`，
       * 到站排下一站时权重更高。
       *
       * 所以这里守的是两件事：**没出发**，以及**话被记下了**。
       */
      assert.equal(world.st.phase, 'traveling', '在路上还能再出发');
      assert.equal(world.st.leg?.toId, 'chengdu', '原来那一段被改掉了');
      assert.ok(
        world.st.wishes.includes('shanghai'),
        `「上海」没记进想去：${JSON.stringify(world.st.wishes)}`,
      );
      assert.match(String(out.text), /下一站|记下/, `没说清记下了：${out.text}`);
    } finally { restore(); }
  }

  // 在家休息期
  {
    const { world, restore } = await boot({
      phase: 'home', hereId: 'lanzhou', restingUntil: '2026-11-08T00:00:00Z',
    }, NOW);
    try {
      const out = await goTo(world)({ city: '上海' });
      assert.equal(out.isError, true, '休息期还能被叫出门');
      assert.match(String(out.text), /歇|休息|11-08/, `没说清在休息：${out.text}`);
    } finally { restore(); }
  }

  // 手上有约定
  {
    const { world, events, restore } = await boot(staying('xian', {
      pledge: {
        cityId: 'chengdu', days: 3, withPet: '小满', inviteId: 'abcdef0123456789',
        acceptedAt: '2026-11-04T00:00:00Z', arrivedAt: null,
      },
    }), NOW);
    try {
      /*
       * 2026-11-06 改的规矩：**他点名，约定让位**。
       *
       * 原来这里断言「答应了别人还能改道」= 拒绝。可长跑抓到一边倒的后果：
       * goto 档连点 148 次名、成功 1 次 —— 一份她根本走不到的约定把她钉在原地一百多次。
       * `beginReturn` 早就是「他的话比陌生人的邀约重要」，这里跟它对齐。
       *
       * 让位不等于悄悄丢掉：要推一条事件说清，面板才不会再挂着那句话。
       */
      const out = await goTo(world)({ city: '上海' });
      assert.ok(!out.isError, `他点名被约定挡住了：${out.text}`);
      assert.equal(world.st.pledge, null, '约定没让位，面板上会一直挂着那句做不到的话');
      assert.ok(events.some((e) => e.type === 'journey.pledge'), '没推事件说明约定被推了');
    } finally { restore(); }
  }
});

test('没给城市就交回去问，别自己挑一个', async () => {
  const { world, restore } = await boot(staying('lanzhou'), NOW);
  try {
    const out = await goTo(world)({});
    assert.equal(out.isError, true);
    assert.equal(world.st.phase, 'staying');
  } finally { restore(); }
});

test('从家出发也能指定（在家、不在休息期）', async () => {
  const { world, events, restore } = await boot({
    phase: 'home', hereId: 'lanzhou', restingUntil: null,
  }, NOW);
  try {
    const out = await goTo(world)({ city: '西安', mode: '高铁' });
    assert.ok(!out.isError, `在家出发没走成：${out.text}`);
    assert.equal(world.st.phase, 'traveling');
    assert.equal(world.st.leg?.modeId, 'train');
    // 从家出门要记下这一趟的起点
    assert.equal(world.st.tripHomeId, 'lanzhou', '没记这一趟从哪个家出发');
    assert.ok(world.st.tripStartedAt, '没记这一趟开始的时间');
    assert.equal(events.filter((e) => e.type === 'journey.depart').length, 1);
  } finally { restore(); }
});

/* ---------------- 权重本身也得修 ---------------- */

test('90 公里的路，自行车不该是首选（反馈的根因）', () => {
  /*
   * 常熟 → 上海约 90 公里。原来 `short` 档里自行车固定 5、火车 3，
   * 抽 400 次里自行车占三成 —— 那就是「说好坐高铁却蹬自行车」。
   * 现在自行车权重随距离掉下去。
   */
  const a = cityById('changshu');
  const b = cityById('shanghai');
  const km = Math.round(distanceKm(a, b));
  assert.ok(km > 60 && km < 200, `这段距离变了：${km} 公里`);

  const counts = {};
  let seed = 0.13;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280 / 233280; return seed; };
  for (let i = 0; i < 800; i++) {
    const m = pickMode(a, b, km, rnd, false, false, undefined);
    counts[m.id] = (counts[m.id] ?? 0) + 1;
  }
  const bike = (counts.bike ?? 0) / 800;
  assert.ok(bike < 0.05, `${km} 公里还常骑自行车：${(bike * 100).toFixed(1)}%（${JSON.stringify(counts)}）`);
  // 火车/汽车/大巴里总得有一个是主流
  const main = Math.max(counts.train ?? 0, counts.car ?? 0, counts.bus ?? 0) / 800;
  assert.ok(main > 0.3, `没有一种像话的方式占主流：${JSON.stringify(counts)}`);
});

test('几公里的路，自行车还该是日常选择（别把权重改反了）', () => {
  const a = cityById('changshu');
  const b = cityById('changshu');
  const counts = {};
  let seed = 0.31;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280 / 233280; return seed; };
  for (let i = 0; i < 400; i++) {
    const m = pickMode(a, b, 6, rnd, false, false, undefined);
    counts[m.id] = (counts[m.id] ?? 0) + 1;
  }
  const shortHaul = (counts.walk ?? 0) + (counts.bike ?? 0) + (counts.scooter ?? 0);
  assert.ok(shortHaul / 400 > 0.5, `六公里的路反而不走路不骑车了：${JSON.stringify(counts)}`);
});

/* ---------------- 另外两种「这会儿不能开新的一趟」（2026-11-05 第二轮） ---------------- */

test('正在往回走：不许改道 —— 走了也白走，第二天还是要回头', async () => {
  /*
   * `returning` 是在「已经决定回家」之后设的。这会儿 `journey_go_to` 把她送去别处，
   * 会同时踩坏三处：
   *   ① `affordMode` 在回程时只留大巴和步行 —— 明明有钱却说「买不起机票」；
   *   ② 到了那儿第二天一早，`stayTick` 的回程分支（排在一切之前）又会让她接着往家走；
   *   ③ `noFly` 在回程时是「允许飞」，于是一段本该省钱的归途变成了绕路。
   * 所以拒掉，并告诉她「先到家」。
   */
  const { world, events, restore } = await boot(staying('xian', {
    returning: true,
    returnReason: 'called',
  }), NOW);
  try {
    const out = await goTo(world)({ city: '成都' });
    assert.equal(out.isError, true, `回程路上还能改道：${out.text}`);
    assert.match(String(out.text), /往回走|回家|到家/, `没说清在回程：${out.text}`);
    assert.equal(world.st.phase, 'staying', '被拒了却动了身');
    assert.equal(events.filter((e) => e.type === 'journey.depart').length, 0, '还是发出了「出发了」');
  } finally { restore(); }
});

test('正在打短工：不许走 —— 工钱按天结，半路走了这几天白干', async () => {
  /*
   * `stayTick` 里「打工期间」那一支排在「走不走」之前，到点才收工。
   * 这时候让她出发：`work` 留在状态里，到了下一座城每天照旧记员工餐、
   * 照旧领那笔工钱（钱是凭空发的），而她在别处，六天里还走不掉。
   */
  const until = '2026-11-09T02:00:00Z';
  const { world, events, restore } = await boot(staying('changshu', {
    work: { cityId: 'changshu', startedOn: '2026-11-03', until, pay: 120, gig: '仓库理货' },
  }), NOW);
  try {
    const out = await goTo(world)({ city: '上海' });
    assert.equal(out.isError, true, `打工期间还能走：${out.text}`);
    assert.match(String(out.text), /工|活/, `没说清在打工：${out.text}`);
    assert.equal(world.st.phase, 'staying');
    assert.ok(world.st.work, '工被悄悄取消了');
    assert.equal(events.filter((e) => e.type === 'journey.depart').length, 0);
  } finally { restore(); }
});

test('表里写的全名也能认：「大峡谷国家公园」= 大峡谷', async () => {
  /*
   * 同步表里那两行原来写的是「优胜美地国家公园」「大峡谷国家公园」，
   * 代码里叫「优胜美地」「大峡谷」。表已经改成代码的名字了，但**他嘴里还会说全名** ——
   * 认不出来就是「没有这个地方」，而那座城明明在表上。
   */
  const { world, restore } = await boot(staying('lasvegas'), NOW);
  try {
    const out = await goTo(world)({ city: '大峡谷国家公园' });
    assert.ok(!out.isError, `全名认不出来：${out.text}`);
    assert.equal(world.st.leg?.toId, 'grandcanyon');
  } finally { restore(); }
});

test('出门到上限了：不开新的一趟 —— 去了也只是一夜，第二天早上照样回头', async () => {
  /*
   * `stayTick` 里 `overWeeks` 排在最前面（连约定都压过去）。这会儿送她出门，
   * 花一天坐车到新城市，第二天早上八点又往回走 —— 白折腾一天，还把「上限」这件事
   * 演成「她忽然想回家」。
   */
  const { world, events, restore } = await boot(staying('xian', {
    tripStartedAt: '2026-05-01T00:00:00Z',   // 半年，远超默认 26 周
  }), NOW);
  try {
    const out = await goTo(world)({ city: '成都' });
    assert.equal(out.isError, true, `到上限还能开新的一趟：${out.text}`);
    assert.match(String(out.text), /上限|周/, `没说清是上限：${out.text}`);
    assert.equal(world.st.phase, 'staying');
    assert.equal(events.filter((e) => e.type === 'journey.depart').length, 0);
  } finally { restore(); }
});
