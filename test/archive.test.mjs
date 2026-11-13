/**
 * 照片和报告跟着日记一起走 —— 2026-11-06，0.7.12
 *
 * ## 起因
 *
 * Mr.Q：「我两台电脑的鱼写的日记一条鱼的图片在上面，另一条却没有」。
 *
 * 三样东西原来存在三个地方：日记正文在 `memoryDir`（他指到 OneDrive）、
 * 照片在宿主媒体库、月报年报在 `dataDir/reports`。只有第一样跟着云盘走，
 * 于是另一台打开日记就是有字没图。
 *
 * 现在拍完照、写完报告各多存一份到日记目录旁边。这里钉的是**落点**，
 * 不是 HTML 长什么样（那是 `monthly.test.mjs` 的事）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

function fakeHost() {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => ({ ...e, blobs: [] }),
    pushDeferred() {}, store: {}, drainPendingEvents: async () => [],
  };
}

async function boot(memoryDir) {
  const dataDir = mkdtempSync(join(tmpdir(), 'jr-arch-'));
  new StateStore(dataDir).save(initialState('lanzhou'));
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', memoryDir },
    dataDir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-06T04:00:00Z'),
  });
  await world.start(fakeHost());
  return { world, dataDir, stop: () => world.stop?.() };
}

test('设了云盘目录：报告和照片各多存一份在日记旁边', async () => {
  const cloud = mkdtempSync(join(tmpdir(), 'jr-cloud-'));
  const { world, stop } = await boot(cloud);
  try {
    world.archiveToJournal('reports', '2026-10.html', '<html>月报</html>');
    world.archiveToJournal('media', 'ab12cd34ef567890.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    assert.ok(existsSync(join(cloud, 'reports', '2026-10.html')), '月报没跟过去');
    assert.ok(existsSync(join(cloud, 'media', 'ab12cd34ef567890.png')), '照片没跟过去');
  } finally { stop(); }
});

test('没设云盘目录：一个都不写（日记本来就在本机，复制没意义）', async () => {
  const { world, dataDir, stop } = await boot('');
  try {
    world.archiveToJournal('reports', '2026-10.html', '<html></html>');
    world.archiveToJournal('media', 'x.png', new Uint8Array([1]));
    // 没设目录时连子目录都不该被建出来
    assert.equal(existsSync(join(dataDir, 'reports')), false, '没设云盘却建了 reports');
    assert.equal(existsSync(join(dataDir, 'media')), false, '没设云盘却建了 media');
  } finally { stop(); }
});

test('同一张照片重复存：不重写（免得云盘每次都当新改动传一遍）', async () => {
  const cloud = mkdtempSync(join(tmpdir(), 'jr-cloud-'));
  const { world, stop } = await boot(cloud);
  try {
    world.archiveToJournal('media', 'ab12.png', new Uint8Array([1, 2, 3]));
    const file = join(cloud, 'media', 'ab12.png');
    const first = (await import('node:fs')).readFileSync(file);

    world.archiveToJournal('media', 'ab12.png', new Uint8Array([9, 9, 9]));
    const second = (await import('node:fs')).readFileSync(file);
    assert.deepEqual(second, first, '同名照片被重写了 —— 云盘会多传一次');
  } finally { stop(); }
});
