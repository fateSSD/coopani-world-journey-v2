/**
 * 「谁到了」—— 名单在，但她不能说「我这边没写」
 *
 * Mr.Q 发来一段对话：
 *
 *   > 约好的在成都待三天，还剩两天。至于谁到了 —— 我这边的表上真没写，不敢替他们编。
 *
 * 查下来名字一直都在：state 的 `pledge.withPets` 是
 * 「慕容悠 / 玄月的大肥鱼 / 风子家的鱼宝宝」三个人，
 * `pledgeText()` 每回合都会把名单拼进 `nowSummary`。
 *
 * 错在**那句话只报了「跟谁、几天、还剩几天」，没报「人到了没有」**。
 * 于是「谁到了」在她那儿变成一个「我没有这个字段」的问题 ——
 * 她把自己的内部结构（“表”）讲给用户听，本该说的一句话一个字没说。
 *
 * `arrivedAt` 有值的语义就是「人都到了」（`mateLine` 的判据：人没到就不说「一起过」）。
 * 这里守的就是这句话必须显式写出来，而且名字必须在场。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

const NOW = '2026-11-07T09:00:00Z';

function fakeHost(events) {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => { events.push(e); return { ...e, blobs: [] }; },
    pushDeferred() {}, store: {}, drainPendingEvents: async () => [],
  };
}

async function boot(state, now) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-pledge-now-'));
  new StateStore(dir).save(state);
  const events = [];
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(now),
  });
  const origFetch = globalThis.fetch;
  await world.start(fakeHost(events));
  const restore = () => { globalThis.fetch = origFetch; world.stop?.(); };
  return { world, restore };
}

/** 她每回合读到的那段现状。 */
const nowText = (world) => world.tools()[0].handler({}).then((r) => r.text);

const THREE = ['慕容悠', '玄月的大肥鱼', '风子家的鱼宝宝'];

const stayingWithPledge = () => ({
  ...initialState('lanzhou'),
  phase: 'staying',
  hereId: 'chengdu',
  tripStartedAt: '2026-10-31T10:25:01Z',
  stayStartedAt: '2026-11-06T04:18:14Z',
  stayDateKey: '2026-11-07',
  pledge: {
    cityId: 'chengdu',
    days: 3,
    withPet: '慕容悠',
    withPets: THREE,
    inviteId: 'dab22bb1dd7953fd',
    acceptedAt: '2026-11-06T04:19:57Z',
    arrivedAt: '2026-11-06T04:19:57Z',
  },
});

test('现状里必须同时有「三个人名」和「人都到了」', async () => {
  const { world, restore } = await boot(stayingWithPledge(), NOW);
  try {
    const t = await nowText(world);
    for (const name of THREE) {
      assert.ok(t.includes(name), `名单里少了「${name}」：\n${t}`);
    }
    assert.match(t, /人已经到了|人还都在/, `只报了天数和城市，没说人到了：\n${t}`);
    assert.match(t, /还剩 2 天/, `剩余天数算错：\n${t}`);
    /* 不许把内部结构说给她听 —— 那句「我这边的表上真没写」就是这么来的 */
    assert.doesNotMatch(t, /表上|字段|数据库/, `现状里出现了内部结构词：\n${t}`);
  } finally { restore(); }
});

test('人没到的时候，不许说「就在身边」', async () => {
  const s = stayingWithPledge();
  s.pledge = { ...s.pledge, arrivedAt: null, cityId: 'lasa' };
  const { world, restore } = await boot(s, NOW);
  try {
    const t = await nowText(world);
    assert.doesNotMatch(t, /就在身边|已经都到了/, `人还在路上就说到了：\n${t}`);
  } finally { restore(); }
});

test('待满之后也不许说「还剩 0 天」', async () => {
  const s = stayingWithPledge();
  s.stayStartedAt = '2026-11-01T00:00:00Z';
  s.pledge = { ...s.pledge, acceptedAt: '2026-11-01T00:00:00Z', arrivedAt: '2026-11-01T00:00:00Z' };
  const { world, restore } = await boot(s, NOW);
  try {
    const t = await nowText(world);
    assert.doesNotMatch(t, /还剩 0 天/, `把待满说成了还剩 0 天：\n${t}`);
  } finally { restore(); }
});
