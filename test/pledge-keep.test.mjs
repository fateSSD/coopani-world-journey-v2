/**
 * 2026-11-16 读者来信（Donahue / zzy1053）查出来的四条
 *
 * 真实案例：她答应和小岸一起去苏州，用户只是说「买机票吧，别再坐大半天火车」，
 * 模型调 `journey_go_to { 苏州, 飞机 }` —— **目的地一模一样**。结果：
 *   ① 她和小岸的约定被无条件清掉；
 *   ② 推了一条「他叫她改去别处」的事件，跟真实对话对不上，模型花一整轮判断它是不是噪音；
 *   ③ 苏州没有民航机场，飞机那一程本该被拒，却生成了 1576 公里 5.5 小时的航段。
 *
 * 这里盯的就是这三条，外加「到站约定作废必须说出来」和「事件正文不带人称」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');
const { cityById } = await import('../src/geo/cities.ts');

function fakeHost(events) {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => { events.push(e); return { ...e, blobs: [] }; },
    pushDeferred() {}, store: {}, drainPendingEvents: async () => [],
  };
}

async function boot(trip, nowISO, cfg = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-keep-'));
  new StateStore(dir).save({ ...initialState('lanzhou'), ...trip });
  const events = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', ...cfg },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(nowISO),
  });
  await world.start(fakeHost(events));
  const restore = () => { globalThis.fetch = origFetch; world.stop?.(); };
  return { world, events, restore };
}

const NOW = '2026-11-16T03:51:00Z';
const staying = (hereId, extra = {}) => ({
  phase: 'staying',
  hereId,
  tripStartedAt: '2026-11-10T00:00:00Z',
  stayStartedAt: '2026-11-15T00:00:00Z',
  stayDateKey: '2026-11-16',
  ...extra,
});
const pledgeTo = (cityId, extra = {}) => ({
  cityId, days: 2, withPet: '小岸', inviteId: 'inv-16', acceptedAt: NOW, arrivedAt: null, ...extra,
});
const goTo = (w) => w.tools().find((t) => t.name === 'journey_go_to').handler;

/* ---------------- Bug 2：目的地没变，约定不该被推掉 ---------------- */

test('同一座城、只换了走法：记下走法，人不动身，约定也不动', async () => {
  /*
   * 这是来信那个真实案例的正解（2026-11-16 第二版）。
   *
   * 第一版只做到「约定不清掉、但人照样出发」—— 用户的诉求是**改签**，
   * 不是「立刻出发」。她 10:31 刚答应小岸、11:51 用户改口说买机票，
   * 中间那一小时她在成都排好了下午的日程；一调工具就登机，等于把他的改签听成了「马上走」。
   */
  const { world, events, restore } = await boot(staying('chengdu', { pledge: pledgeTo('suzhou') }), NOW);
  try {
    const out = await goTo(world)({ city: '苏州', mode: '高铁' });
    assert.ok(!out.isError, `没走成：${out.text}`);
    assert.equal(world.st.phase, 'staying', '只是改走法，人却动了身');
    assert.equal(world.st.leg, null, '没动身却有腿');
    assert.ok(world.st.pledge, '目的地一样，约定却被清掉了 —— 这就是来信里那条最严重的');
    assert.equal(world.st.pledge.withPet, '小岸');
    assert.equal(world.st.pledge.modeId, 'train', '点名的走法没记进约定，动身时还是掷骰子');
    assert.equal(events.filter((e) => e.type === 'journey.pledge').length, 0, '没作废，不该推约定事件');
    assert.match(out.text, /还没动身/, '回执没写明人还在原地 —— 模型会顺口说她已经在路上');

    /*
     * 记下的走法要**真的被用上**。
     * 只在约定里存一格而出发时不读，等于记了个没人看的便条 ——
     * 用户看到的是「说了坐飞机，她还是坐了大半天火车」。
     */
    await world.depart(new Date(NOW), true);
    assert.equal(world.st.phase, 'traveling', '该走了却没走');
    assert.equal(world.st.leg?.modeId, 'train', '约定里点的高铁没被用上，她还是掷骰子挑的');
    assert.equal(world.st.leg?.toId, 'suzhou', '目的地不是约定的那座城');
  } finally { restore(); }
});

test('在路上、目的地没变：改签换走法，旧票全额退', async () => {
  /*
   * 票在出发时买了（`buyTicket`），改签 = 退旧票 + 买新票。
   * 退多少：全额，不扣手续费（Mr.Q 2026-11-16：「全退吧，这个不必模仿现实」）。
   *
   * 用成都 → 北京：苏州没有民航机场，改签成飞机本来就该被拒，
   * 拿它当改签用例会测不到想测的东西（那条拒绝对应 `苏州没有机场` 那条用例）。
   */
  const { world, events, restore } = await boot({
    ...staying('chengdu', {}),
    phase: 'traveling',
    spent: 3000,
    leg: {
      id: 'leg-2', fromId: 'chengdu', toId: 'beijing', modeId: 'train', km: 1520,
      durationWorldHours: 11, departedAt: '2026-11-16T03:00:00Z', arriveAt: '2026-11-16T14:00:00Z',
      speed: 1, seat: '二等座', seatMult: 1, viaIds: [], createdAt: '2026-11-16T03:00:00Z',
      fare: 1200,
    },
  }, NOW, { moneyEnabled: true, budget: 10000 });
  try {
    const out = await goTo(world)({ city: '北京', mode: '飞机' });
    assert.ok(!out.isError, `改签没成功：${out.text}`);
    assert.equal(world.st.leg?.modeId, 'plane', '走法没换');
    assert.equal(world.st.leg?.toId, 'beijing', '改签把目的地改了');
    assert.ok(world.st.leg?.fare > 0, '新票没有凭据 —— 下一趟改签就没得退了');
    const refunded = 3000 - world.st.spent + (world.st.leg.fare ?? 0);
    assert.ok(Math.abs(refunded - 1200) < 2, `旧票价 1200，实际退了 ${refunded} —— 不是全额退`);
    assert.equal(events.filter((e) => e.type === 'journey.rebook').length, 1, '改签没推事件，用户看不到');
  } finally { restore(); }
});

test('约定带见面城：去见面城会合也不算改去别处', async () => {
  /* 答应「先在成都碰头，再一起去苏州」。他去成都催她会合，约定照样作废的话，
     她人明明正走在约定的路上，约定却被推了 —— 比同城那条更隐蔽。 */
  const { world, events, restore } = await boot(
    staying('xian', { pledge: pledgeTo('suzhou', { meetCityId: 'chengdu' }) }), NOW,
  );
  try {
    const out = await goTo(world)({ city: '成都' });
    assert.ok(!out.isError, `没走成：${out.text}`);
    assert.ok(world.st.pledge, '去会合点也被当成「改去别处」了');
    assert.doesNotMatch(
      events.filter((e) => e.type === 'journey.pledge').map((e) => e.text).join(),
      /推了/, '去见面城不该说「只能推了」',
    );
  } finally { restore(); }
});

test('真的换了座城：约定照旧作废，并且说清为什么', async () => {
  const { world, events, restore } = await boot(staying('chengdu', { pledge: pledgeTo('suzhou') }), NOW);
  try {
    const out = await goTo(world)({ city: '西安' });
    assert.ok(!out.isError, `没走成：${out.text}`);
    assert.equal(world.st.pledge, null, '改去别处了，约定该作废');
    const pledge = events.filter((e) => e.type === 'journey.pledge');
    assert.equal(pledge.length, 1);
    assert.match(String(pledge[0].text), /小岸/, '没说是跟谁的约定');
    assert.match(String(pledge[0].text), /苏州/, '没说原本要去哪');
  } finally { restore(); }
});

/* ---------------- Bug 4：苏州没有民航机场 ---------------- */

test('苏州没有机场：点名坐飞机要被拒，而不是生成一段假航段', async () => {
  assert.equal(cityById('suzhou').air, false, '苏州的 air 又变回默认的「有机场」了');
  /* 常熟是同一片区的对照 —— 它早就写了 air: false，别哪天被改掉。 */
  assert.equal(cityById('changshu').air, false);

  const { world, restore } = await boot(staying('chengdu'), NOW);
  try {
    const out = await goTo(world)({ city: '苏州', mode: '飞机' });
    assert.ok(out.isError, '飞机去苏州居然走成了');
    assert.match(out.text, /机场/, '拒绝的理由里没提机场');
    assert.notEqual(world.st.phase, 'traveling', '被拒了却还是出发了');
  } finally { restore(); }
});

/* ---------------- Bug 5 + 人称：文案层面 ---------------- */

test('到站时约定作废，要推事件，不能只写日志', () => {
  const src = readFileSync(new URL('../src/world.ts', import.meta.url), 'utf8');
  assert.match(src, /if \(stray\) \{[\s\S]{0,600}?this\.push\(/, 'stray 分支又回到只 log 不推事件了');
});

test('事件正文不带第三人称自称 —— photo 那条是来信点名的', () => {
  const photo = readFileSync(new URL('../src/world-photo.ts', import.meta.url), 'utf8');
  assert.match(photo, /`拍了张照片：\$\{title\}。`/, 'journey.photo 又写回「她拍了张照片」了');
  assert.doesNotMatch(photo, /`她拍了张照片/, 'photo 事件正文里出现「她」，模型会当成第三方');

  const env = readFileSync(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8');
  assert.match(env, /\| `journey\.photo` \| 拍了张照片/, 'ENV_PROMPT 的事件表没同步');
});

/* ---------------- 票钱：出发即付，老存档到站补记 ---------------- */

test('老存档：腿上没有 fare 的那一代，到站要按算式补记一次，不能白坐', async () => {
  /*
   * `Journey.fare` 是 1.8.12 才有的。升级前就上路的那条腿没有它 ——
   * 而结算已经改成「出发时付过了」，到站什么都不做的话，
   * 那一趟的票钱**永远不会被扣**，预算约束从此偏掉（实测就是这么漏的）。
   *
   * 判据必须是 `undefined` 而不是 `0`：走路、骑车的票钱真是 0，
   * 用 0 判会把每一次免费走一程都当成老存档，补扣一笔不该有的钱。
   */
  const { world, restore } = await boot({
    ...staying('chengdu', {}),
    phase: 'traveling',
    spent: 500,
    leg: {
      id: 'leg-old', fromId: 'chengdu', toId: 'beijing', modeId: 'train', km: 1520,
      durationWorldHours: 11, departedAt: '2026-11-16T00:00:00Z', arriveAt: '2026-11-16T03:40:00Z',
      speed: 1, seat: '二等座', seatMult: 1, viaIds: [], createdAt: '2026-11-16T00:00:00Z',
    },
  }, NOW, { moneyEnabled: true, budget: 10000 });
  try {
    await world.tick();
    assert.equal(world.st.phase, 'staying', `没到站（phase=${world.st.phase}）—— 这条用例的前提没成立`);
    assert.ok(world.st.spent > 500, `老存档那一趟白坐了：spent 还是 ${world.st.spent}`);
  } finally { restore(); }
});

test('新车票：出发时就付，到站不再扣第二遍', async () => {
  const { world, restore } = await boot({
    ...staying('chengdu', {}),
    phase: 'traveling',
    spent: 500,
    leg: {
      id: 'leg-new', fromId: 'chengdu', toId: 'beijing', modeId: 'train', km: 1520,
      durationWorldHours: 11, departedAt: '2026-11-16T00:00:00Z', arriveAt: '2026-11-16T03:40:00Z',
      speed: 1, seat: '二等座', seatMult: 1, viaIds: [], createdAt: '2026-11-16T00:00:00Z',
      fare: 900,
    },
  }, NOW, { moneyEnabled: true, budget: 10000 });
  try {
    await world.tick();
    assert.equal(world.st.phase, 'staying', '没到站');
    assert.ok(world.st.spent >= 500 && world.st.spent < 700, `到站又扣了一遍票钱：spent ${world.st.spent}`);
  } finally { restore(); }
});

test('老存档改签：旧票没付过，就不许退——退了等于凭空给钱', async () => {
  /*
   * 这一条是自查抓到的（2026-11-16）。第一版 `refundFare` 写成
   * `leg.fare ?? 按算式重算一遍`，于是升级前就在路上的那条腿（从没付过票钱）
   * 一改签就退出一笔**从来没有过的钱**——账面上她白赚一张票。
   * 判据只能是「这一格有没有值」，不是「票钱算出来是多少」。
   */
  const { world, restore } = await boot({
    ...staying('chengdu', {}),
    phase: 'traveling',
    spent: 3000,
    leg: {
      id: 'leg-old2', fromId: 'chengdu', toId: 'beijing', modeId: 'train', km: 1520,
      durationWorldHours: 11, departedAt: '2026-11-16T03:00:00Z', arriveAt: '2026-11-16T14:00:00Z',
      speed: 1, seat: '二等座', seatMult: 1, viaIds: [], createdAt: '2026-11-16T03:00:00Z',
    },
  }, NOW, { moneyEnabled: true, budget: 10000 });
  try {
    const out = await goTo(world)({ city: '北京', mode: '飞机' });
    assert.ok(!out.isError, `改签没成功：${out.text}`);
    const paid = world.st.leg?.fare ?? 0;
    assert.ok(paid > 0, '新票没凭据');
    assert.equal(world.st.spent, 3000 + paid, `账不对：${world.st.spent}（该是 3000 + 新票 ${paid}，不该有退款）`);
  } finally { restore(); }
});

test('在打短工：人走不了，但「他说要坐飞机」这句话得记下', async () => {
  /*
   * 这条是长跑抓到的（2026-11-16，goto 档「只记走法 0/14 次」）。
   *
   * 原来「只记走法」排在「正在打短工」之后，于是打工期间的每一次改走法
   * 都被一句「她在打工，还有 N 天」挡回来 —— 用户那句话连同回执一起消失，
   * 工做完她按自己挑的方式走。而**记走法不让她走**，和打工根本不冲突。
   */
  const { world, restore } = await boot(staying('chengdu', {
    pledge: pledgeTo('suzhou'),
    work: {
      cityId: 'chengdu', startedOn: '2026-11-14', until: '2026-11-20T00:00:00Z',
      pay: 120, gig: '帮厨',
    },
  }), NOW, { moneyEnabled: true, budget: 10000 });
  try {
    const out = await goTo(world)({ city: '苏州', mode: '高铁' });
    assert.ok(!out.isError, `打工期间改走法被挡了：${out.text}`);
    assert.equal(world.st.phase, 'staying', '打工期间人却动了身');
    assert.ok(world.st.work, '打个工还被打没了');
    assert.equal(world.st.pledge?.modeId, 'train', '走法没记下来 —— 工做完她还是会坐火车');
  } finally { restore(); }
});

test('记下的走法，他再点名同一座城（不说方式）时仍然算数', async () => {
  /*
   * 自查抓到的一个漏口（2026-11-16）：`depart` 里那个 `pledged` 变量在
   * 「他点了名」时是 null（`opts.to ? null : activePledge(...)`）。
   * 于是「先说坐飞机 → 第二天再点一次同一座城但没提方式」时，
   * 记下的走法丢了，她又掷骰子挑了一个。
   */
  const { world, restore } = await boot(staying('chengdu', {
    /*
     * 用成都 → 北京：苏州没有民航机场，拿它测「按飞机走」会被正当拒掉，
     * 测不到这里想测的东西。约定里记的是飞机，他这次只说「去北京」、不提方式。
     */
    pledge: pledgeTo('beijing', { modeId: 'plane' }),
  }), NOW, { moneyEnabled: true, budget: 10000 });
  try {
    const out = await goTo(world)({ city: '北京' });
    assert.ok(!out.isError, `没走成：${out.text}`);
    assert.equal(world.st.phase, 'traveling', '没说方式时该照常出发');
    assert.equal(world.st.leg?.modeId, 'plane', `约定里记的是飞机，实际坐了 ${world.st.leg?.modeId}`);
  } finally { restore(); }
});
