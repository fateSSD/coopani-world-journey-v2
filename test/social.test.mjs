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
import { mkdtempSync } from 'node:fs';
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
