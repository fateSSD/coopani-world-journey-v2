/**
 * 整趟撑不住就别接约（2026-11-21，Mr.Q）
 *
 * 原话：「钱不够最好让她不要接邀约比较好（花销开关打开的情况下）」。
 *
 * `takeInvite` 早就判了**票**买不买得起（`affordMode`：最多花余钱一半），
 * 但一趟约不是一张票 —— 她还得在那儿住几天、吃几天。这条补的是「整趟」：
 *
 *     需要 = 票（每段最便宜那张） + （最便宜的一张床 + 一天饭钱）× 天数
 *
 * 这一组守三件事：
 *   1. 算式对（数字能自己算出来，不靠印象）
 *   2. 记账关着时**一个字都不管**（老行为不能被动）
 *   3. 真接到一条邀约时，钱不够就拒绝，而且回执把四笔数摆出来
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
const { cheapestBed } = await import('../src/plan/lodging.ts');

function makeWorld(dir, cfg = {}) {
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', ...cfg },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-21T05:00:00Z'),
  });
  return world;
}

/* ---------------- 算式 ---------------- */

test('最便宜的一张床：不掷骰子，两次同样；国内有地板价', () => {
  /*
   * 判据要能重放。`rollLodging` 是随机的 —— 拿它算「接不接得上一条约」，
   * 同一天同样的钱会时而成立时而不成立，那不像判断，像抽卡。
   */
  const a = cheapestBed(1, false);
  const b = cheapestBed(1, false);
  assert.equal(a, b, '两次算出来不一样 —— 用到随机数了');
  assert.ok(a >= 85, `国内最低价该被小破店地板托住（85），实际 ${a}`);

  /* 贵城市（兰州 1.0 vs 纽约 11.1）要有差距，不然「在哪儿」这层白传。 */
  const ny = cheapestBed(11.1, true);
  assert.ok(ny > a, `纽约的一晚不该比国内还便宜：${ny} vs ${a}`);
});

test('整趟估价：记账关着时一律放行，left 是 null 不是 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-pledge-purse-'));
  const w = makeWorld(dir, { moneyEnabled: false });
  const trip = w.pledgeAffordable([{ km: 500 }], 3, cityById('chengdu'));
  assert.equal(trip.ok, true, '没记账还拦人');
  assert.equal(trip.left, null, '「没有钱这个概念」不能写成 0');
  assert.ok(trip.need > 0, '算式没算出来');
});

test('整趟估价：票 + 天数 ×（床 + 饭），三档钱各判一次', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-pledge-purse2-'));
  const chengdu = cityById('chengdu');
  const legs = [{ km: 200 }];

  /* 先把「需要多少」量出来，再按它上下各设一档预算 —— 判据不靠拍数字。 */
  const probe = makeWorld(dir, { moneyEnabled: true, budget: 10_000 });
  const need = probe.pledgeAffordable(legs, 2, chengdu);
  assert.equal(need.fare, probe.cheapestFare(200, false), '票钱和 cheapestFare 对不上');
  assert.equal(need.need, need.fare + (need.bed + need.meals) * 2, '算式和注释里写的不一样');
  assert.equal(need.ok, true);

  /* 差一百块：拦住，并把四笔数都带回来。 */
  const poor = makeWorld(dir, { moneyEnabled: true, budget: need.need - 100 });
  const t1 = poor.pledgeAffordable(legs, 2, chengdu);
  assert.equal(t1.ok, false, '钱差 100 也放行了');
  assert.equal(t1.left, need.need - 100);
  assert.ok(t1.need > t1.left);

  /* 刚好够：放行（判据是「撑得住」，不是「宽裕」）。 */
  const exact = makeWorld(dir, { moneyEnabled: true, budget: need.need });
  assert.equal(exact.pledgeAffordable(legs, 2, chengdu).ok, true, '刚好够却被拦');

  /* 两段路（先去会合点再去目的地）票钱要相加，只算一段会低估。 */
  const two = probe.pledgeAffordable([{ km: 200 }, { km: 900, crossBorder: false }], 2, chengdu);
  assert.ok(two.fare > need.fare, '两段路的票钱没加起来');
});

/* ---------------- 真的接一条邀约 ---------------- */

/* id 必须 16 位十六进制 —— `toInvite()` 不合法就整条丢掉（看见了但接不了的东西不该进列表）。 */
const INVITE_ID = 'a1b2c3d4e5f60718';
const INVITE = {
  id: INVITE_ID, pet: '小满', to: 'chengdu', days: 3, note: '', meet: 'chengdu', pace: 1,
};

function boot(budget) {
  const dataDir = mkdtempSync(join(tmpdir(), 'jr-pledge-take-'));
  new StateStore(dataDir).save({
    ...initialState('lanzhou'),
    phase: 'staying',
    hereId: 'xian',
    tripStartedAt: '2026-11-20T00:00:00Z',
    stayStartedAt: '2026-11-21T01:00:00Z',
    stayDateKey: '2026-11-21',
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    /*
     * 三条路要分开回，混着回会被当成「接成功了但内容不全」：
     *   GET  /invite   看列表
     *   POST /accept   真的接（要回 with / to / days）
     */
    if (u.includes('/accept')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, with: INVITE.pet, to: INVITE.to, days: INVITE.days, meet: INVITE.meet, pace: INVITE.pace }) };
    }
    if (u.includes('/invite') && (!init || init.method !== 'POST')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, list: [INVITE] }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, list: [], pool: 0 }) };
  };
  const events = [];
  const world = new JourneyWorld({
    cfg: {
      ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', meetUrl: 'https://x.test',
      moneyEnabled: budget !== null, budget: budget ?? 0,
    },
    dataDir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-21T05:00:00Z'),
  });
  world.start({
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => { events.push(e); return { ...e, blobs: [] }; },
    pushDeferred() {}, store: {}, drainPendingEvents: async () => [],
  });
  return { world, events, restore: () => { globalThis.fetch = origFetch; } };
}

test('接约：钱不够就拒绝，回执把票/床/饭/余额四笔数摆出来', async () => {
  const { world, restore } = boot(120);
  try {
    const r = await world.takeInvite(INVITE_ID, true);
    assert.equal(r.isError, true, `钱只有 120 还接了：${r.text}`);
    assert.match(r.text, /撑不住/, `没说清是哪一种不够：${r.text}`);
    assert.match(r.text, /票 \d+/, '没报票钱');
    assert.match(r.text, /一张床最低 \d+/, '没报床钱');
    assert.match(r.text, /一天饭钱 \d+/, '没报饭钱');
    assert.match(r.text, /只有 120/, '没报她手上还有多少');
    /* 没收下就别写 pledge —— 写了就等于「答应了却去不成」。 */
    assert.equal(world.st.pledge ?? null, null, '拒绝了还留着约定');
  } finally { restore(); }
});

test('接约：钱够就照常接，不因为新判据被挡住', async () => {
  const { world, restore } = boot(50_000);
  try {
    const r = await world.takeInvite(INVITE_ID, true);
    assert.notEqual(r.isError, true, `钱够却拒了：${r.text}`);
    assert.ok(world.st.pledge, '接成了却没写约定');
    assert.equal(world.st.pledge.cityId, 'chengdu');
  } finally { restore(); }
});
