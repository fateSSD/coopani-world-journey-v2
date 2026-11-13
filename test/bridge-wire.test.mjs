/**
 * 车费桥的接线测试（2026-11-10）。
 *
 * `bridge.test.mjs` 验的是纯函数算得对不对；这一份验的是**它有没有真的被接上**：
 * `settleRides` 是加完钱有没有落盘、`persist` 有没有顺手写公开快照、
 * 日记段落有没有真的进文件。
 *
 * 单独一份而不是塞进 bridge.test.mjs：那边一个 World 都不起（毫秒级），
 * 这边要造临时目录、写盘、读回来（几十毫秒）。混在一起，慢的那部分会拖累快的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

const NOW = new Date('2026-11-09T13:00:00.000Z');
const AT = '2026-11-09T12:30:00.000Z';

function fakeHost() {
  const events = [];
  return {
    events,
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => { const env = { ...e, blobs: [] }; events.push(env); return env; },
    pushDeferred: () => {},
    store: {},
    drainPendingEvents: async () => [],
  };
}

/** 造一个在洛阳停留、账上有 1000 块的状态，启动 World，再把启动期的事件清掉。 */
function boot({ cfg = {}, state = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-bridge-'));
  new StateStore(dir).save({
    ...initialState('lanzhou'),
    phase: 'staying',
    hereId: 'luoyang',
    tripStartedAt: '2026-11-01T00:00:00.000Z',
    stayStartedAt: '2026-11-08T09:00:00.000Z',
    spent: 1000,
    ...state,
  });
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', ...cfg },
    dataDir: dir,
    botName: '测试',
    now: () => NOW,
  });
  const host = fakeHost();
  /*
   * 必须 `start()`：构造函数只建商店，状态是在 `start()` 里从盘上读的。
   * 只 new 不 start，`st` 是初始状态（钱 0、在家），后面的断言全对不上 ——
   * 这一条踩过一次，报错长得像「结算没生效」。
   */
  w.start(host);
  host.events.length = 0;
  return { dir, w, host };
}

const writePending = (dir, rec) => {
  mkdirSync(join(dir, 'ride-pending'), { recursive: true });
  writeFileSync(join(dir, 'ride-pending', `${rec.id}.json`), JSON.stringify(rec));
};

const ride = (over = {}) => ({
  schema: 1, id: 'ride-w1', at: AT, cityId: 'luoyang',
  fare: 54, kind: 'normal', note: '从住处到龙门石窟，9.7 公里。', ...over,
});

test('结算真的落进 state，并且顺手写出公开快照', () => {
  const { dir, w } = boot({ cfg: { moneyEnabled: true, budget: 6000 } });
  writePending(dir, ride());

  w.settleRides();

  assert.equal(w.st.spent, 1054);
  assert.equal(w.st.rideApplied.length, 1);
  assert.equal(w.st.rideApplied[0].dateKey, '2026-11-09');

  const pub = JSON.parse(readFileSync(join(dir, 'journey-public.json'), 'utf8'));
  assert.equal(pub.money.spent, 1054);
  assert.equal(pub.money.remaining, 6000 - 1054);
  assert.equal(pub.rides.supported, true);
  assert.equal(pub.rides.spendEnabled, true);
  assert.deepEqual(pub.rides.settled, [{ id: 'ride-w1', status: 'applied' }]);
  assert.equal(pub.city.id, 'luoyang');
  // 事实字段在，现值字段不该有。
  assert.equal(pub.clock.worldNow, NOW.toISOString());
  assert.equal('progress' in (pub.leg ?? {}), false);
});

test('再跑一遍不重复扣（同一条 pending 还在目录里）', () => {
  const { dir, w } = boot({ cfg: { moneyEnabled: true, budget: 6000 } });
  writePending(dir, ride());

  w.settleRides();
  w.settleRides();

  assert.equal(w.st.spent, 1054);
  assert.equal(w.st.rideApplied.length, 1);
});

test('非法记录：不记钱，但留下痕迹，且下一轮不再重复报警', () => {
  const { dir, w, host } = boot({ cfg: { moneyEnabled: true, budget: 6000 } });
  writePending(dir, ride({ id: 'ride-bad', fare: 90000 }));

  w.settleRides();
  assert.equal(w.st.spent, 1000);
  assert.equal(w.st.rideApplied[0].status, 'rejected');
  assert.equal(host.events.length, 1, '拒收要让她知道，不能静默');

  w.settleRides();
  assert.equal(host.events.length, 1, '判重表里有它了，不该每个 tick 再喊一次');
});

test('记账关着：照结算、不动 spent，公开快照里 spendEnabled 为 false', () => {
  const { dir, w } = boot({ cfg: { moneyEnabled: false } });
  writePending(dir, ride());

  w.settleRides();

  assert.equal(w.st.spent, 1000);
  const pub = JSON.parse(readFileSync(join(dir, 'journey-public.json'), 'utf8'));
  assert.equal(pub.rides.supported, true);
  assert.equal(pub.rides.spendEnabled, false);
  assert.equal(pub.money.remaining, null, '不限就是 null，不是 0');
});

test('日记：段落进文件，重写同一天不重复', () => {
  const { dir, w } = boot({ cfg: { moneyEnabled: true, budget: 6000, bridgeDiary: true } });
  writePending(dir, ride());
  w.settleRides();

  w.writeDiary('今天在龙门石窟站了很久。');
  const first = readFileSync(join(dir, 'diary', '2026-11.md'), 'utf8');
  assert.equal(first.includes('叫了 1 次车'), true);
  assert.equal(first.includes('龙门石窟'), true);

  w.writeDiary('今天在龙门石窟站了很久，石头上还留着刀痕。');
  const again = readFileSync(join(dir, 'diary', '2026-11.md'), 'utf8');
  assert.equal(again.split('叫了 1 次车').length - 1, 1, '重写一次不能变成两段');
  assert.equal(again.includes('石头上还留着刀痕'), true, '正文该更新');
});

test('日记：开关关掉就不写那一段', () => {
  const { dir, w } = boot({ cfg: { moneyEnabled: true, budget: 6000, bridgeDiary: false } });
  writePending(dir, ride());
  w.settleRides();

  w.writeDiary('今天哪儿也没去。');
  const text = readFileSync(join(dir, 'diary', '2026-11.md'), 'utf8');
  assert.equal(text.includes('叫了 1 次车'), false);
});

test('首页卡：有就画，过期就没有', () => {
  const { dir, w } = boot({ cfg: { bridgeLive: true } });
  const live = (expiresAt) => ({
    schema: 1, active: true, id: 'ride-live', status: 'assigned',
    car: '比亚迪秦 PLUS', plate: '豫C·D20387', from: '住处', to: '龙门石窟',
    cityName: '洛阳', fare: 54, progress: 20, secondsToPickup: 180, secondsToDropoff: 300, expiresAt,
  });

  writeFileSync(join(dir, 'ride-live.json'), JSON.stringify(live('2026-11-09T13:04:00.000Z')));
  const snap = w.uiSnapshot();
  assert.equal(snap.ride?.to, '龙门石窟');
  assert.equal(snap.ride?.plate, '豫C·D20387');

  // 缓存 1 秒：换个过期时间要等缓存过去，这里直接把缓存清掉模拟下一秒。
  w.liveCache = { at: 0, value: null };
  writeFileSync(join(dir, 'ride-live.json'), JSON.stringify(live('2026-11-09T12:59:00.000Z')));
  assert.equal(w.uiSnapshot().ride, null, '过期必须自己消失，不等对方写 active:false');
});

test('首页卡：对方正写到一半（坏 JSON）不能让面板报错', () => {
  const { dir, w } = boot({ cfg: { bridgeLive: true } });
  writeFileSync(join(dir, 'ride-live.json'), '{"schema":1,"active":tr');
  assert.equal(w.uiSnapshot().ride, null);
});

test('没有 ride-pending 目录时，一切都是原样', () => {
  const { dir, w } = boot({ cfg: { moneyEnabled: true, budget: 6000 } });
  assert.equal(existsSync(join(dir, 'ride-pending')), false);
  w.settleRides();
  assert.equal(w.st.spent, 1000);
  assert.equal(w.taxiYields(), false, '没装打车扩展时，排程照旧自己叫车');
});

test('对方目录在，就让出城里的出租车', () => {
  const { dir, w } = boot({ cfg: { moneyEnabled: true, bridgeSpend: true } });
  mkdirSync(join(dir, 'ride-pending'), { recursive: true });
  assert.equal(w.taxiYields(), true);

  const off = boot({ cfg: { moneyEnabled: true, bridgeSpend: false } });
  mkdirSync(join(off.dir, 'ride-pending'), { recursive: true });
  assert.equal(off.w.taxiYields(), false, '手动关掉就该自己叫');
});
