/**
 * 密钥搬家的整条链路（#659 第二条，2026-11-13）。
 *
 * 单元测试问的是「adoptKey 判断对不对」，这里问的是**线接上了没有**：
 * 世界一启动，配置里那份真的进了 `.env`、配置真的被清、清这件事真的落了盘。
 *
 * 三件都得有。少最后一件最阴 —— 内存里空了、重启又回来，
 * 用户看到的是「每次都要重填」，而我们看到的是「代码明明改了」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { AMAP_KEY_NAME, IMAGE_KEY_NAME } = await import('../src/secrets.ts');
const { StateStore, initialState } = await import('../src/state.ts');

function fakeHost() {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => ({ ...e, blobs: [] }),
    pushDeferred() {}, store: {}, drainPendingEvents: async () => [],
  };
}

/** 一个内存版 `.env`。`refuse` = 宿主试挂载时那个空实现。 */
function boot({ amapKey = '', imageKey = '', refuse = false } = {}) {
  const env = {};
  const patches = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'jr-secret-'));
  new StateStore(dataDir).save(initialState('lanzhou'));
  const cfg = {
    ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', amapKey, imageKey,
  };
  const world = new JourneyWorld({
    cfg,
    dataDir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-13T04:00:00Z'),
    keys: {
      read: (name) => env[name] ?? '',
      write: (name, value) => { if (!refuse) env[name] = value; },
    },
    persist: (patch) => { patches.push(patch); },
  });
  return { world, cfg, env, patches };
}

test('启动后：两个密钥都进了 .env，配置被清空，清空落了盘', async () => {
  const b = boot({ amapKey: 'amap-123', imageKey: 'img-456' });
  await b.world.start(fakeHost());

  assert.equal(b.env[AMAP_KEY_NAME], 'amap-123', '高德密钥没进 .env');
  assert.equal(b.env[IMAGE_KEY_NAME], 'img-456', '生图密钥没进 .env');
  assert.equal(b.cfg.amapKey, '', '配置清空了内存里的，但没清 cfg 本身');
  assert.equal(b.cfg.imageKey, '');
  assert.deepEqual(b.patches, [{ amapKey: '', imageKey: '' }], '没落盘 —— 重启一次 key 又回来了');

  b.world.stop?.();
});

test('启动后：试挂载（写不进去）**一个字都不许改**', async () => {
  /*
   * 宿主探测扩展时会用空实现的 storeSecret 跑一遍 create/start。
   * 这一遍要是把配置清了，用户真正的世界里 key 就没了。
   */
  const b = boot({ amapKey: 'amap-123', refuse: true });
  await b.world.start(fakeHost());

  assert.deepEqual(b.env, {}, '空实现居然也写进去了？');
  assert.equal(b.cfg.amapKey, 'amap-123', '试挂载把用户的 key 抹掉了');
  assert.deepEqual(b.patches, [], '试挂载居然往 config.json 写了东西');

  b.world.stop?.();
});

test('启动后：没填过密钥的人，不该多出一次写盘', async () => {
  const b = boot();
  await b.world.start(fakeHost());
  assert.deepEqual(b.env, {});
  assert.deepEqual(b.patches, []);
  b.world.stop?.();
});

test('启动后：已经在 .env 里的，只清配置不再重写', async () => {
  const b = boot({ amapKey: 'amap-123' });
  b.env[AMAP_KEY_NAME] = 'amap-123';
  await b.world.start(fakeHost());
  assert.equal(b.cfg.amapKey, '', '上一次搬过但没清干净，这次该清');
  assert.deepEqual(b.patches, [{ amapKey: '' }]);
  b.world.stop?.();
});

test('面板修改生图密钥：.env 已有旧密钥时立即覆写新密钥并清空 cfg 明文，且剥离 Bearer 前缀/拒收空白', async () => {
  const b = boot();
  b.env[IMAGE_KEY_NAME] = 'old-key-111';
  await b.world.start(fakeHost());
  assert.equal(b.world.imageKey(), 'old-key-111');

  b.world.saveImageSettings({ imageKey: 'Bearer new-key-222' });
  assert.equal(b.env[IMAGE_KEY_NAME], 'new-key-222', 'saveImageSettings 应立即覆写 .env');
  assert.equal(b.cfg.imageKey, '', '覆写进 .env 后配置项应被清空');
  assert.equal(b.world.imageKey(), 'new-key-222', '无需重启 imageKey() 即刻返回新密钥');

  // 保存其他字段不传 imageKey 时保留现有 .env 密钥
  b.world.saveImageSettings({ imageModel: 'doubao-seedream-5-5-261028' });
  assert.equal(b.env[IMAGE_KEY_NAME], 'new-key-222');

  // 含非法空白字符直接拒绝
  assert.throws(() => b.world.saveImageSettings({ imageKey: 'bad key with space' }), /不能包含空格或换行/);
  b.world.stop?.();
});

test('试挂载或 .env 不可写时修改生图密钥：imageKey() 必须优先读新配置而非旧 .env', async () => {
  const b = boot({ refuse: true });
  b.env[IMAGE_KEY_NAME] = 'old-key-111';
  await b.world.start(fakeHost());

  b.world.saveImageSettings({ imageKey: 'new-key-333' });
  assert.equal(b.env[IMAGE_KEY_NAME], 'old-key-111', 'refuse=true 模拟写不进 .env');
  assert.equal(b.cfg.imageKey, 'new-key-333', '写不进 .env 时保留 cfg 里的新密钥');
  assert.equal(b.world.imageKey(), 'new-key-333', '读取时新配置必须优先于旧 .env');
  b.world.stop?.();
});
