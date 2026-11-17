/**
 * 邀约的**下半截**：接了就真的去（2026-11-05）
 *
 * 服务端那一半（发、查、接）2026-11-04 就写完了，缺的是客户端 ——
 * 而客户端的重点不是「多两个工具」，是**「答应了」这件事得落到行程上**。
 *
 * 一个邀约不是一条消息，是一个要持续好几天、跨好几个巡检、还可能跨一次重启的安排：
 * 接下之后要真的往那座城走、到了按天数待着、待满才走。这件事只要有一段没接上，
 * 表现就是「她答应了，第二天却去了别的地方」—— 用户会认为这个功能是假的。
 *
 * 所以这里盯的是**三处口径必须一致**：
 *   状态（`st.pledge`）→ 行程（`moveOn` 的目的地、`stayTick` 的走不走）→ 她读到的字（`journey_now`、事件正文）
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
const { buildJourney, canTravel } = await import('../src/plan/journey.ts');
const { MODES, modeById } = await import('../src/geo/modes.ts');
const { distanceKm } = await import('../src/geo/distance.ts');

/**
 * 邀约链路的假服务器。
 *
 * 2026-11-06 起 `journey_accept` 是**先拉列表、再发「接」**：三个校验
 * （是不是她家那座城 / 去不去得了 / 买不买得起）必须在服务端收下之前完成 ——
 * 原来先接后校验，校验失败时别人名单上已经多了一只不会出现的鱼。
 *
 * 所以假体要按路径分流：`/invite?` 给列表，`/accept` 给成交。
 */
function inviteServer(one) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/invite?')) {
      // 列表的字段就在响应顶层（`listInvites` 读的是 `raw.list`，raw 是整个响应体）。
      return { ok: true, status: 200, json: async () => ({ ok: true, list: [one] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, with: one.pet, to: one.to, days: one.days, note: one.note }),
    };
  };
}

/** 桩要像个真 Logger：宿主接口有五个方法，少一个会在 warn 那条路上抛。 */
function fakeHost(events) {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => {
      events.push(e);
      return { ...e, blobs: [] };
    },
    pushDeferred() {},
    store: {},
    drainPendingEvents: async () => [],
  };
}

/**
 * 起一台 World。
 *
 * `fetch` 一律打桩成「没网」：`rebuildPlan` 会去查天气（没 key 时走 Open-Meteo），
 * 真发请求会让这组测试随网速漂 —— 而这组测的东西跟天气一点关系都没有。
 */
async function boot(trip, nowISO, dir = null) {
  const dataDir = dir ?? mkdtempSync(join(tmpdir(), 'jr-pledge-'));
  if (!dir) new StateStore(dataDir).save({ ...initialState('lanzhou'), ...trip });
  const events = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir,
    botName: '大肥鱼',
    now: () => new Date(nowISO),
  });
  await world.start(fakeHost(events));
  const restore = () => { globalThis.fetch = origFetch; world.stop?.(); };
  return { world, events, dir: dataDir, restore, now: new Date(nowISO) };
}

const pledgeTo = (cityId, days, extra = {}) => ({
  cityId,
  days,
  withPet: '小满',
  inviteId: 'abcdef0123456789',
  acceptedAt: '2026-11-03T12:00:00Z',
  arrivedAt: null,
  ...extra,
});

/* ---------------- 去了没有 ---------------- */

test('接了就真去：下一站被钉在约定的那座城，出发那句话也说得出来', async () => {
  const now = new Date('2026-11-04T04:00:00Z');
  const { world, events, restore } = await boot({
    phase: 'staying',
    hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
    stayDateKey: '2026-11-04',
    pledge: pledgeTo('lasa', 3),
  }, now.toISOString());
  try {
    await world.moveOn(now, cityById('xian'));

    assert.equal(world.st.phase, 'traveling', '没动身');
    assert.equal(world.st.leg?.toId, 'lasa',
      `没去拉萨，去了 ${world.st.leg?.toId} —— 答应了却走到别处，比不答应难看`);

    const depart = events.filter((e) => e.type === 'journey.depart');
    assert.equal(depart.length, 1, `推了 ${depart.length} 条出发事件`);
    const text = String(depart[0].text);
    assert.match(text, /小满/, `出发那句没说清是跟谁说好的：${text}`);
    assert.match(text, /3 天/, `没说要待几天：${text}`);
    // 「在这儿待够了，动身」是随便走那套说法，赴约不能套用它
    assert.doesNotMatch(text, /待够了/, `把赴约写成了「待够了就走」：${text}`);
  } finally { restore(); }
});

test('回家路上不看约定 —— 他叫回来，比一个陌生人的邀约要紧', async () => {
  const now = new Date('2026-11-04T04:00:00Z');
  const { world, restore } = await boot({
    phase: 'staying',
    hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
    stayDateKey: '2026-11-04',
    returning: true,
    pledge: pledgeTo('lasa', 3),
  }, now.toISOString());
  try {
    await world.goHome(now, cityById('xian'), 'called');
    if (world.st.phase === 'traveling') {
      assert.notEqual(world.st.leg?.toId, 'lasa', '回程里拐去了拉萨');
    }
    assert.equal(world.st.pledge, null, '叫回家之后那份约定还挂着');
  } finally { restore(); }
});

/* ---------------- 待够了没有 ---------------- */

test('到了那座城：到站时刻落进约定，第二天早上不会提前走', async () => {
  const arriveAt = new Date('2026-11-04T06:00:00Z');
  const { world, events, restore } = await boot({
    phase: 'traveling',
    hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    leg: buildJourney({
      from: cityById('xian'), to: cityById('lasa'),
      mode: modeById('train'), km: Math.round(distanceKm(cityById('xian'), cityById('lasa'))),
      at: new Date('2026-11-03T20:00:00Z'), speed: 1,
    }),
    pledge: pledgeTo('lasa', 3),
  }, arriveAt.toISOString());
  try {
    await world.arrive(arriveAt, world.st.leg);

    assert.equal(world.st.phase, 'staying');
    assert.equal(world.st.hereId, 'lasa');
    assert.ok(world.st.pledge, '到站之后约定没了');
    assert.equal(world.st.pledge.arrivedAt, arriveAt.toISOString(),
      '「待几天」要从**到达**起算，不是从接下那一刻');

    const arrive = events.filter((e) => e.type === 'journey.arrive');
    assert.equal(arrive.length, 1);
    assert.match(String(arrive[0].text), /小满/, `到站那句没提是冲着谁来的：${arrive[0].text}`);
  } finally { restore(); }
});

test('到了别的地方：约定作废，不让它在「她现在怎么样」里挂一句做不到的话', async () => {
  const arriveAt = new Date('2026-11-04T06:00:00Z');
  const { world, restore } = await boot({
    phase: 'traveling',
    hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    leg: buildJourney({
      from: cityById('xian'), to: cityById('chengdu'),
      mode: modeById('train'), km: Math.round(distanceKm(cityById('xian'), cityById('chengdu'))),
      at: new Date('2026-11-03T20:00:00Z'), speed: 1,
    }),
    pledge: pledgeTo('lasa', 3),
  }, arriveAt.toISOString());
  try {
    await world.arrive(arriveAt, world.st.leg);
    assert.equal(world.st.pledge, null, '到了成都，去拉萨的约定还挂着');
  } finally { restore(); }
});

test('日期没满不走，满了就走 —— 这件事不该掷骰子', async () => {
  const now = new Date('2026-11-04T00:30:00Z');   // 拉萨当地 08:30，正是决策点
  /*
   * 两天前到的，约定三天 —— 还差一天。
   *
   * 这里最容易错的地方是：正常停留是「待够 2 天 + 掷一次 15% 的骰子」，
   * 而约定是**确定的**。把两种混在一起，三天会变成「大概三天」。
   */
  const early = await boot({
    phase: 'staying',
    hereId: 'lasa',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:30:00Z',
    stayDateKey: '2026-11-04',
    pledge: pledgeTo('lasa', 3, { arrivedAt: '2026-11-02T00:30:00Z' }),
  }, now.toISOString());
  try {
    await early.world.tick();
    assert.equal(early.world.st.phase, 'staying', '还有一天就走了');
    assert.ok(early.world.st.pledge, '没待满就把约定清了');
  } finally { early.restore(); }

  const late = await boot({
    phase: 'staying',
    hereId: 'lasa',
    tripStartedAt: '2026-10-28T00:00:00Z',
    stayStartedAt: '2026-10-31T00:00:00Z',
    stayDateKey: '2026-11-04',
    pledge: pledgeTo('lasa', 3, { arrivedAt: '2026-10-31T00:00:00Z' }),
  }, now.toISOString());
  try {
    await late.world.tick();
    assert.equal(late.world.st.phase, 'traveling', '三天待满了还没走');
    assert.equal(late.world.st.pledge, null, '走的时候约定该结掉');
    assert.notEqual(late.world.st.leg?.toId, 'lasa', '还在原地打转');
  } finally { late.restore(); }
});

/* ---------------- 赶不上 ---------------- */

test('三天还没挪到那座城：约定作废，而且说出来', async () => {
  const now = new Date('2026-11-04T04:00:00Z');
  const { world, events, restore } = await boot({
    phase: 'staying',
    hereId: 'xian',
    tripStartedAt: '2026-10-28T00:00:00Z',
    stayStartedAt: '2026-11-03T00:00:00Z',
    stayDateKey: '2026-11-04',
    // 四天前接的，一直没动身
    pledge: pledgeTo('lasa', 3, { acceptedAt: '2026-10-31T04:00:00Z' }),
  }, now.toISOString());
  try {
    await world.tick();
    assert.equal(world.st.pledge, null, '过期了还挂着');

    const notice = events.filter((e) => e.type === 'journey.invite');
    assert.equal(notice.length, 1, `推了 ${notice.length} 条邀约事件`);
    assert.match(String(notice[0].text), /没赶上|算了/, `没说清是没赶上：${notice[0].text}`);
    assert.match(String(notice[0].text), /拉萨/, '没说是哪一趟');
  } finally { restore(); }
});

/* ---------------- 她读到的字 ---------------- */

test('「她现在怎么样」里必须有这份约定 —— 否则第三天她就忘了', async () => {
  const now = new Date('2026-11-04T02:00:00Z');
  const { world, restore } = await boot({
    phase: 'staying',
    hereId: 'lasa',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
    stayDateKey: '2026-11-04',
    pledge: pledgeTo('lasa', 3, { arrivedAt: '2026-11-02T00:00:00Z' }),
  }, now.toISOString());
  try {
    const now1 = String(world.nowSummary());
    assert.match(now1, /小满/, `没提跟谁：${now1}`);
    assert.match(now1, /拉萨/, `没提去哪：${now1}`);
    assert.match(now1, /剩 \d 天/, `没提还剩几天：${now1}`);
  } finally { restore(); }
});

test('约定跨一次重启还在 —— 它是安排，不是一次对话', async () => {
  const nowISO = '2026-11-04T02:00:00Z';
  const first = await boot({
    phase: 'staying',
    hereId: 'lasa',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
    stayDateKey: '2026-11-04',
    pledge: pledgeTo('lasa', 3, { arrivedAt: '2026-11-02T00:00:00Z' }),
  }, nowISO);
  const dir = first.dir;
  first.world.stop?.();
  first.restore();

  const second = await boot({}, nowISO, dir);
  try {
    assert.ok(second.world.st.pledge, '重启之后约定没了 —— 而用户记得她答应过');
    assert.equal(second.world.st.pledge.cityId, 'lasa');
    assert.equal(second.world.st.pledge.days, 3);
    assert.equal(second.world.st.pledge.withPet, '小满');
    assert.equal(second.world.st.pledge.arrivedAt, '2026-11-02T00:00:00Z');
  } finally { second.restore(); }
});

test('状态文件里那份约定写坏了：当没有，不让她朝一座不存在的城走', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-pledge-bad-'));
  new StateStore(dir).save({
    ...initialState('lanzhou'),
    phase: 'staying',
    hereId: 'xian',
    pledge: { cityId: 'atlantis', days: 'x', withPet: 1, acceptedAt: 'nope' },
  });
  const loaded = new StateStore(dir).load('lanzhou');
  assert.equal(loaded.state.pledge, null, '认不出的城市名被收下了');
});

/* ---------------- 工具层 ---------------- */

test('两个工具都注册了，而且不带 id 是「看」不是「接」', async () => {
  const { world, restore } = await boot({
    phase: 'staying',
    hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
    stayDateKey: '2026-11-04',
  }, '2026-11-04T04:00:00Z');
  try {
    const tools = world.tools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('journey_invite'), '缺 journey_invite');
    assert.ok(names.includes('journey_accept'), '缺 journey_accept');

    const accept = tools.find((t) => t.name === 'journey_accept');
    const out = await accept.handler({});
    assert.equal(out.isError, true, '没配服务器却报了成功');
    assert.match(String(out.text), /碰面服务器/, `原因不像人话：${out.text}`);
    // 「看」这一步不许改状态
    assert.equal(world.st.pledge, null);
  } finally { restore(); }
});

test('旧版服务端上问「有谁在找伴」：说清是服务器没有这个功能，不说「失败」', async () => {
  const { world, restore } = await boot({
    phase: 'staying',
    hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
    stayDateKey: '2026-11-04',
  }, '2026-11-04T04:00:00Z');
  try {
    // 这台机器上真实的配置就是腾讯云那个只实现了 /sight 的旧版
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    globalThis.fetch = async () => ({
      ok: false, status: 404, json: async () => { throw new SyntaxError('Unexpected token <'); },
    });
    const out = await world.tools().find((t) => t.name === 'journey_accept').handler({});
    assert.equal(out.isError, true);
    assert.match(String(out.text), /还没有邀约功能/, `说成了别的原因：${out.text}`);
  } finally { globalThis.fetch = async () => { throw new Error('offline'); }; restore(); }
});

test('接一条去不了的地方：先别接，别许一个做不到的承诺', async () => {
  /*
   * 「去不了」= 隔着海、对方没有机场、而这里又不是枢纽。
   * 这种组合在表里一定存在（岛上的城 + 内陆无机场的城），现场找一对，
   * 不写死城市名 —— 数据一改这条测试就得跟着改，那种测试没人维护。
   */
  let pair = null;
  const { CITIES } = await import('../src/geo/cities.ts');
  for (const a of CITIES) {
    for (const b of CITIES) {
      if (a.id !== b.id && distanceKm(a, b) > 60 && !canTravel(a, b)) { pair = [a, b]; break; }
    }
    if (pair) break;
  }
  assert.ok(pair, '城市表里找不到一对「到不了」的城 —— 判据失效了');

  const [from, to] = pair;
  const { world, restore } = await boot({
    phase: 'staying',
    hereId: from.id,
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
    stayDateKey: '2026-11-04',
  }, '2026-11-04T04:00:00Z');
  try {
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    globalThis.fetch = inviteServer({
      id: 'abcdef0123456789', pet: '小满', to: to.id, days: 2, note: '',
    });
    const out = await world.tools().find((t) => t.name === 'journey_accept')
      .handler({ id: 'abcdef0123456789' });
    assert.equal(out.isError, true, `从${from.name}到${to.name}根本走不了，却接下了`);
    assert.equal(world.st.pledge, null, '接不下却把约定写进去了');
  } finally { globalThis.fetch = async () => { throw new Error('offline'); }; restore(); }
});

test('已经有一份约定在手上：别接第二条', async () => {
  const { world, restore } = await boot({
    phase: 'staying',
    hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
    stayDateKey: '2026-11-04',
    pledge: pledgeTo('lasa', 3),
  }, '2026-11-04T04:00:00Z');
  try {
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: true, with: '阿七', to: 'chengdu', days: 2, note: '' }),
    });
    const out = await world.tools().find((t) => t.name === 'journey_accept')
      .handler({ id: 'ffffffffffffffff' });
    assert.equal(out.isError, true, '一趟里接了两份约定');
    assert.equal(world.st.pledge.cityId, 'lasa', '旧约定被新来的顶掉了');
  } finally { globalThis.fetch = async () => { throw new Error('offline'); }; restore(); }
});

test('接了之后那份约定里存的是「谁、去哪、几天、哪条」', async () => {
  const { world, events, restore } = await boot({
    phase: 'staying',
    hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
    stayDateKey: '2026-11-04',
  }, '2026-11-04T04:00:00Z');
  try {
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    globalThis.fetch = inviteServer({
      id: 'abcdef0123456789', pet: '小满', to: 'chengdu', days: 2, note: '一起吃火锅',
    });
    const out = await world.tools().find((t) => t.name === 'journey_accept')
      .handler({ id: 'abcdef0123456789' });
    assert.ok(!out.isError, `该接成：${out.text}`);
    const p = world.st.pledge;
    assert.equal(p.cityId, 'chengdu');
    assert.equal(p.days, 2);
    assert.equal(p.withPet, '小满');
    assert.equal(p.inviteId, 'abcdef0123456789');
    assert.equal(p.arrivedAt, null, '还没到就不该记到站时刻');

    const notice = events.filter((e) => e.type === 'journey.invite');
    assert.equal(notice.length, 1, '接下这么大事，得有一条她看得见的事件');
    assert.match(String(notice[0].text), /小满/);
    assert.match(String(notice[0].text), /成都/);
  } finally { globalThis.fetch = async () => { throw new Error('offline'); }; restore(); }
});

test('在家也能接 —— 接完当场从家出发，目的地就是约好的那座城', async () => {
  /*
   * 2026-11-06 改的口径。原来是「在家接不了，反正也赶不上」。
   *
   * 那句话在「她还要歇好几天」时成立，却被当成了所有在家情形的答案：
   * 休息期已结束、只是还没到出门点的那几个小时里，她也接不了 ——
   * 而邀约只有 24 小时，早上那几个钟头恰恰最容易错过。
   */
  const home = await boot({ phase: 'home', hereId: 'lanzhou' }, '2026-11-04T04:00:00Z');
  try {
    home.world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    globalThis.fetch = inviteServer({
      id: 'abcdef0123456789', pet: '小满', to: 'chengdu', days: 3, note: '一起吃火锅',
    });
    const out = await home.world.tools().find((t) => t.name === 'journey_accept')
      .handler({ id: 'abcdef0123456789' });
    assert.ok(!out.isError, `在家接不了：${out.text}`);
    const p = home.world.st.pledge;
    assert.ok(p, '接下了却没写进约定');
    assert.equal(p.cityId, 'chengdu');
    assert.equal(p.days, 3);
    // 不是「记下来等以后」—— 她当场就动身，而且去的是约好的那座城。
    assert.equal(home.world.st.phase, 'traveling', '接了却没出发');
    assert.equal(home.world.st.leg.toId, 'chengdu', '出发了，但去的不是约好的地方');
  } finally { globalThis.fetch = async () => { throw new Error('offline'); }; home.restore(); }
});

test('还在休息期就接不了 —— 歇到哪天得说清楚', async () => {
  const home = await boot({
    phase: 'home',
    hereId: 'lanzhou',
    restingUntil: '2026-11-09T00:00:00Z',
  }, '2026-11-04T04:00:00Z');
  try {
    home.world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    globalThis.fetch = inviteServer({
      id: 'abcdef0123456789', pet: '小满', to: 'chengdu', days: 3, note: '',
    });
    const out = await home.world.tools().find((t) => t.name === 'journey_accept')
      .handler({ id: 'abcdef0123456789' });
    assert.equal(out.isError, true, '还在歇着就接下了');
    assert.match(String(out.text), /歇/, `没说清是在休息：${out.text}`);
    assert.equal(home.world.st.pledge, null);
  } finally { globalThis.fetch = async () => { throw new Error('offline'); }; home.restore(); }
});

test('在路上接不了 —— 还没落地', async () => {
  const from = cityById('xian');
  const to = cityById('chengdu');
  const leg = buildJourney({
    from, to, mode: modeById('train'), km: Math.round(distanceKm(from, to)),
    at: new Date('2026-11-04T02:00:00Z'), speed: 1,
  });
  const away = await boot({
    phase: 'traveling',
    hereId: 'xian',
    leg,
    tripStartedAt: '2026-11-01T00:00:00Z',
  }, '2026-11-04T04:00:00Z');
  try {
    away.world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    globalThis.fetch = inviteServer({
      id: 'abcdef0123456789', pet: '小满', to: 'lasa', days: 3, note: '',
    });
    const out = await away.world.tools().find((t) => t.name === 'journey_accept')
      .handler({ id: 'abcdef0123456789' });
    assert.equal(out.isError, true, '在路上也接下了');
    assert.equal(away.world.st.pledge, null);
  } finally { globalThis.fetch = async () => { throw new Error('offline'); }; away.restore(); }
});

test('正在往回走的时候不接 —— 那条路本来就不会去', async () => {
  /*
   * 回程那一支在 `stayTick` 里排在约定之前，`moveOn` 在回程时也不看约定。
   * 也就是说这时候接下的约定**从机制上就兑现不了** —— 必须在入口挡住，
   * 不然她会当着人说「我答应你」，然后一路往家走。
   */
  const { world, restore } = await boot({
    phase: 'staying',
    hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
    stayDateKey: '2026-11-04',
    returning: true,
  }, '2026-11-04T04:00:00Z');
  try {
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: true, with: '小满', to: 'chengdu', days: 2, note: '' }),
    });
    const out = await world.tools().find((t) => t.name === 'journey_accept')
      .handler({ id: 'abcdef0123456789' });
    assert.equal(out.isError, true, '回程路上把约定接下了');
    assert.equal(world.st.pledge, null);
  } finally { globalThis.fetch = async () => { throw new Error('offline'); }; restore(); }
});

/* ============================================================
 * 约定撞上别的机制（2026-11-05 第二轮排查）
 *
 * 一个约定不是独立运行的：她会同时受钱、出门上限、打工、回家这几条管。
 * 下面每一条都对应一种「两条规则各自都对、合起来就错」的组合。
 * ============================================================ */

test('有人邀她去「家」那座城：接了会把状态搞乱，所以不许接', async () => {
  /*
   * 这条是真会发生的：家在兰州，她这会儿在西安，同城有人想去兰州待两天。
   *
   * 现在的代码会老老实实把她送到兰州 —— 但 `phase` 还是 `staying`，
   * `tripStartedAt` 还在，于是：没有 `journey.home` 事件、账不结、不进入休息期，
   * 第二天她还能从「家」直接挑一个新目的地出门 —— 相当于绕过了整套回家的逻辑。
   */
  const { world, restore } = await boot({
    phase: 'staying',
    hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
    stayDateKey: '2026-11-04',
  }, '2026-11-04T04:00:00Z');
  try {
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: true, with: '小满', to: 'lanzhou', days: 2, note: '' }),
    });
    const out = await world.tools().find((t) => t.name === 'journey_accept')
      .handler({ id: 'abcdef0123456789' });
    assert.equal(out.isError, true, '邀她去家那座城也接了 —— 接下来回家那套逻辑全被绕过');
    assert.equal(world.st.pledge, null);
  } finally { globalThis.fetch = async () => { throw new Error('offline'); }; restore(); }
});

test('待满之后却走不了（钱见底）：别一直说「还剩 0 天」', async () => {
  /*
   * 决策点的顺序是「打工 / 回家」在「约定」之前 —— 钱见底那天她会先去打工，
   * 一走六天。而 `pledgeText` 还在算「还剩 N 天」，N 早就是 0 了。
   *
   * 连着一周显示「还剩 0 天」，她读到就会说「说好三天我还没走」——
   * 那是把一个算不出来的状态描述成了她的失约。
   */
  const now = new Date('2026-11-04T00:30:00Z');
  const { world, restore } = await boot({
    phase: 'staying',
    hereId: 'lasa',
    tripStartedAt: '2026-10-28T00:00:00Z',
    stayStartedAt: '2026-10-31T00:00:00Z',
    stayDateKey: '2026-11-04',
    pledge: pledgeTo('lasa', 3, { arrivedAt: '2026-10-31T00:00:00Z' }),
    spent: 100,
  }, now.toISOString());
  try {
    world.cfg.moneyEnabled = true;
    world.cfg.budget = 100;
    const text = String(world.nowSummary());
    assert.doesNotMatch(text, /还剩 0 天/, `待满还挂着一句「还剩 0 天」：${text}`);
    assert.match(text, /待满|满了|该走/, `没说清已经待满：${text}`);
  } finally { restore(); }
});

test('约定挡得住出门上限：约没守完就先不走（2026-11-15 改）', async () => {
  /*
   * Mr.Q 定的顺序：「在外面接了别人的约，我设的时间到了，也该以守约为准，
   * 守完这趟再往回赶。」
   *
   * 这条原来是反过来的 —— 到周数直接回家、顺手把约清掉：
   * 「约定挡不住出门上限：到周数照样回家，约定一起清掉」。
   * 11-15 佛山那次实测把这个顺序的代价演了一遍：13:17 刚订房，13:18 被上限掐走。
   */
  const now = new Date('2026-11-04T00:30:00Z');
  const { world, events, restore } = await boot({
    phase: 'staying',
    hereId: 'lasa',
    // 这一趟已经走了 21 天，上限 2 周
    tripStartedAt: '2026-10-14T00:00:00Z',
    stayStartedAt: '2026-11-03T00:00:00Z',
    stayDateKey: '2026-11-04',
    // 约才守到第 1 天（3 天的约）
    pledge: pledgeTo('lasa', 3, { arrivedAt: '2026-11-03T00:00:00Z' }),
  }, now.toISOString());
  try {
    world.cfg.maxTripWeeks = 2;
    await world.tick();
    assert.equal(events.filter((e) => e.type === 'journey.home').length, 0, '约还没守完就回家了');
    assert.ok(world.st.pledge, '约被上限清掉了 —— 她连「跟谁说好的」都说不出来');
    assert.equal(world.st.returning, false, '不该在路上，约还在进行中');
  } finally { restore(); }
});

test('约守完了、上限也到了：直接往回走，不再挑下一站', async () => {
  const now = new Date('2026-11-04T00:30:00Z');
  const { world, events, restore } = await boot({
    phase: 'staying',
    hereId: 'lasa',
    tripStartedAt: '2026-10-14T00:00:00Z',
    stayStartedAt: '2026-11-01T00:00:00Z',
    stayDateKey: '2026-11-04',
    // 3 天的约已经守满
    pledge: pledgeTo('lasa', 3, { arrivedAt: '2026-11-01T00:00:00Z' }),
  }, now.toISOString());
  try {
    world.cfg.maxTripWeeks = 2;
    await world.tick();
    assert.equal(world.st.returning, true, '约守完了却没往回走');
    assert.equal(world.st.pledge, null, '回家路上还挂着约');
    /*
     * 2026-11-15 起回家不再一步到家（拉萨离兰州两千公里），
     * 所以这一拍只是「决定回家、动身」。`journey.home` 要等她真的走到家才推。
     */
    assert.equal(
      events.filter((e) => e.type === 'journey.home').length, 0,
      '一步就到家了 —— 那是瞬移',
    );
  } finally { restore(); }
});

test('列表里不该出现「看见了但接不了」的邀约：去家那座城的、去她此时所在地的', async () => {
  /*
   * 这两种接了都会被拒（一个是回家要走另一条路，一个是她已经在）。
   * 留在列表里，她会反复去点一个坏按钮，然后被拒 —— 那是把人往坑里引。
   */
  const { world, restore } = await boot({
    phase: 'staying',
    hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
    stayDateKey: '2026-11-04',
  }, '2026-11-04T04:00:00Z');
  try {
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        ok: true,
        list: [
          { id: 'aaaaaaaaaaaaaaaa', pet: '甲', to: 'lanzhou', days: 2, note: '' },  // 家
          { id: 'bbbbbbbbbbbbbbbb', pet: '乙', to: 'xian', days: 2, note: '' },     // 就在这儿
          { id: 'cccccccccccccccc', pet: '丙', to: 'chengdu', days: 2, note: '' },  // 能接
        ],
      }),
    });
    const out = await world.tools().find((t) => t.name === 'journey_accept').handler({});
    assert.ok(!out.isError, `该能看：${out.text}`);
    assert.match(String(out.text), /丙/, '能接的那条被误删了');
    assert.doesNotMatch(String(out.text), /甲/, '去家那座城的邀约还在列表里');
    assert.doesNotMatch(String(out.text), /乙/, '去她此时所在地的邀约还在列表里');
  } finally { globalThis.fetch = async () => { throw new Error('offline'); }; restore(); }
});

test('全都被过滤掉时，说「没有能接的」，不是空列表', async () => {
  const { world, restore } = await boot({
    phase: 'staying',
    hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
    stayDateKey: '2026-11-04',
  }, '2026-11-04T04:00:00Z');
  try {
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        ok: true,
        list: [{ id: 'aaaaaaaaaaaaaaaa', pet: '甲', to: 'lanzhou', days: 2, note: '' }],
      }),
    });
    const out = await world.tools().find((t) => t.name === 'journey_accept').handler({});
    assert.match(String(out.text), /没有能接/, `说的不是「没有能接的」：${out.text}`);
  } finally { globalThis.fetch = async () => { throw new Error('offline'); }; restore(); }
});

test('回程拒接的文案不许替他说没说过的：「他叫回来的」只有 receiving 是他叫的才对', async () => {
  /*
   * `returning` 有四种来路：他叫回 / 到周数上限 / 钱撑不下去 / 自己待够了。
   * 2026-11-05 的 144 天模拟里，文案把「到上限往回走」也写成了「他叫回来的」——
   * 等于替他认领了一个他没做过的决定。
   */
  const mk = async (reason) => boot({
    phase: 'staying',
    hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
    stayDateKey: '2026-11-04',
    returning: true,
    returnReason: reason,
  }, '2026-11-04T04:00:00Z');

  const limit = await mk('limit');
  try {
    limit.world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    const out = await limit.world.tools().find((t) => t.name === 'journey_accept')
      .handler({ id: 'abcdef0123456789' });
    assert.equal(out.isError, true);
    assert.doesNotMatch(String(out.text), /他叫/, `上限回程被写成了「他叫回来的」：${out.text}`);
  } finally { limit.restore(); }

  const called = await mk('called');
  try {
    called.world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    const out = await called.world.tools().find((t) => t.name === 'journey_accept')
      .handler({ id: 'abcdef0123456789' });
    assert.match(String(out.text), /他叫/, `真叫回来的反而没写：${out.text}`);
  } finally { called.restore(); }
});

test('买不起的邀约在入口就拒 —— 不要「答应了」隔一夜再「算了」', async () => {
  /*
   * 144 天模拟抓到的原样：她在徐州接了「一起去布宜诺斯艾利斯」，第二天早上
   * `moveOn` 一看跨洲机票买不起，直接作废并推一条「只能算了」。
   * 那张票当时就算得出来 —— 坑完全可以在入口避开。
   */
  const { world, restore } = await boot({
    phase: 'staying',
    hereId: 'xuzhou',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
    stayDateKey: '2026-11-04',
  }, '2026-11-04T04:00:00Z');
  try {
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    world.cfg.moneyEnabled = true;
    world.cfg.budget = 500;      // 只有五百块，跨洲的票买不起
    globalThis.fetch = inviteServer({
      id: 'abcdef0123456789', pet: '小满', to: 'buenosaires', days: 2, note: '',
    });
    const out = await world.tools().find((t) => t.name === 'journey_accept')
      .handler({ id: 'abcdef0123456789' });
    assert.equal(out.isError, true, `五百块也接了跨洲的约：${out.text}`);
    assert.match(String(out.text), /付不起|买不起/, `原因没说钱：${out.text}`);
    assert.equal(world.st.pledge, null);
  } finally { globalThis.fetch = async () => { throw new Error('offline'); }; restore(); }
});

test('打工期间不接邀约 —— 接了也一定过期', async () => {
  /*
   * `stayTick` 里「打工期间」排在约定之前，工没做完约定的天数一天都推不动，
   * 而邀约的寻人窗口只有一两天。接了就是空答应。
   */
  const { world, restore } = await boot({
    phase: 'staying',
    hereId: 'changshu',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-03T00:00:00Z',
    stayDateKey: '2026-11-04',
    work: {
      cityId: 'changshu', startedOn: '2026-11-03', until: '2026-11-09T02:00:00Z',
      pay: 120, gig: '仓库理货',
    },
  }, '2026-11-04T04:00:00Z');
  try {
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    let called = 0;
    globalThis.fetch = async () => {
      called += 1;
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, with: '小满', to: 'chengdu', days: 2, note: '' }),
      };
    };
    const out = await world.tools().find((t) => t.name === 'journey_accept')
      .handler({ id: 'abcdef0123456789' });
    assert.equal(out.isError, true, `打工期间把邀约接了：${out.text}`);
    assert.match(String(out.text), /工/, `没说清在打工：${out.text}`);
    assert.equal(world.st.pledge, null);
    assert.equal(called, 0, '明知道接不了还发了「接」的请求');
  } finally { globalThis.fetch = async () => { throw new Error('offline'); }; restore(); }
});

/* ---------------- 2026-11-17：终于有了「不等了」 ---------------- */

test('不等了：撤掉约定，人留在原地，不是瞬移回家', async () => {
  /*
   * zzy1053 报的：11-15 约好去哈尔滨、在呼和浩特会合，两次早上都判「人还没露面」，
   * 要等 11-18 才自动散伙，「这三天里没有任何自助取消入口」，
   * 「她会跟用户说『你在面板上把那邀约撤掉』，用户照着找只会白找」。
   *
   * 内部一直有 `dropPledge()`，缺的是入口。这条钉住三件事：
   * 撤得掉、撤完还在原地、对方那边会留一句话。
   */
  const now = new Date('2026-11-17T02:00:00Z');
  const { world, events, restore } = await boot({
    phase: 'staying',
    hereId: 'hohhot',
    currentCityId: 'hohhot',
    arrivedAt: '2026-11-15T02:00:00Z',
  }, now.toISOString());
  /*
   * 启动时 `prunePledge` 会按窗口判一遍，可能先把这份约定清掉 ——
   * 所以这里在 start 之后直接摆状态，测的是「撤」这个动作本身。
   */
  world.st = {
    ...world.st,
    pledge: pledgeTo('harbin', 2, {
      meetCityId: 'hohhot',
      meetArrivedAt: '2026-11-15T03:00:00Z',
    }),
  };
  try {
    const before = world.st.hereId;
    const r = world.giveUpPledge(now, '等了三天，人不来');
    assert.equal(r.isError, undefined, r.text);
    assert.equal(world.st.pledge, null, '约定没清掉');
    /* 撤的是「等」这件事，不是位置 —— 前后 `hereId` 必须一样。 */
    assert.equal(world.st.hereId, before, '撤约定把人挪走了');
    assert.ok(
      events.some((e) => /不等了|作废|去不成了/.test(String(e.text ?? e))),
      `自己这边没推事件：${events.map((e) => e.type ?? e).join(',')}`,
    );
  } finally { restore(); }
});

test('没有约定时删也删不掉什么，得直说', async () => {
  const now = new Date('2026-11-17T02:00:00Z');
  const { world, restore } = await boot({ phase: 'home', hereId: 'lanzhou' }, now.toISOString());
  try {
    const r = world.giveUpPledge(now, '');
    assert.equal(r.isError, true, '没约定还说撤了，那是编');
    assert.match(r.text, /没有/, r.text);
  } finally { restore(); }
});
