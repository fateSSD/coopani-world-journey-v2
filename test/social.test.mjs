/**
 * 联机的三个入口（2026-11-05，0.6.3）
 *
 * 起因：Mr.Q「新功能从哪看？我找不到啊」。查下来是真的没有入口 —— 联机这块界面上
 * 一个按钮都没有，用户不知道有这功能，也就永远不会去用。补了三处：
 *
 *   ① 面板一行：同城几个人 / 有没有人在找伴 / 跟谁约好还剩几天
 *   ② 到站那句话里顺口带一句「这一带还有谁」
 *   ③ 设置里那段说明补上「填完你会看到什么」
 *
 * 这里守前两条的数据来源 —— 界面上少一个字段不会报错，只会静默少一行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

function fakeHost(events) {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => { events.push(e); return { ...e, blobs: [] }; },
    pushDeferred() {}, store: {}, drainPendingEvents: async () => [],
  };
}

/** 假装同城有一个「小满」、池子里共 pool 只。别的请求一律回空。 */
function stubMeet(neighbors = [{ pet: '小满', doing: '吃面' }], pool = 1) {
  return async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (u.includes('/invite')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, list: [] }) };
    }
    if (method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, list: neighbors, pool }) };
  };
}

const staying = (extra = {}) => ({
  phase: 'staying',
  hereId: 'xian',
  tripStartedAt: '2026-11-01T00:00:00Z',
  stayStartedAt: '2026-11-02T00:00:00Z',
  stayDateKey: '2026-11-04',
  ...extra,
});

async function boot(trip, nowISO, cfgExtra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-social-'));
  new StateStore(dir).save({ ...initialState('lanzhou'), ...trip });
  const events = [];
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', ...cfgExtra },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(nowISO),
  });
  const origFetch = globalThis.fetch;
  await world.start(fakeHost(events));
  const restore = () => { globalThis.fetch = origFetch; world.stop?.(); };
  return { world, events, restore };
}

const NOW = '2026-11-05T02:00:00Z';

/* ---------------- ① 面板那一行 ---------------- */

test('没配服务器、手上也没约定：面板这一行整条不出现', async () => {
  const { world, restore } = await boot(staying(), NOW);
  try {
    const snap = world.uiSnapshot();
    assert.equal(snap.social, null, '没配服务器却多出一行空壳');
  } finally { restore(); }
});

test('配了服务器：同城人数和找伴条数都要报出来', async () => {
  globalThis.fetch = stubMeet();
  const { world, restore } = await boot(staying(), NOW, { meetUrl: 'https://x.test' });
  try {
    await world.tick();          // 排一次表，邻居才进来
    const snap = world.uiSnapshot();
    assert.ok(snap.social, '配了服务器却没有 social');
    assert.equal(snap.social.nearby, 1, `同城人数不对：${snap.social.nearby}`);
    assert.equal(snap.social.pledge, null);
  } finally { restore(); }
});

test('配了服务器但同城没人：也要有一行，说「没别人」而不是消失', async () => {
  /*
   * 这条是「找不到入口」的另一半：用户填完地址，如果界面毫无变化，
   * 他只会以为没生效，然后去翻设置。有一个「0」也比什么都没有强。
   */
  globalThis.fetch = stubMeet([]);
  const { world, restore } = await boot(staying(), NOW, { meetUrl: 'https://x.test' });
  try {
    await world.tick();
    const snap = world.uiSnapshot();
    assert.ok(snap.social, '同城没人时这一行消失了');
    assert.equal(snap.social.nearby, 0);
  } finally { restore(); }
});

test('在家也看得到池子总数 —— 这一行原来只在城里停留时才有', async () => {
  /*
   * 2026-11-06 Mr.Q：「池子总数只有我能看到是吧，我在另一台电脑上看不到」。
   *
   * 不是权限。`pool` 是全局数字，谁来问都给。问题是它**只在 `rebuildPlan` 里顺带取**
   * （跟「同城有谁」同一次请求），而排表只发生在 `staying` —— 那台机器的鱼恰好在家，
   * 于是面板上「池子今天一共 N 只」整条消失，看起来就像只有别人能看到。
   *
   * 现在 `probePool` 补上另外两种状态，20 分钟取一次。
   */
  globalThis.fetch = stubMeet([], 18);
  const { world, restore } = await boot({ phase: 'home', hereId: 'lanzhou' }, NOW, { meetUrl: 'https://x.test' });
  try {
    await world.tick();
    const snap = world.uiSnapshot();
    assert.ok(snap.social, '在家时这一行整条都没了');
    assert.equal(snap.social.pool, 18, `在家拿不到池子总数：${snap.social.pool}`);
  } finally { restore(); }
});

test('答应了人：面板要报「跟谁、还剩几天、到没到」', async () => {
  const { world, restore } = await boot(staying({
    hereId: 'chengdu',
    stayStartedAt: '2026-11-03T00:00:00Z',
    pledge: {
      cityId: 'chengdu', days: 3, withPet: '小满', inviteId: 'abcdef0123456789',
      acceptedAt: '2026-11-03T00:00:00Z',
      arrivedAt: '2026-11-03T12:00:00Z',
    },
  }), NOW);
  try {
    const snap = world.uiSnapshot();
    const p = snap.social && snap.social.pledge;
    assert.ok(p, '约定没进面板');
    assert.equal(p.withPet, '小满');
    assert.equal(p.city, '成都');
    assert.equal(p.days, 3);
    assert.equal(p.here, true, '已经到了，却说没到');
    // 11-03 12:00 到，11-05 02:00 = 38 小时，三天还差 34 小时 → 还剩 2 天
    assert.equal(p.daysLeft, 2, `剩余天数算错：${p.daysLeft}`);
  } finally { restore(); }
});

test('还没走到：说「说好去某地」，不编「还剩几天」', async () => {
  const { world, restore } = await boot(staying({
    pledge: {
      cityId: 'lasa', days: 3, withPet: '小满', inviteId: 'abcdef0123456789',
      acceptedAt: '2026-11-04T00:00:00Z', arrivedAt: null,
    },
  }), NOW);
  try {
    const p = world.uiSnapshot().social?.pledge;
    assert.ok(p, '约定没进面板');
    assert.equal(p.here, false);
    assert.equal(p.city, '拉萨');
  } finally { restore(); }
});

/* ---------------- ② 到站那句话 ---------------- */

test('到站那句话里要带上「这一带还有谁」—— 不等第二天早上那句', async () => {
  globalThis.fetch = stubMeet([{ pet: '小满', doing: '吃面' }]);
  const lat = '2026-11-05T01:20:00Z';
  const dir = mkdtempSync(join(tmpdir(), 'jr-social-'));
  new StateStore(dir).save({
    ...initialState('lanzhou'),
    phase: 'traveling',
    hereId: 'xian',
    tripStartedAt: '2026-11-03T00:00:00Z',
    leg: {
      id: 'leg1', fromId: 'xian', toId: 'chengdu', modeId: 'train', km: 700,
      durationWorldHours: 8, departedAt: '2026-11-04T17:20:00Z',
      arriveAt: lat, speed: 1, viaIds: [], createdAt: '2026-11-04T17:20:00Z',
    },
  });
  const events = [];
  const origFetch = globalThis.fetch;
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', meetUrl: 'https://x.test' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(lat),
  });
  await world.start(fakeHost(events));
  try {
    await world.tick();
    const arr = events.find((e) => e.type === 'journey.arrive');
    assert.ok(arr, '没有到站事件');
    assert.match(String(arr.text), /小满/, `到站那句里没提这一带还有谁：${arr.text}`);
  } finally { globalThis.fetch = origFetch; world.stop?.(); }
});

test('池子总数要进面板：同城没人也能看出「这条线是活的」', async () => {
  /*
   * 2026-11-05 Mr.Q 在另一台电脑上填了地址，面板写着「同城 · 这段时间没别人」，
   * 他以为没生效。真实的区别在池子里有没有别的人 —— 只给「同城 0」，
   * 「今天真没人」和「这条线坏了」长得一模一样。所以再给一个总数。
   */
  globalThis.fetch = stubMeet([], 37);
  const { world, restore } = await boot(staying(), NOW, { meetUrl: 'https://x.test' });
  try {
    await world.tick();
    const snap = world.uiSnapshot();
    assert.ok(snap.social, '没 social');
    assert.equal(snap.social.nearby, 0);
    assert.equal(snap.social.pool, 37, `池子总数没进快照：${snap.social.pool}`);
  } finally { restore(); }
});

/* ---------- 两条鱼一起去：发起者也要认领 ---------- */

test('别人接了她说的话：自己也往那儿走，并说出来', async () => {
  /*
   * 2026-11-05 Mr.Q：「发完邀请两条鱼一起去一个地方」。
   * 原来只有**接的人**得到约定，发起者永远不知道有没有人应 —— 那就不可能「一起」。
   * 现在发起者在下次排表时认领一次（服务端 owner_seen 保证只给一次）。
   */
  let claimed = false;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (u.includes('mine=1')) {
      if (claimed) return { ok: true, status: 200, json: async () => ({ ok: true, list: [] }) };
      claimed = true;
      return {
        ok: true, status: 200,
        json: async () => ({
          ok: true,
          list: [{ id: 'abcdef0123456789', pet: '小银鱼', to: 'lasa', days: 3, note: '想看雪山' }],
        }),
      };
    }
    if (u.includes('/invite')) return { ok: true, status: 200, json: async () => ({ ok: true, list: [] }) };
    if (method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, list: [], pool: 2 }) };
  };

  const { world, events, restore } = await boot(staying(), NOW, { meetUrl: 'https://x.test' });
  try {
    await world.tick();
    const p = world.st.pledge;
    assert.ok(p, '发起者没认领到约定');
    assert.equal(p.withPet, '小银鱼');
    assert.equal(p.cityId, 'lasa');
    assert.equal(p.days, 3);
    const ev = events.find((e) => e.type === 'journey.invite');
    assert.ok(ev, '没有推「有人接了」那条');
    assert.match(String(ev.text), /小银鱼/, `事件里没提是谁：${ev.text}`);
    assert.match(String(ev.text), /拉萨/);
    // 排表时不该重复建：第二次 tick 仍然是同一个约定
    await world.tick();
    assert.equal(world.st.pledge.cityId, 'lasa');
  } finally { restore(); }
});

/* ---------- 一次失败 ≠ 一整天没连上（2026-11-20 Mr.Q 报的） ---------- */

/**
 * 搭一台「同城接口单独坏掉」的服务器：`/sight/status` 一直好的，`/sight`（同城）按开关坏。
 *
 * 这正是截图上那个组合 —— 池子 324 只、3 个在找伴都正常，唯独「同城」说没连上。
 */
async function bootMeetFlaky() {
  const dir = mkdtempSync(join(tmpdir(), 'jr-meet-retry-'));
  new StateStore(dir).save({ ...initialState('lanzhou'), ...staying() });
  const clock = { now: new Date(NOW), down: true, neighbors: 0 };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (u.includes('/sight/status')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, list: [], pool: 324 }) };
    }
    if (u.includes('/invite')) return { ok: true, status: 200, json: async () => ({ ok: true, list: [] }) };
    if (method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
    clock.neighbors += 1;
    if (clock.down) throw new Error('ECONNRESET');
    return { ok: true, status: 200, json: async () => ({ ok: true, list: [{ pet: '鲸鲸', doing: '逛早市' }], pool: 324 }) };
  };
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', meetUrl: 'https://x.test' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => clock.now,
  });
  await world.start(fakeHost([]));
  return { world, clock };
}

test('同城那条线抖了一下，退避之后自己翻回来；池子照旧是活的', async () => {
  /*
   * 他的原话：「明明能约到人却显示服务器没连上」。截图里同时有两组数字：
   *   池子 324 只 / 3 个在找伴  ← 走 `/sight/status`，一直好的
   *   同城 · 碰面服务器没连上   ← 走 `/sight`，只在排表和判定那两次问
   *
   * 所以「没连上」停在面板上，不等于线断了，只等于**那一次**没成。
   * 这条守的是：再问一次成了，就得翻回来，而且同城名单跟着换 ——
   * 只翻灯不换数字，等于嘴上说通了、名单还是昨天那份。
   */
  const origFetch = globalThis.fetch;
  const { world, clock } = await bootMeetFlaky();
  try {
    await world.tick();
    let snap = world.uiSnapshot();
    assert.equal(snap.social.online, false, '这一次确实没连上，应当如实说没连上');
    assert.equal(snap.social.pool, 324, `池子这条线是好的，不该跟着变灰：${snap.social.pool}`);

    const tried = clock.neighbors;
    /* 首档是 2 分钟。探针那头失败只占退避位、不推进步进，所以第一档就是 2 分钟。 */
    clock.now = new Date(clock.now.getTime() + 90_000);
    await world.tick();
    assert.equal(clock.neighbors, tried, `退避没生效，90 秒内又打了一次（${tried} → ${clock.neighbors}）`);

    clock.down = false;
    clock.now = new Date(clock.now.getTime() + 60_000);   // 累计 2.5 分钟，过第一档
    await world.tick();
    snap = world.uiSnapshot();
    assert.equal(snap.social.online, true, '线回来了，面板还顶着「没连上」');
    assert.equal(snap.social.nearby, 1, `翻回来之后同城名单没跟着换：${snap.social.nearby}`);
  } finally {
    globalThis.fetch = origFetch;
    world.stop?.();
  }
});

/* ---------- 「暂时没别人」不许在有人来过的时候说（2026-11-20） ---------- */

test('今天有人来过、只是这会儿不在 —— 面板不许写「这段时间没别人」', async () => {
  /*
   * 第二张截图里那一行：`同城 · 暂时没别人`。
   * 服务端 `/sight` 一直回着 `here: 3`（今天这座城来过 3 只，去重 uid），
   * 客户端**一个字段都没接** —— 面板只读 `plan.neighbors.length`，
   * 而那是「当天第一次排表那一刻、某一个时段、最近 2 小时」的名单。
   *
   * 这里的判据有两层：
   *   ① `here` 要接上，且减一（服务端那条 COUNT 不带 exclude，她自己算在里面）
   *   ② 名单要能自己变新，不能一天只取一次
   */
  const dir = mkdtempSync(join(tmpdir(), 'jr-meet-here-'));
  new StateStore(dir).save({ ...initialState('lanzhou'), ...staying() });
  const clock = { now: new Date(NOW), list: [], here: 3, sights: 0 };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (u.includes('/sight/status')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, list: [], pool: 324 }) };
    }
    if (u.includes('/invite')) return { ok: true, status: 200, json: async () => ({ ok: true, list: [] }) };
    if (method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
    clock.sights += 1;
    return { ok: true, status: 200, json: async () => ({ ok: true, list: clock.list, pool: 324, here: clock.here }) };
  };
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', meetUrl: 'https://x.test' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => clock.now,
  });
  await world.start(fakeHost([]));
  try {
    await world.tick();
    let s = world.uiSnapshot().social;
    assert.equal(s.nearby, 0, `此刻确实没人：${s.nearby}`);
    assert.equal(s.here, 2, `here 含她自己，减一才是「别人」：${s.here}`);

    /* 一小时后有人来了一趟。名单和那个数字都得跟着动。 */
    clock.list = [{ pet: '鲸鲸', doing: '逛早市' }];
    clock.here = 5;
    clock.now = new Date(clock.now.getTime() + 61 * 60_000);
    await world.tick();
    s = world.uiSnapshot().social;
    assert.equal(s.nearby, 1, `名单没跟着刷新，还是一小时前那份：${s.nearby}`);
    assert.equal(s.here, 4, `今天来过几只没更新：${s.here}`);
  } finally {
    globalThis.fetch = origFetch;
    world.stop?.();
  }
});

/* ---------- 2026-11-20 回补：探针的四个边界（第三方审查指出，逐条复现过） ---------- */

/**
 * 一台可控的碰面服务器：`/sight` 回什么、坏不坏，都由 `srv` 决定。
 *
 * `srv.here` 是「今天这座城来过几只」（服务端 COUNT(DISTINCT uid)，不带 exclude），
 * `srv.list` 是最近 2 小时、当前时段有谁。
 */
async function bootProbe({ phase = 'staying', hereId = 'xian', srv }) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-probe-'));
  new StateStore(dir).save({
    ...initialState('lanzhou'),
    ...(phase === 'staying' ? staying({ hereId }) : { phase, hereId }),
  });
  srv.now = new Date(NOW);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (u.includes('/sight/status')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, list: [], pool: 324 }) };
    }
    if (u.includes('/invite')) return { ok: true, status: 200, json: async () => ({ ok: true, list: [] }) };
    if (method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
    srv.hits = (srv.hits || 0) + 1;
    if (srv.down) throw new Error('ECONNRESET');
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, list: srv.list ?? [], pool: 324, here: srv.here ?? 0 }),
    };
  };
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', meetUrl: 'https://x.test' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => srv.now,
  });
  await world.start(fakeHost([]));
  return { world, srv, restore: () => { globalThis.fetch = origFetch; world.stop?.(); } };
}

test('探针的冷却要认城市：换了城不许把上一座城的数写在新城面板上', async () => {
  /*
   * 第一版 `nearbyProbe` 只有 `{ at, here, n }`，冷却只看 60 分钟。
   * 于是 60 分钟内从西安到重庆，面板会拿西安的 `here: 12` 显示在重庆 ——
   * 实测复现过。**一个错得理直气壮的数字，比没有数字糟得多。**
   */
  const srv = { here: 12, list: [], hits: 0, down: false };
  const { world, restore } = await bootProbe({ srv });
  try {
    await world.tick();
    /* 停留中会 `reportHere()`，她也进了那个 COUNT，所以 12 − 1 = 11。 */
    assert.equal(world.uiSnapshot().social.here, 11, `西安 12 只去过掉她自己：${world.uiSnapshot().social.here}`);

    /* 十分钟后落在重庆，重庆今天只有 1 只。冷却没过，但城变了。 */
    srv.here = 1;
    srv.now = new Date(srv.now.getTime() + 10 * 60_000);
    world.st = { ...world.st, hereId: 'chongqing' };
    await world.tick();
    assert.equal(world.uiSnapshot().social.here, 1,
      `换了城还报着上一座城的数：${world.uiSnapshot().social.here}`);
  } finally { restore(); }
});

test('探针失败要亮红灯，否则断线了面板还说「连上了」', async () => {
  /*
   * 第一版 `probeNearby` 失败直接 `return`，不翻 `lastMeetOk`。
   * 而 `refreshMeetIfDown` 只在 `lastMeetOk === false` 时才重试 —— 两边一起哑：
   * 灯是绿的，自愈也不会启动。
   */
  const srv = { here: 3, list: [], hits: 0, down: true };
  const { world, restore } = await bootProbe({ srv });
  try {
    await world.tick();
    assert.equal(world.uiSnapshot().social.online, false, '这一打确实没连上，面板应当如实说');
  } finally { restore(); }
});

test('重试成功之后 here 要跟着回来，不许锁 0 一小时', async () => {
  /*
   * 首轮失败时探针把 `nearbyProbe` 锁成 `here: 0`（失败也占住那一小时）。
   * 几分钟后重试拿到 `here: 5`，第一版只改了 `plan.neighbors`、忘了回填 `nearbyProbe` ——
   * 面板要再等近一小时才更新。**灯绿了、数字还是错的，等于只修了一半。**
   */
  const srv = { here: 5, list: [], hits: 0, down: true };
  const { world, restore } = await bootProbe({ srv });
  try {
    await world.tick();
    assert.equal(world.uiSnapshot().social.online, false);

    srv.down = false;
    srv.now = new Date(srv.now.getTime() + 3 * 60_000);   // 过 2 分钟退避
    await world.tick();
    const s = world.uiSnapshot().social;
    assert.equal(s.online, true, '线回来了，灯得翻');
    /* 停留中会 `reportHere()`，她自己也在那个 COUNT 里，所以 5 − 1 = 4。 */
    assert.equal(s.here, 4, `重试成功却没回填 here：${s.here}`);
  } finally { restore(); }
});

test('在家/在路上从不上报 presence，here 里没有她，减一就是少报一只', async () => {
  /*
   * `reportHere()` 只在 `phase === 'staying'` 时发。在家时服务端根本不知道她来过，
   * `here: 1` 就是「真的有一只别人」—— 无条件减一会变成「这段时间没别人」。
   *
   * 判据是「这个数含不含她自己」，不是「永远是 1」：
   * 在家不减，停留中且今天报过到才减。
   */
  const srv = { here: 1, list: [], hits: 0, down: false };
  const { world, restore } = await bootProbe({ phase: 'home', hereId: 'lanzhou', srv });
  try {
    await world.tick();
    assert.equal(world.uiSnapshot().social.here, 1, `在家那一只别人被减没了：${world.uiSnapshot().social.here}`);
  } finally { restore(); }
});

/* ---------- 接了约当天就走（2026-11-20 Mr.Q 报的） ---------- */

/**
 * 一台「有约可接」的服务器：`/invite` 回一条，`/accept` 收下。
 *
 * 这条守的是 Mr.Q 截图里那对矛盾：消息说「把山上剩的半截走完就动身」，
 * 「接下来」那栏还是这座城市一整天的大盘鸡、戈壁滩、滑沙。
 */
function inviteReadyServer(one, clock, mine = []) {
  return async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (u.includes('/accept')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          ok: true, with: one.pet, to: one.to, days: one.days,
          note: one.note, meet: one.meet, pace: one.pace,
        }),
      };
    }
    if (u.includes('/sight/status')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, list: [], pool: 10 }) };
    }
    /*
     * `mine=1` 是「我发的那条被谁接了」（`myTakenInvites`），空着 ——
     * 这条测的是她**主动去接别人的**，不是别人接了话推给她。
     * 两个接口共用 `/invite` 路径，只有这一个参数分得开。
     */
    if (u.includes('/invite')) {
      const isMine = u.includes('mine=1');
      return { ok: true, status: 200, json: async () => ({ ok: true, list: isMine ? mine : [one] }) };
    }
    if (method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, list: [one], pool: 10, here: 2 }) };
  };
}

async function bootTakeToday(nowISO, tripExtra = {}, life = null) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-take-today-'));
  /*
   * 「她在不在睡」读的是 life 广播的那份文件，不是 journey 自己的 state
   * （见 `asleepUntil`：只读不写，两个世界各有各的账）。
   */
  if (life) writeFileSync(join(dir, 'life-public.json'), JSON.stringify(life));
  new StateStore(dir).save({
    ...initialState('lanzhou'),
    ...staying({
      /* 停留从昨天开始：`stayDays` 只有 1，够不着「待够了」那条，不会自己走人。 */
      stayStartedAt: '2026-11-04T00:00:00Z',
      stayDateKey: '2026-11-05',
      ...tripExtra,
    }),
  });
  const clock = { now: new Date(nowISO) };
  const one = {
    id: 'abcdef0123456789', pet: '鲸鲸', to: 'suzhou', days: 2,
    note: '', meet: 'shanghai', pace: 1,
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = inviteReadyServer(one, clock);
  const events = [];
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', meetUrl: 'https://x.test' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => clock.now,
  });
  await world.start(fakeHost(events));
  return {
    world, clock, one, events,
    restore: () => { globalThis.fetch = origFetch; world.stop?.(); },
  };
}

test('上午接了约：今天就动身，行程不许还照着原计划走下去', async () => {
  /*
   * 时间是当地 10:00 —— 「今天走不走」在早上八点已经判过，`decidedOn` 记成今天。
   * 缺口就在这里：`pledge` 写进了状态，可**今天再没有第二个决策点**，
   * `here.id !== pledgeStop` 那一支要明天早上才被读到。
   * 中间十几个小时她照原计划把这座城逛完，台词却早就说了「这就动身」。
   */
  const { world, clock, one, restore } = await bootTakeToday(NOW);
  try {
    await world.tick();
    assert.equal(world.st.decidedOn, '2026-11-05', '先确认今天的决策额度已经用掉（这正是缺口的前提）');
    assert.equal(world.st.phase, 'staying');

    const r = await world.takeInvite(one.id);
    assert.equal(r.isError, undefined, `该接成：${r.text}`);
    assert.equal(world.st.decidedOn, null, '接完约没有把今天的决策重开 —— 这一整天都会照原计划逛');
    assert.match(r.text, /这会儿就该动身/, `回执没交代今天走不走：${r.text}`);

    clock.now = new Date(clock.now.getTime() + 60_000);   // 下一轮巡检
    await world.tick();
    assert.equal(world.st.phase, 'traveling', `接了约还留在城里：${world.st.phase}`);
    assert.equal(world.st.leg?.toId, 'shanghai', `目的地不是碰头那座城：${world.st.leg?.toId}`);
  } finally { restore(); }
});

test('晚上十点半接的约：今天不动，留给明早 —— 不许半夜买票走人', async () => {
  /*
   * `depart` 有 7–21 点的窗口，`moveOn` 没有。重开决策时如果不挡这一手，
   * 22:30 接一条约，下一轮巡检就直接买票出发了 —— 用户看到的是一条半夜的「我上路了」。
   */
  const { world, one, restore } = await bootTakeToday('2026-11-05T14:30:00Z');   // 西安 22:30
  try {
    await world.tick();
    world.st = { ...world.st, decidedOn: '2026-11-05' };
    const r = await world.takeInvite(one.id);
    assert.equal(r.isError, undefined, `该接成：${r.text}`);
    assert.equal(world.st.decidedOn, '2026-11-05', '晚上十点半把今天的决策额度还回去了 —— 下一拍就会半夜出发');
    assert.equal(world.st.phase, 'staying');
    assert.match(r.text, /今天这一趟不安排动身/, `回执该说实话：${r.text}`);
  } finally { restore(); }
});

test('她睡着的时候接的约：不叫醒她，等醒了再走', async () => {
  const { world, one, restore } = await bootTakeToday(NOW, {}, {
    asleepUntil: '2026-11-05T06:00:00Z',   // 当地 14:00 才醒
  });
  try {
    await world.tick();
    world.st = { ...world.st, decidedOn: '2026-11-05' };
    await world.takeInvite(one.id);
    assert.equal(world.st.decidedOn, '2026-11-05', '睡着时把决策额度还回去了 —— 下一拍她会爬起来赶车');
  } finally { restore(); }
});

test('别人接了她发的那条：认领之后同样当天就走，不拖到明早', async () => {
  /*
   * 另一条入口。她发了「有没有人一起去苏州」，别人接了 —— 服务端把这条推回来，
   * `claimTakenInvite` 认领并写 pledge。这条和 `takeInvite`（她主动接别人的）
   * 是同一件事的两头，缺口也一样：认领发生在早上八点之后，就不会再走。
   */
  const { world, clock, one, restore } = await bootTakeToday(NOW);
  try {
    await world.tick();
    assert.equal(world.st.decidedOn, '2026-11-05', '前提：今天的决策额度已经用掉');

    /* 这一刻起，服务端说「那条被人接了」。 */
    globalThis.fetch = inviteReadyServer(one, clock, [one]);
    await world.claimTakenInvite(world.meetOptions(), clock.now);
    assert.equal(world.st.pledge?.inviteId, one.id, '没认领到');
    assert.equal(world.st.decidedOn, null, '认领完没有重开今天的决策');

    clock.now = new Date(clock.now.getTime() + 60_000);
    await world.tick();
    assert.equal(world.st.phase, 'traveling', `认领了还留在城里：${world.st.phase}`);
  } finally { restore(); }
});

test('他点了「好」但那条已经没了：必须说一句，不许静默', async () => {
  /*
   * 第三种「说了约好了却没动」的成因：卡片上他点了「好」，`answerAsk` 回身去接，
   * 可服务端那边那条已经过期 / 被人接满。原来这行的返回值直接丢掉 ——
   * 卡片消失、行程不动，而她上一句还停在「谢谢你点头，这就动身」。
   *
   * 判据：**任何「他点了按钮」的动作，失败都得回一句话。**
   */
  const { world, events, one, restore } = await bootTakeToday(NOW);
  try {
    await world.tick();
    /* 从这一刻起，列表是空的 —— 那条在服务端已经没了。 */
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, list: [] }) });
    world.st = {
      ...world.st,
      ask: {
        kind: 'accept', cityId: one.to, days: one.days, inviteId: one.id,
        withPet: one.pet, note: null, askedAt: NOW,
      },
    };
    await world.answerAsk(true);
    assert.equal(world.st.pledge, null, '没接上却留下了约定');
    assert.ok(
      JSON.stringify(events).includes('没接上'),
      `他点了「好」、什么都没发生，而且一句话都没推：${JSON.stringify(events).slice(0, 400)}`,
    );
  } finally { restore(); }
});

test('他点「好」的那一秒就该动身 —— 不许等他再刷 60 秒', async () => {
  /*
   * `takeInvite` 只把今天的决策重开，真正动身在下一轮巡检（60 秒）。
   * 他点完「好」立刻看面板，行程还是原样 —— 会以为按钮没起作用，
   * 而那 60 秒里她可能已经说了「我这就走」。`answerAsk` 里补抓一拍。
   */
  const { world, one, restore } = await bootTakeToday(NOW);
  try {
    await world.tick();
    assert.equal(world.st.decidedOn, '2026-11-05', '前提：今天的决策额度已经用掉');
    world.st = {
      ...world.st,
      ask: {
        kind: 'accept', cityId: one.to, days: one.days, inviteId: one.id,
        withPet: one.pet, note: null, askedAt: NOW,
      },
    };
    await world.answerAsk(true);
    assert.equal(world.st.phase, 'traveling', `点了「好」还留在城里：${world.st.phase}`);
    assert.equal(world.st.leg?.toId, 'shanghai', `目的地不对：${world.st.leg?.toId}`);
  } finally { restore(); }
});

test('换城后未刷新探针前，面板不许吐上一座城的 here / nearby 脏数', async () => {
  const srv = { here: 9, list: [{ pet: '鲸鲸', doing: '逛早市' }], hits: 0, down: false };
  const { world, restore } = await bootProbe({ srv });
  try {
    await world.tick();
    assert.equal(world.uiSnapshot().social.here, 8);
    assert.equal(world.uiSnapshot().social.nearby, 1);

    /* 模拟刚切到新城市且在路上（plan 为 null），探针还没来得及重新拉。 */
    world.plan = null;
    world.st = { ...world.st, phase: 'traveling', hereId: 'chongqing' };
    const snap = world.uiSnapshot().social;
    assert.equal(snap.here, 0, `换城后漏了旧城 here：${snap.here}`);
    assert.equal(snap.nearby, 0, `换城后漏了旧城 nearby：${snap.nearby}`);
  } finally { restore(); }
});

test('已经在会合城接约：回执不再自相矛盾地说「这就赶车」', async () => {
  const { world, one, restore } = await bootTakeToday(NOW, { hereId: 'shanghai' });
  try {
    await world.tick();
    const r = await world.takeInvite(one.id);
    assert.equal(r.isError, undefined, `该接成：${r.text}`);
    assert.match(r.text, /就在上海.*等人/);
    assert.doesNotMatch(r.text, /这会儿就该动身/, `已在会合城等人却说这就赶车：${r.text}`);
  } finally { restore(); }
});
