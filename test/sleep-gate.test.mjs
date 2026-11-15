/**
 * 她在睡，旅行这边不许出发（2026-11-15 Mr.Q）。
 *
 * 原话：「睡眠时禁止 journey 的出发。」
 *
 * 做法：她那边把睡眠窗口写进 `life-public.json`（她是唯一的写者），
 * 这边只读。**判错的方向必须是安全的** —— 读不到就当醒着：
 * 少睡一次只是她多走一天，反过来是「世界停在那里等她」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

/** 世界时钟的「现在」。所有断言都拿这个当基准。 */
const NOW = new Date('2026-10-31T02:00:00Z');

function fakeHost() {
  return {
    events: [],
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => ({ ...e, blobs: [] }),
    pushDeferred: () => {},
    store: {},
    drainPendingEvents: async () => [],
  };
}

/** 一个「已经在成都待够、该走了」的档 —— 不睡觉的话这一跳就会出发。 */
function seedStayed() {
  const dir = mkdtempSync(join(tmpdir(), 'jr-sleep-'));
  new StateStore(dir).save({
    ...initialState('lanzhou'),
    phase: 'staying',
    hereId: 'chengdu',
    homeId: 'lanzhou',
    /* 十天前就到了，肯定过了 STAY_DAYS_MIN。 */
    stayStartedAt: '2026-10-21T02:00:00Z',
    stayDateKey: '2026-10-31',
    decidedOn: null,
  });
  return dir;
}

const makeWorld = (dir) => new JourneyWorld({
  cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
  dataDir: dir,
  botName: '大肥鱼',
  now: () => NOW,
});

test('她在睡：这一跳不出发（人还在成都）', async () => {
  const dir = seedStayed();
  writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
    schema: 1,
    asleepUntil: '2026-10-31T03:00:00Z', // 睡到一小时后
    updatedAt: NOW.toISOString(),
  }));

  const w = makeWorld(dir);
  await w.start(fakeHost());
  await w.stayTick(NOW);

  assert.equal(w.st.hereId, 'chengdu', '睡着了不该走');
  assert.equal(w.st.phase, 'staying', '睡着了不该上路');
  /* 连「明天走」那句预告都不该说 —— 那是「她打定主意了」，睡着的她没这个主意。 */
  assert.equal(w.st.announceDepartOn ?? null, null, '睡着了连预告都不该说');
});

test('睡醒了（窗口已过）：照常出发 —— 别把人按在床上', async () => {
  const dir = seedStayed();
  writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
    schema: 1,
    asleepUntil: '2026-10-31T01:00:00Z', // 一小时前就醒了
    updatedAt: NOW.toISOString(),
  }));

  const w = makeWorld(dir);
  await w.start(fakeHost());
  await w.stayTick(NOW);

  const moved = w.st.phase !== 'staying' || !!w.st.announceDepartOn;
  assert.ok(moved, `醒了就该动身（现在是 ${w.st.phase}，预告 ${w.st.announceDepartOn ?? '无'}）`);
});

test('没装 life / 文件坏了：当醒着，不能因为少一个文件就停摆', async () => {
  const dir = seedStayed();
  /* 故意写坏 —— 半个 JSON。 */
  writeFileSync(join(dir, 'life-public.json'), '{"schema":1,"asleepUntil":');

  const w = makeWorld(dir);
  await w.start(fakeHost());
  await w.stayTick(NOW);

  const moved = w.st.phase !== 'staying' || !!w.st.announceDepartOn;
  assert.ok(moved, '坏文件也要照走');
});

test('睡着那天不占「今天已经判过」的额度 —— 醒来当天还能走', async () => {
  /*
   * 这条是端到端跑出来的回归（2026-11-15）。
   *
   * 第一版把睡眠判断写在 `decidedOn = 今天` 之后：睡着那天照样把额度写掉，
   * 八小时后窗口清空、再 tick —— 人还在原地，`announceDepartOn` 是 null。
   * 「睡一觉」于是变成了「白等一整天」。
   */
  const dir = seedStayed();
  writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
    schema: 1, asleepUntil: '2026-10-31T03:00:00Z', updatedAt: NOW.toISOString(),
  }));

  const w = makeWorld(dir);
  await w.start(fakeHost());
  await w.stayTick(NOW);

  assert.equal(w.st.decidedOn ?? null, null, '睡着那天不该占掉今天的决策额度');
});

test('在家睡着：也不出门（不出发也不弹 askToDepart）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-sleep-home-'));
  new StateStore(dir).save({
    ...initialState('lanzhou'),
    phase: 'home',
    hereId: 'lanzhou',
    homeId: 'lanzhou',
    homeAt: '2026-10-20T02:00:00Z',
  });
  writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
    schema: 1,
    asleepUntil: '2026-10-31T03:00:00Z', // NOW 是 02:00Z，北京 10:00（在 7-21 点出门窗口内）
    updatedAt: NOW.toISOString(),
  }));

  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', restDays: 0 },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => NOW,
  });
  await w.start(fakeHost());
  w.bootedAt = 0; // 跳过加载宽限
  await w.tick();

  assert.equal(w.st.phase, 'home', '在家睡着不该出发');
  assert.equal(w.st.leg ?? null, null, '在家睡着不该生成行程');
});
