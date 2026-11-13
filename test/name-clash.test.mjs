/**
 * 约的对象和自己同名 —— 2026-11-06，0.7.13
 *
 * Mr.Q 两台电脑各养一只鱼，起了同一个名字。本机那天读到的约定是
 * 「和『克罗艾的小银鱼』在成都待三天」，而她自己就叫这个 ——
 * 她跟用户报告同行者时名字整个乱掉（「算上我两个。一个是 Mr.大肥鱼~」），
 * 用户的原话是「这是认知错乱了啊」。
 *
 * 数据没错（对方确实叫这个），错的是**称呼**。所以只在输出时加区分，
 * 存下来的名字一个字都不改 —— 那是「对方当时叫什么」的事实。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

const MINE = '克罗艾的小银鱼';
const MARK = '（另一位同名的鱼）';

function fakeHost() {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => ({ ...e, blobs: [] }),
    pushDeferred() {}, store: {}, drainPendingEvents: async () => [],
  };
}

async function boot(withPet, botName = MINE) {
  const dataDir = mkdtempSync(join(tmpdir(), 'jr-name-'));
  new StateStore(dataDir).save({
    ...initialState('lanzhou'),
    phase: 'staying',
    hereId: 'chengdu',
    tripStartedAt: '2026-11-05T00:00:00Z',
    stayStartedAt: '2026-11-06T04:00:00Z',
    stayDateKey: '2026-11-06',
    pledge: {
      cityId: 'chengdu',
      days: 3,
      withPet,
      inviteId: 'abcdef0123456789',
      acceptedAt: '2026-11-05T06:00:00Z',
      arrivedAt: '2026-11-06T04:18:00Z',
    },
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir,
    botName,
    now: () => new Date('2026-11-06T04:20:00Z'),
  });
  await world.start(fakeHost());
  return { world, restore: () => { globalThis.fetch = origFetch; world.stop?.(); } };
}

test('约的对象和自己同名：面板上要标出「另一位」', async () => {
  const { world, restore } = await boot(MINE);
  try {
    const snap = world.uiSnapshot();
    assert.equal(snap.social.pledge.withPet, MINE + MARK, `没标出来：${snap.social.pledge.withPet}`);
    assert.equal(snap.social.pledge.city, '成都');
  } finally { restore(); }
});

test('不同名：一个字都不加（这是绝大多数情况）', async () => {
  const { world, restore } = await boot('小满');
  try {
    assert.equal(world.uiSnapshot().social.pledge.withPet, '小满');
  } finally { restore(); }
});

test('存下来的名字不动 —— 那是对方当时叫什么的事实', async () => {
  const { world, restore } = await boot(MINE);
  try {
    world.uiSnapshot();
    assert.equal(world.st.pledge.withPet, MINE, 'state 里的名字被改了');
  } finally { restore(); }
});

test('她读到的行程里也要带上标记', async () => {
  const { world, restore } = await boot(MINE);
  try {
    const text = String(world.nowSummary?.() ?? '');
    assert.ok(text.includes(MARK), `journey.now 里没提这件事：${text.slice(0, 120)}`);
  } finally { restore(); }
});
