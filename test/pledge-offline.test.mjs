/**
 * 2026-11-23 约定跨大段停机离线 & 在途到站时序保护回归测试：
 * 1. 正在路上前往约定城且离线/开机时其实早已到站：先 arrive 再核对约定，不误杀；
 * 2. 仍在前往约定城的途中超 3 天不在半路掐断；走错城照常作废；
 * 3. 单次真实停机超过 12 小时（如公司电脑过周末 64 小时），从赶路 / 等伴期限里扣除，且跨过早 8 点也不锁死发车；
 * 4. 不足 12 小时的常规短离线（如 10 小时）不扣除，满 3 天仍按原窗作废。
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
    pushDeferred() {},
    store: {},
    drainPendingEvents: async () => [],
  };
}

async function boot(trip, nowISO, cfg = {}, existingDir = null) {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), 'jr-pledge-off-'));
  if (!existingDir) {
    new StateStore(dir).save({ ...initialState('lanzhou'), ...trip });
  }
  const events = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', ...cfg },
    dataDir: dir,
    botName: '克罗艾的小银鱼',
    now: () => new Date(nowISO),
  });
  await world.start(fakeHost(events));
  const restore = () => { globalThis.fetch = origFetch; world.stop?.(); };
  return { world, events, dir, restore };
}

test('已在前往上海的车上且应已到站：开机第一拍先落站，不被 prunePledge 误杀', async () => {
  // 周五 08:00 接约去上海碰头再去苏州；周五 10:00 上车预计周六 00:00 到站；
  // 期间关机仅 10 小时（<12h，不走离线扣除，专门验证 tick 内 travelTick 必须在 prunePledge 之前），周一 10:00 开机。
  const { world, events, restore } = await boot({
    phase: 'traveling',
    hereId: 'hangzhou',
    tripStartedAt: '2026-11-18T00:00:00Z',
    lastSeenAt: '2026-11-23T00:00:00Z',
    leg: {
      id: 'leg-shanghai',
      fromId: 'hangzhou',
      toId: 'shanghai',
      modeId: 'train',
      km: 175,
      durationWorldHours: 14,
      departedAt: '2026-11-20T02:00:00Z',
      arriveAt: '2026-11-20T16:00:00Z',
      speed: 1,
      seat: '二等座',
      seatMult: 1,
      viaIds: [],
      createdAt: '2026-11-20T02:00:00Z',
    },
    pledge: {
      cityId: 'suzhou',
      meetCityId: 'shanghai',
      meetArrivedAt: null,
      days: 2,
      withPet: '鲸鲸',
      withPets: ['鲸鲸'],
      inviteId: '1234567890abcdef',
      acceptedAt: '2026-11-20T00:00:00Z',
      arrivedAt: null,
    },
  }, '2026-11-23T10:00:00Z');
  try {
    await world.tick();
    assert.equal(world.st.phase, 'staying', '到站后应进入停留');
    assert.equal(world.st.hereId, 'shanghai', '人应已落地上海');
    assert.ok(world.st.pledge, '先到站再结算，不应被判成没赶上而清除');
    assert.ok(world.st.pledge?.meetArrivedAt, '到达上海后应写入 meetArrivedAt');
    assert.equal(
      events.some((e) => e.type === 'journey.invite' && /没赶上/.test(String(e.text))),
      false,
      '不能推送「没赶上」事件',
    );
  } finally { restore(); }
});

test('仍在前往约定城的车上超过三天不半路掐断；走错城市仍当场作废', async () => {
  const { world: rightWay, restore: restoreRight } = await boot({
    phase: 'traveling',
    hereId: 'xian',
    tripStartedAt: '2026-11-18T00:00:00Z',
    leg: {
      id: 'leg-on-road',
      fromId: 'xian',
      toId: 'shanghai',
      modeId: 'train',
      km: 1380,
      durationWorldHours: 80,
      departedAt: '2026-11-20T00:00:00Z',
      arriveAt: '2026-11-23T08:00:00Z',
      speed: 1,
      seat: '硬卧',
      seatMult: 1,
      viaIds: [],
      createdAt: '2026-11-20T00:00:00Z',
    },
    pledge: {
      cityId: 'suzhou',
      meetCityId: 'shanghai',
      meetArrivedAt: null,
      days: 2,
      withPet: '鲸鲸',
      inviteId: 'abcdef0123456789',
      acceptedAt: '2026-11-19T12:00:00Z',
      arrivedAt: null,
    },
  }, '2026-11-23T02:00:00Z');
  try {
    await rightWay.tick();
    assert.ok(rightWay.st.pledge, '还在开往约定城的车上，不应半路作废');
  } finally { restoreRight(); }

  const { world: wrongWay, events, restore: restoreWrong } = await boot({
    phase: 'traveling',
    hereId: 'xian',
    tripStartedAt: '2026-11-18T00:00:00Z',
    leg: {
      id: 'leg-wrong',
      fromId: 'xian',
      toId: 'chengdu',
      modeId: 'train',
      km: 720,
      durationWorldHours: 8,
      departedAt: '2026-11-20T00:00:00Z',
      arriveAt: '2026-11-20T08:00:00Z',
      speed: 1,
      seat: '二等座',
      seatMult: 1,
      viaIds: [],
      createdAt: '2026-11-20T00:00:00Z',
    },
    pledge: {
      cityId: 'suzhou',
      meetCityId: 'shanghai',
      meetArrivedAt: null,
      days: 2,
      withPet: '鲸鲸',
      inviteId: 'abcdef0123456789',
      acceptedAt: '2026-11-20T00:00:00Z',
      arrivedAt: null,
    },
  }, '2026-11-20T04:00:00Z');
  try {
    await wrongWay.tick();
    assert.equal(wrongWay.st.pledge, null, '坐车去错城市应该作废');
    assert.ok(events.some((e) => /没赶上|算了/.test(String(e.text))));
  } finally { restoreWrong(); }
});

test('停机超过 12 小时（周末关机 63 小时）：扣除离线时间保住约定，且周一跨过 8 点仍立刻动身', async () => {
  // 周五 17:00（UTC 09:00）在杭州接约还没动身，18:00（UTC 10:00）关机，周一 09:00（UTC 01:00）开机。
  // 已过总时长 = 64h（含周六周日跨早 8 点），且如果再加前面等待超过 72h 也应因扣除 63h 而保住。
  const { world, dir, restore } = await boot({
    phase: 'staying',
    hereId: 'hangzhou',
    tripStartedAt: '2026-11-18T00:00:00Z',
    stayStartedAt: '2026-11-19T00:00:00Z',
    stayDateKey: '2026-11-20',
    decidedOn: '2026-11-20',
    lastSeenAt: '2026-11-20T10:00:00Z',
    pledge: {
      cityId: 'suzhou',
      meetCityId: 'shanghai',
      meetArrivedAt: null,
      days: 2,
      withPet: '鲸鲸',
      inviteId: 'abcdef0123456789',
      acceptedAt: '2026-11-19T23:00:00Z', // 接约后到周一开机合计已过 74h > 72h
      arrivedAt: null,
    },
  }, '2026-11-23T01:00:00Z'); // 北京时间周一 09:00
  try {
    await world.tick(); // 第一拍：跨天，扣除离线并清出 decidedOn
    assert.ok(world.st.pledge, '扣除 63h 周末停机后，净耗时仅 11h <= 72h，约定应保住');
    assert.equal(world.st.pledge?.pausedTravelMs, 63 * 3_600_000, '应精确累入 63h 离线扣减');
    assert.equal(world.st.decidedOn, null, '有约在身即使离线跨早 8 点也不把 decidedOn 锁死到今天');
    await world.tick(); // 第二拍：进入当日发车决策，即刻买票去上海
    assert.equal(world.st.phase, 'traveling', '周一开机应即刻出发，不拖到周二');
    assert.equal(world.st.leg?.toId, 'shanghai', '出发方向应指向见面城上海');
  } finally { restore(); }

  // 验证重启加载 state.json 后 pausedTravelMs 持久化不丢
  const reopened = await boot({}, '2026-11-23T01:05:00Z', {}, dir);
  try {
    assert.equal(reopened.world.st.pledge?.pausedTravelMs, 63 * 3_600_000);
  } finally { reopened.restore(); }
});

test('见面城等伴期间大段离线(>12h)同样扣除且计入已等天数；不足 12h 的短离线不扣', async () => {
  // 1) 在上海等伴：11-20 00:00 到达，11-20 10:00 关机，11-23 04:00 开机（停机 66h > 12h，总经过 76h > 72h）
  const { world: waited, restore: restoreWaited } = await boot({
    phase: 'staying',
    hereId: 'shanghai',
    tripStartedAt: '2026-11-18T00:00:00Z',
    stayStartedAt: '2026-11-20T00:00:00Z',
    stayDateKey: '2026-11-20',
    lastSeenAt: '2026-11-20T10:00:00Z',
    pledge: {
      cityId: 'suzhou',
      meetCityId: 'shanghai',
      meetArrivedAt: '2026-11-20T00:00:00Z',
      days: 2,
      withPet: '鲸鲸',
      inviteId: 'abcdef0123456789',
      acceptedAt: '2026-11-19T12:00:00Z',
      arrivedAt: null,
    },
  }, '2026-11-23T04:00:00Z');
  try {
    await waited.tick();
    assert.ok(waited.st.pledge, '见面城等伴扣除 66h 停机后净等 10h，不应散伙');
    assert.equal(waited.st.pledge?.pausedWaitMs, 66 * 3_600_000);
    const summary = waited.nowSummary();
    assert.doesNotMatch(summary, /等了 3 天/, `扣除离线后不应显示已等 3 天：\n${summary}`);
  } finally { restoreWaited(); }

  // 2) 短离线 10h（<= 12h）：接约已过 74h，不应扣除，正常作废
  const { world: shortOff, events, restore: restoreShort } = await boot({
    phase: 'staying',
    hereId: 'hangzhou',
    tripStartedAt: '2026-11-18T00:00:00Z',
    stayStartedAt: '2026-11-19T00:00:00Z',
    stayDateKey: '2026-11-23',
    lastSeenAt: '2026-11-22T16:00:00Z', // 距 2026-11-23T02:00:00Z 仅 10h <= 12h
    pledge: {
      cityId: 'suzhou',
      meetCityId: 'shanghai',
      meetArrivedAt: null,
      days: 2,
      withPet: '鲸鲸',
      inviteId: 'abcdef0123456789',
      acceptedAt: '2026-11-20T00:00:00Z', // 已过 74h
      arrivedAt: null,
    },
  }, '2026-11-23T02:00:00Z');
  try {
    await shortOff.tick();
    assert.equal(shortOff.st.pledge, null, '短于 12h 的离线不应扣除，满 3 天仍作废');
    assert.ok(events.some((e) => e.type === 'journey.invite' && /没赶上/.test(String(e.text))));
  } finally { restoreShort(); }
});

test('24x 高倍速下真实停机 10 小时（世界 240h）：按世界时间门限扣除并保住约定', async () => {
  const realBoot = '2026-11-23T02:00:00Z';
  const lastSeenReal = '2026-11-22T16:00:00Z'; // 真实停机 10h (<12h 真实，但 = 240h 世界)
  const worldEpoch = '2026-11-20T00:00:00Z';
  const realEpoch = '2026-11-22T12:00:00Z';
  // realBoot - realEpoch = 14h → worldNow = 2026-11-20T00:00Z + 14 * 24h = 2026-12-04T00:00Z
  // lastSeen - realEpoch = 4h → worldAtSeen = 2026-11-24T00:00Z (距 worldNow 正好 240h)
  // acceptedAt 在 worldAtSeen 前 4 世界小时 = 2026-11-23T20:00Z (总经过 244h > 72h)
  const { world, events, restore } = await boot({
    phase: 'staying',
    hereId: 'hangzhou',
    tripStartedAt: '2026-11-18T00:00:00Z',
    stayStartedAt: '2026-11-19T00:00:00Z',
    stayDateKey: '2026-11-23',
    lastSeenAt: lastSeenReal,
    clock: { realEpoch, worldEpoch, speed: 24 },
    pledge: {
      cityId: 'suzhou',
      meetCityId: 'shanghai',
      meetArrivedAt: null,
      days: 2,
      withPet: '鲸鲸',
      inviteId: 'abcdef0123456789',
      acceptedAt: '2026-11-23T20:00:00Z',
      arrivedAt: null,
    },
  }, realBoot, { speed: 24 });
  try {
    await world.tick();
    assert.ok(world.st.pledge, '24x 下真实停机 10h（世界 240h）必须扣除离线时间保住约定');
    assert.equal(world.st.pledge?.pausedTravelMs, 240 * 3_600_000, '应扣除 240 世界小时');
    assert.equal(
      events.some((e) => e.type === 'journey.invite' && /没赶上/.test(String(e.text))),
      false,
      '不能推送「没赶上」事件',
    );
  } finally { restore(); }
});

test('等伴天数（mateLine 与 pledgeText 口径一致）+ 夜里 22:30 开机不半夜买票', async () => {
  // 1) 周末 11-20 10:00 关机 66h，11-23 04:00Z（当地 12:00）跨天开机，扣完净等 0 天
  const { world, events, restore } = await boot({
    phase: 'staying',
    hereId: 'shanghai',
    tripStartedAt: '2026-11-18T00:00:00Z',
    stayStartedAt: '2026-11-20T00:00:00Z',
    stayDateKey: '2026-11-20',
    lastSeenAt: '2026-11-20T10:00:00Z',
    pledge: {
      cityId: 'suzhou',
      meetCityId: 'shanghai',
      meetArrivedAt: '2026-11-20T00:00:00Z',
      days: 2,
      withPet: '鲸鲸',
      inviteId: 'abcdef0123456789',
      acceptedAt: '2026-11-19T12:00:00Z',
      arrivedAt: null,
    },
  }, '2026-11-23T04:00:00Z');
  try {
    await world.tick();
    const dayEv = events.find((e) => e.type === 'journey.day');
    assert.ok(dayEv, '跨天应推送 journey.day');
    assert.doesNotMatch(String(dayEv.text), /已经等了 3 天/, `mateLine 未扣除离线等待时长：\n${dayEv.text}`);
  } finally { restore(); }

  // 2) 夜里 22:30（UTC 14:30）跨天开机且背着赴约，不被锁死也不在半夜发车
  const { world: nightW, restore: restoreNight } = await boot({
    phase: 'staying',
    hereId: 'hangzhou',
    tripStartedAt: '2026-11-18T00:00:00Z',
    stayStartedAt: '2026-11-19T00:00:00Z',
    stayDateKey: '2026-11-20',
    lastSeenAt: '2026-11-20T10:00:00Z',
    pledge: {
      cityId: 'suzhou',
      meetCityId: 'shanghai',
      meetArrivedAt: null,
      days: 2,
      withPet: '鲸鲸',
      inviteId: 'abcdef0123456789',
      acceptedAt: '2026-11-20T08:00:00Z',
      arrivedAt: null,
    },
  }, '2026-11-23T14:30:00Z'); // 北京时间 22:30
  try {
    await nightW.tick();
    await nightW.tick();
    assert.equal(nightW.st.phase, 'staying', '当地 22:30 夜里不该自动买票出发');
    assert.equal(nightW.st.decidedOn, null, '夜间跳过发车也不占明日决策额度');
  } finally { restoreNight(); }
});

