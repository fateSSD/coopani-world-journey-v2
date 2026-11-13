/**
 * 位置心跳 —— 2026-11-10。
 *
 * ## 起因
 *
 * Mr.Q：「我自己的鱼有两只，一只在你这台电脑上，一只在单位电脑上，这就已经是两只了，
 * 何来一只在线之说呢？」
 *
 * 查下来两条都没在线，而池子里那个「1」是别人家的鱼。根因不是显示：
 * **上报只挂在三个时机上**（启动、到站/重排日程、手动同步钟）。他这台今早 07:40
 * 启动时报了一次，正撞在服务端故障窗口里（500，静默失败），之后一直在昆明没动、
 * 日程没重建 —— 于是整整一天再没有第二次机会。
 *
 * 一条整天待着不动的鱼，在池子里会自动消失。这个测试守的就是这条：
 * **心跳必须在，而且必须真的往上打。**
 *
 * ## 守两件事
 *
 * 1. 心跳间隔存在、`start()` 挂上、`stop()` 清掉（漏了清理就是进程里留一个野定时器）；
 * 2. 那个定时器真的会发 `POST /sight` —— 只挂个空壳不算数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

const HEARTBEAT_MS = 20 * 60_000;
const NOW = '2026-11-10T07:00:00Z';

function fakeHost() {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => ({ ...e, blobs: [] }),
    pushDeferred() {},
    store: {},
    drainPendingEvents: async () => [],
  };
}

/**
 * 起一个「在成都待着」的世界，并把心跳定时器的回调抓出来。
 *
 * 直接等 20 分钟当然不行，所以临时接管 `setInterval`：目标间隔的那个存下回调、
 * 换成一个永远不触发的真定时器（`unref` 过，不挡进程退出）。其余间隔照旧。
 */
async function bootWithHeartbeat() {
  const dir = mkdtempSync(join(tmpdir(), 'jr-heart-'));
  new StateStore(dir).save({
    ...initialState('lanzhou'),
    phase: 'staying',
    hereId: 'chengdu',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
  });

  const posts = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('/sight') && String(init.method || '').toUpperCase() === 'POST') {
      posts.push({ url: href, body: JSON.parse(String(init.body || '{}')) });
      return new Response('{"ok":true}', {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('offline');
  };

  const origSetInterval = globalThis.setInterval;
  let heartbeat = null;
  globalThis.setInterval = (fn, ms, ...rest) => {
    if (ms === HEARTBEAT_MS) {
      heartbeat = fn;
      const idle = origSetInterval(() => {}, 1 << 30, ...rest);
      idle.unref?.();
      return idle;
    }
    return origSetInterval(fn, ms, ...rest);
  };

  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', meetUrl: 'https://x.test' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(NOW),
  });

  try {
    await world.start(fakeHost());
  } finally {
    globalThis.setInterval = origSetInterval;
  }

  const restore = () => {
    globalThis.fetch = origFetch;
    return world.stop?.();
  };
  return { world, posts, heartbeat, restore };
}

test('心跳：start 挂上、stop 清掉', async () => {
  const { world, heartbeat, restore } = await bootWithHeartbeat();
  try {
    assert.equal(typeof heartbeat, 'function', 'start() 没挂 20 分钟的心跳定时器');
    assert.ok(world.heartTimer, '心跳句柄没存下来 —— stop() 就清不掉了');
  } finally {
    await restore();
  }
  assert.equal(world.heartTimer, null, 'stop() 之后心跳还留着，进程里会有一个野定时器');
});

test('心跳：到点真的往 /sight 打一次上报', async () => {
  const { world, posts, heartbeat, restore } = await bootWithHeartbeat();
  try {
    assert.ok(posts.length >= 1, '启动那次上报都没发出去，测试前提不成立');

    const before = posts.length;
    await heartbeat();
    assert.equal(posts.length, before + 1, '心跳跑了却没发请求 —— 挂的是空壳');

    const last = posts.at(-1);
    assert.equal(last.body.city, 'chengdu', `上报的城市不对：${last.body.city}`);
    assert.ok(last.body.uid, '上报没带 uid，服务端会 400');
  } finally {
    await restore();
  }
});

test('心跳：在路上不发 —— 半路没有「所在的城」', async () => {
  const { world, posts, heartbeat, restore } = await bootWithHeartbeat();
  try {
    world.st = {
      ...world.st,
      phase: 'traveling',
      leg: { fromId: 'chengdu', toId: 'kunming', modeId: 'train', startedAt: NOW, arriveAt: NOW },
    };
    const before = posts.length;
    await heartbeat();
    assert.equal(posts.length, before, '在路上仍然上报了 —— 服务端会按错的城市给她找邻居');
  } finally {
    await restore();
  }
});

/* ------------------------------------------------------------------
 * 失败自愈 —— 2026-11-10
 *
 * 心跳解决的是「待着不动的鱼会消失」，但解决不了另一半：**服务端连不上时，
 * 失败了就只是失败**。2026-11-09 那次线上故障，200 条鱼的上报全部 500、
 * 每条只写一行 warn 就没了，一整天没有任何一次补救 —— 客户端手里握着
 * 「我最后一次成功是什么时候」，却不用它做任何事。
 *
 * 这一组守的是：**失败之后客户端自己会回头试，而且退避有上界。**
 * ------------------------------------------------------------------ */

const RETRY_MS = [60_000, 3 * 60_000, 10 * 60_000];
/** 从排程记录里只挑「重试」那几个，别把 bootTimer（6 秒）也算进去。 */
const retryWaits = (timers) => timers.filter((t) => RETRY_MS.includes(t.ms)).map((t) => t.ms);

/**
 * 起一个世界，`okAtStart` 决定上报成败；`setOk()` 可以中途翻盘。
 *
 * `setTimeout` 也接管了：重试的间隔是分钟级，真等不行，只能把排程记下来。
 */
async function bootWithRetry(okAtStart) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-retry-'));
  new StateStore(dir).save({
    ...initialState('lanzhou'),
    phase: 'staying',
    hereId: 'chengdu',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
  });

  let ok = okAtStart;
  const posts = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('/sight') && String(init.method || '').toUpperCase() === 'POST') {
      posts.push({ url: href, body: JSON.parse(String(init.body || '{}')) });
      return new Response(ok ? '{"ok":true}' : '{"ok":false}', {
        status: ok ? 200 : 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('offline');
  };

  const origSetInterval = globalThis.setInterval;
  const origSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setInterval = (fn, ms, ...rest) => {
    const idle = origSetInterval(() => {}, 1 << 30, ...rest);
    idle.unref?.();
    return idle;
  };
  globalThis.setTimeout = (fn, ms, ...rest) => {
    timers.push({ fn, ms });
    const idle = origSetTimeout(() => {}, 1 << 30, ...rest);
    idle.unref?.();
    return idle;
  };

  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', meetUrl: 'https://x.test' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(NOW),
  });

  try {
    await world.start(fakeHost());
  } finally {
    globalThis.setInterval = origSetInterval;
    /*
     * `setTimeout` 要留到 `restore()` 再还原 —— 重试排程发生在 `start()` **之后**
     * （测试要连着触发好几次失败），这时候换回原生就记不到了。
     * 2026-11-10 第一次写这个测试就栽在这儿：断言拿到的一直是启动那条 60 秒。
     */
  }

  const restore = () => {
    globalThis.fetch = origFetch;
    const done = world.stop?.();
    globalThis.setTimeout = origSetTimeout;
    return done;
  };
  return { world, posts, timers, setOk: (v) => { ok = v; }, restore };
}

test('上报失败立刻排一次重试 —— 不等下一次心跳', async () => {
  const { world, timers, restore } = await bootWithRetry(false);
  try {
    assert.equal(world.reportFails, 1, '启动那次上报失败了，计数却还是 0');
    assert.ok(world.reportRetryTimer, '失败之后没排重试 —— 服务端恢复了它也不会自己回来');
    assert.equal(retryWaits(timers).at(-1), 60_000,
      `第一次重试该是 1 分钟，实际 ${retryWaits(timers).at(-1)}`);
  } finally {
    await restore();
  }
});

test('上报成功不排重试', async () => {
  const { world, timers, restore } = await bootWithRetry(true);
  try {
    assert.equal(world.reportFails, 0);
    assert.equal(world.reportRetryTimer, null, '成功还排了重试，等于白打一次请求');
    assert.equal(retryWaits(timers).length, 0);
  } finally {
    await restore();
  }
});

test('连续失败退避到 10 分钟封顶，不再往下拉', async () => {
  const { world, timers, restore } = await bootWithRetry(false);
  try {
    assert.equal(retryWaits(timers).at(-1), 60_000);

    // 模拟「上一次排的那次重试已经跑掉了」，再失败一次
    const again = async () => {
      world.reportRetryTimer = null;
      await world.reportHere();
      return retryWaits(timers).at(-1);
    };
    assert.equal(await again(), 3 * 60_000, '第二次该退到 3 分钟');
    assert.equal(await again(), 10 * 60_000, '第三次该退到 10 分钟');
    assert.equal(await again(), 10 * 60_000, '第四次还该是 10 分钟 —— 不能无限拉长，否则恢复后她一小时都回不来');
    assert.equal(await again(), 10 * 60_000, '第五次仍该封顶在 10 分钟');
  } finally {
    await restore();
  }
});

test('恢复一次就清零，并把重试定时器摘掉', async () => {
  const { world, setOk, restore } = await bootWithRetry(false);
  try {
    assert.equal(world.reportFails, 1);
    assert.ok(world.reportRetryTimer);

    setOk(true);
    await world.reportHere();

    assert.equal(world.reportFails, 0, '成功之后失败计数没清 —— 下次失败会从旧数字上叠');
    assert.equal(world.reportRetryTimer, null, '成功之后重试定时器还在，会多打一次请求');
  } finally {
    await restore();
  }
});

test('stop() 把重试定时器也清掉', async () => {
  const { world, restore } = await bootWithRetry(false);
  try {
    assert.ok(world.reportRetryTimer, '前提：此刻有一个待重试');
  } finally {
    await restore();
  }
  assert.equal(world.reportRetryTimer, null, 'stop() 之后重试还留着，进程里会有一个野定时器');
});
