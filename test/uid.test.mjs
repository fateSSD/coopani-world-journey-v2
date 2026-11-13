/**
 * 她在池子里的身份（uid）归哪台机器 —— 2026-11-06，0.7.12
 *
 * ## 起因
 *
 * Mr.Q 有两台电脑，日记目录都指到同一个 OneDrive。而 `meet-uid.txt` 原来是
 * **放在日记目录里的** —— 于是两台读同一个文件、用同一个 uid。
 *
 * 后果不只是「看起来像同一只鱼」：池子的「今天多少只」按 uid 去重（两台算一只）、
 * 两台同时上报会互相覆盖同一条 presence、邀约和邻居也会串。
 *
 * 现在 uid 存在本机 `dataDir`，云盘那份只在**本机还没有**时被认领一次，
 * 认领记在 `meet-uid.owner`（主机名）里 —— 另一台看到已被认领，就生成自己的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

const OLD_UID = 'aaaabbbbccccddddeeeeffff';

function fakeHost() {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => ({ ...e, blobs: [] }),
    pushDeferred() {}, store: {}, drainPendingEvents: async () => [],
  };
}

/** 起一台 World，返回它的 uid 取法。`memoryDir` 就是「云盘」目录。 */
async function boot(dataDir, memoryDir) {
  new StateStore(dataDir).save(initialState('lanzhou'));
  const world = new JourneyWorld({
    cfg: {
      ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州',
      meetUrl: 'https://x.test', memoryDir,
    },
    dataDir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-06T04:00:00Z'),
  });
  await world.start(fakeHost());
  const uid = world.meetOptions()?.uid ?? '';
  world.stop?.();
  return uid;
}

test('云盘里有一份没人认领的 uid：沿用，本机身份不变', async () => {
  const cloud = mkdtempSync(join(tmpdir(), 'jr-cloud-'));
  const data = mkdtempSync(join(tmpdir(), 'jr-data-'));
  writeFileSync(join(cloud, 'meet-uid.txt'), OLD_UID, 'utf8');

  const uid = await boot(data, cloud);
  assert.equal(uid, OLD_UID, '老身份没被接过来 —— 池子里会凭空多一只陌生的鱼');
  // 落到本机：之后这台机器不再依赖云盘那个文件
  assert.equal(readFileSync(join(data, 'meet-uid.txt'), 'utf8').trim(), OLD_UID);
  // 认领标记写上，另一台才知道「这个已被占」
  assert.ok(readFileSync(join(cloud, 'meet-uid.owner'), 'utf8').trim().length > 0, '没写认领标记');
});

test('云盘那份已经被另一台认领：这台生成自己的，不再共用', async () => {
  const cloud = mkdtempSync(join(tmpdir(), 'jr-cloud-'));
  const data = mkdtempSync(join(tmpdir(), 'jr-data-'));
  writeFileSync(join(cloud, 'meet-uid.txt'), OLD_UID, 'utf8');
  writeFileSync(join(cloud, 'meet-uid.owner'), 'ANOTHER-PC', 'utf8');

  const uid = await boot(data, cloud);
  assert.notEqual(uid, OLD_UID, '另一台已经认领了，这台还在用同一个身份');
  assert.match(uid, /^[a-f0-9]{24}$/i, `新 uid 形状不对：${uid}`);
});

test('本机已经有 uid：直接用，连云盘都不看', async () => {
  const cloud = mkdtempSync(join(tmpdir(), 'jr-cloud-'));
  const data = mkdtempSync(join(tmpdir(), 'jr-data-'));
  writeFileSync(join(cloud, 'meet-uid.txt'), OLD_UID, 'utf8');
  const mine = '111122223333444455556666';
  writeFileSync(join(data, 'meet-uid.txt'), mine, 'utf8');

  const uid = await boot(data, cloud);
  assert.equal(uid, mine, '本机的身份被云盘那份顶掉了');
});

test('没设云盘目录：照旧在本机生成一个', async () => {
  const data = mkdtempSync(join(tmpdir(), 'jr-data-'));
  const uid = await boot(data, '');
  assert.match(uid, /^[a-f0-9]{24}$/i, `uid 形状不对：${uid}`);
  assert.equal(readFileSync(join(data, 'meet-uid.txt'), 'utf8').trim(), uid);
});
