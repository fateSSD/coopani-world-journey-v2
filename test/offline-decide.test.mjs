/**
 * 「关机一夜，开机就被拉走」（2026-11-15，用户来信）
 *
 * 反馈原样：
 *   她在大连第 3 天，当天日程还排着「12:30 午饭 / 下午金石滩 / 晚饭地三鲜」。
 *   12:17 她刚查完 journey_now，12:18 说「大连才第三天，我还没待够」，
 *   同一分钟内后台就发车去了秦皇岛。
 *
 * `core.log` 里前面那句是「他离开了 13 小时」—— 应用停了一夜，世界时间照走
 * （`worldNow()` 不冻结），`stayDaysSoFar` 直接跨过门槛，开机第一拍就掷骰子、
 * 掷中就 `moveOn()` 推 `journey.depart`，而她的那一句话还在生成。
 *
 * 这里钉三件事：
 *   ① 离线跨过当地 8 点 → 这一拍**不补判**，人留在原地，decidedOn 记成今天；
 *   ② 决策点没被跨过（离线很短 / 当天已经判过）→ **照常判**，该走就走；
 *   ③ 判据本身（`decisionCrossedWhileAway`）的四个边界。
 *
 * 第 ② 条不是凑数：一刀切「离线就不许走」会把她钉死在原地，
 * 而且用户会在「我关了十分钟电脑，她怎么就不走了」上再提一次反馈。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld, decisionCrossedWhileAway } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

const NOW = '2026-11-05T02:00:00Z'; // 北京时间 10:00 —— 当地决定点（8 点）已经过了

async function boot(trip) {
  const dir = mkdtempSync(join(tmpdir(), 'offline-decide-'));
  new StateStore(dir).save({ ...initialState('lanzhou'), ...trip });
  const events = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  /*
   * 把骰子按住。这一组测的是「判不判」，不是「掷出什么」：
   * 0.99 让 `GO_HOME_CHANCE`（20% 回家）和 `STAY_ONE_MORE`（15% 再留一天）都不触发，
   * 于是「发车」变成确定性动作，断言才有意义。
   */
  const origRandom = Math.random;
  Math.random = () => 0.99;
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', speed: 1 },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(NOW),
  });
  await world.start({
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => { events.push(e); return { ...e, blobs: [] }; },
    pushDeferred() {},
    store: {},
    drainPendingEvents: async () => [],
  });
  return {
    world,
    events,
    done: () => {
      globalThis.fetch = origFetch;
      Math.random = origRandom;
      world.stop?.();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 大连，`stayStartedAt` 拨到 4 天前 —— `stayDaysSoFar` = 4，
 * 撞上 `STAY_DAYS_MAX` 那一档，**必走**，不吃 85% 的骰子。
 * 这样「没发车」就一定是我这段闸拦的，不是掷骰子没掷中。
 */
const stayingTooLong = (extra = {}) => ({
  phase: 'staying',
  hereId: 'dalian',
  homeId: 'lanzhou',
  tripStartedAt: '2026-10-28T00:00:00Z',
  stayStartedAt: '2026-11-01T00:00:00Z',
  stayDateKey: '2026-11-04',
  tripVisited: ['dalian'],
  ...extra,
});

const departs = (events) => events.filter((e) => String(e.type) === 'journey.depart');

/* ---------------- ① 离线跨过决定点：不补判 ---------------- */

test('关机 13 小时、跨过了当地 8 点：开机这一拍不发车，留在原地', async () => {
  const t = await boot(stayingTooLong({
    // 离线前世界时刻 = 11-04 13:00Z = 当地 21:00，跨了一夜到今天 10:00
    lastSeenAt: '2026-11-04T13:00:00Z',
  }));
  try {
    /* 两拍：第一拍是「新的一天」（排表 + 日事件，然后 return），第二拍才做发车判定。 */
    for (let i = 0; i < 2; i++) await t.world.tick();

    assert.equal(
      departs(t.events).length, 0,
      '刚开机就被拉走了 —— 她还没机会说「我还没待够」',
    );
    assert.equal(t.world.st.phase, 'staying', `跑到 ${t.world.st.phase} 去了`);
    assert.equal(t.world.st.hereId, 'dalian', '人不在大连了');
    assert.equal(
      t.world.st.decidedOn, '2026-11-05',
      `今天的决定点没被记成「已判」，值 = ${t.world.st.decidedOn}`,
    );
  } finally { t.done(); }
});

/* ---------------- ② 决定点没被跨过：照常判 ---------------- */

test('只离开了 1 小时半（都在 8 点之后）：照常判，该走就判它走', async () => {
  const t = await boot(stayingTooLong({
    // 离线前 = 11-05 00:30Z = 当地 08:30，两个时刻都在决定点之后
    lastSeenAt: '2026-11-05T00:30:00Z',
  }));
  try {
    for (let i = 0; i < 2; i++) await t.world.tick();
    /*
     * 判到了，就一定会说话 —— 只是 2026-11-15 起，掷中之后先「打算明天走」，
     * 当天不再直接把车票买掉（见 `announce-depart.test.mjs`）。
     * 这条守的是「保护没写宽」：正常的一轮决定必须照常发生。
     */
    assert.equal(
      t.events.filter((e) => String(e.type) === 'journey.departing').length, 1,
      '保护写宽了：正常的一轮决定也被吃掉了，她会永远留在原地',
    );
    assert.equal(departs(t.events).length, 0, '当天就走了 —— 宣布那一拍不该发车');
  } finally { t.done(); }
});

test('当天已经在场判过了（今天已排过表、也判过）：不重复判', async () => {
  const t = await boot(stayingTooLong({
    decidedOn: '2026-11-05',
    // 今天这张表已经排过了 —— 否则第一拍是「新的一天」，会把 decidedOn 重置
    stayDateKey: '2026-11-05',
    lastSeenAt: '2026-11-04T13:00:00Z',
  }));
  try {
    for (let i = 0; i < 2; i++) await t.world.tick();
    assert.equal(departs(t.events).length, 0, '一天判了两次');
  } finally { t.done(); }
});

/* ---------------- ③ 判据本身的边界 ---------------- */

test('decisionCrossedWhileAway：四个边界', async () => {
  const tz = 'Asia/Shanghai'; // UTC+8
  const at = (iso) => new Date(iso);

  // ① 跨夜：前一天 21:00 → 今天 10:00，跨过了今天 8 点
  assert.equal(
    decisionCrossedWhileAway(at('2026-11-04T13:00:00Z'), at('2026-11-05T02:00:00Z'), tz),
    true,
    '关机一夜没被认出来',
  );

  // ② 同一天，8 点前离开、8 点后回来
  assert.equal(
    decisionCrossedWhileAway(at('2026-11-04T23:55:00Z'), at('2026-11-05T00:05:00Z'), tz),
    true,
    '7:55 关机 8:05 开机，跨过了决定点却没认出来',
  );

  // ③ 同一天，两个时刻都在 8 点之后 —— 决定点没被跨过
  assert.equal(
    decisionCrossedWhileAway(at('2026-11-05T00:30:00Z'), at('2026-11-05T02:00:00Z'), tz),
    false,
    '8 点以后才离开的，不该被当成跨过',
  );

  // ④ 跨了夜，但今天 8 点还没到（凌晨 3 点开机）—— 到点自然会判，不算跳过
  assert.equal(
    decisionCrossedWhileAway(at('2026-11-04T13:00:00Z'), at('2026-11-04T19:00:00Z'), tz),
    false,
    '凌晨开机不等于「跨过了今天的决定点」',
  );
});
