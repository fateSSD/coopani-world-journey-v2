/**
 * 「他离开了 N 小时」的基准（2026-11-13）。
 *
 * 起因：读者在 Discussion #586 报「这句话每 6 小时来一次」——
 * 他的 coo 每次都以为他回来了，而他一直在电脑前。
 * 日志里四次触发间隔 6h00m03s / 6h00m19s / 6h00m11s / 6h00m56s：
 * **那是定时器，不是离开时长。**
 *
 * 根因：基准取的是 `lastTickAt`（「上一次她说过话」），而它只在触发这条提示时才写回，
 * 平时说话不写 —— 于是量的是「距上次触发多久」。现在基准换成 `lastSeenAt`，
 * 每轮巡检都刷新，只有进程真的停摆才会变旧。
 *
 * 这里钉两件事，缺一条这个 bug 就回来了：
 *   ① 连着跑满 6 小时以上，一次都不许报；
 *   ② 真停摆 7 小时，报且只报一次。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');

/** 只看这条提示自己推的事件。别的 beat 不算。 */
const awayEvents = (events) => events.filter((e) => String(e.key ?? '').startsWith('away-'));

async function makeWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'away-tick-'));
  const clock = { v: new Date('2026-11-13T02:00:00Z') }; // 北京时间 10:00
  const events = [];
  const host = {
    log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    pushEvent: async (e) => {
      events.push({ type: String(e.type), key: String(e.senderKey), text: String(e.text) });
    },
  };
  const cfg = {
    ...JOURNEY_DEFAULTS(),
    enabled: true,
    homeCity: '兰州',
    // 1x：世界时间跟真实时间同步走，6 小时就是 6 小时，不掺倍速的干扰。
    speed: 1,
    memoryDir: '',
    restDays: 1,
    maxTripWeeks: 26,
    withUser: false,
    amapKey: '',
    imageApi: '',
    imageKey: '',
  };
  const w = new JourneyWorld({ cfg, dataDir: dir, botName: 'test', now: () => clock.v });
  await w.start(host);
  return {
    w,
    events,
    clock,
    tick: () => w.tick(),
    advance: (ms) => { clock.v = new Date(clock.v.getTime() + ms); },
    done: async () => { await w.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('一直开着：跑满 6 小时 40 分，一次都不许报「你回来了」', async () => {
  const t = await makeWorld();
  try {
    /*
     * 10 分钟一轮 × 40 轮 = 400 分钟，稳稳跨过 6 小时的阈值。
     * 改之前这里必红：第 37 轮就会有「他离开了 6 小时」——
     * 而下面这条路径上**没有任何一刻他离开过**，进程一直在跑。
     */
    for (let i = 0; i < 40; i++) {
      t.advance(10 * 60_000);
      await t.tick();
    }
    const hits = awayEvents(t.events);
    assert.equal(
      hits.length,
      0,
      `人一直在电脑前，却被报了 ${hits.length} 次：${hits.map((h) => h.key).join(', ')}`,
    );
  } finally {
    await t.done();
  }
});

test('真停摆 7 小时：报一次，而且只有一次', async () => {
  const t = await makeWorld();
  try {
    await t.tick(); // 正常一轮，建立基准

    /*
     * 模拟「Coopani 关了一夜」：把基准拨回 7 小时前。
     * 真机上这一项停在那，是因为进程没跑，没人刷新它。
     */
    const nowMs = t.clock.v.getTime();
    t.w.st = { ...t.w.st, lastSeenAt: new Date(nowMs - 7 * 3_600_000).toISOString() };
    t.w.lastSeenSavedMs = 0; // 让 markSeen 这一轮必定落盘

    t.advance(60_000);
    await t.tick();

    const hits = awayEvents(t.events);
    assert.equal(hits.length, 1, `停摆 7 小时应该报一次，实际 ${hits.length} 次`);
    assert.match(hits[0].text, /7 个小时/, `报的时长不对：${hits[0].text.slice(0, 80)}`);

    /* 下一轮：基准已经被推到当前时刻，同一段离开不许再说一遍。 */
    t.advance(60_000);
    await t.tick();
    assert.equal(awayEvents(t.events).length, 1, '同一段离开说了两遍');
  } finally {
    await t.done();
  }
});

test('老状态没有 lastSeenAt：第一轮不报，之后正常滚动', async () => {
  const t = await makeWorld();
  try {
    /* 老 state.json 里没有这一项 —— 读进来是 null，不能当成「离开了很久」。 */
    t.w.st = { ...t.w.st, lastSeenAt: null };
    t.w.lastSeenSavedMs = 0;

    t.advance(60_000);
    await t.tick();
    assert.equal(awayEvents(t.events).length, 0, '升级那一刻白挨了一次假的「你回来了」');

    /* 写进去了才算数：值必须落在当前时刻附近，不能是空。 */
    assert.ok(t.w.st.lastSeenAt, '第一轮没把 lastSeenAt 写回去');
    const gap = Math.abs(Date.parse(t.w.st.lastSeenAt) - t.clock.v.getTime());
    assert.ok(gap < 60_000, `lastSeenAt 写成了 ${t.w.st.lastSeenAt}，跟当前时刻差 ${gap}ms`);
  } finally {
    await t.done();
  }
});
