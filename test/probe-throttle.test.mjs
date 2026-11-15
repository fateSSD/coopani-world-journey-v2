/**
 * 限流不能只看成功路径（2026-11-11 线上事故）
 *
 * ## 事故
 *
 * 2026-11-11 晚，Cloudflare Workers 免费层 10 万次/天被打满。
 * 表面看是「用户变多了」，实际池子里只有 **68 只鱼**。
 *
 * 68 × 24（`STATUS_PROBE_MS` = 60 分钟）= **1,632 次/天**，正常得很。
 * 但那天用掉了 **9.1 万次**。
 *
 * ## 根因
 *
 * `probeStatus` 里原本是：
 *
 * ```ts
 * const r = await fetchStatus(meet, here.id);
 * if (!r.ok) return;                            // ← 先返回
 * this.poolProbe = { at: real, value: r.pool }; // ← 再记时间
 * ```
 *
 * 服务器一挂，`poolProbe.at` 永远不动，下一轮 `tick`（60 秒）又打一次。
 * **限流形同虚设**：60 分钟一次变成 60 秒一次，放大 60 倍。
 *
 * 68 × 1,440 ≈ 9.8 万 —— 和实际打满的那一刻完全对得上。
 *
 * ## 这条测试守什么
 *
 * 守**顺序**：记录尝试时间必须在 early return 之前。
 * 这不是「代码风格」问题 —— 顺序一反，限流就在服务器最脆弱的时候失效，
 * 把一次故障放大成一次雪崩。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');

test('probeStatus：失败也要记时间 —— 服务器挂掉时下一轮巡检不会立刻重打', async () => {
  let nowMs = Date.parse('2026-11-11T10:00:00Z');
  const dir = mkdtempSync(join(tmpdir(), 'jr-probe-throttle-'));
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, meetUrl: 'https://x.app.tcloudbase.com' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(nowMs),
  });
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('server down', { status: 500 });
  };
  try {
    await w.probeStatus(new Date(nowMs));
    assert.equal(calls, 1, '第一次应该发出请求');
    assert.ok(w.poolProbe && w.poolProbe.at === nowMs, '失败时没记下尝试时间 poolProbe.at');

    // 1 分钟后下一轮巡检：仍在 60 分钟限流窗口内，绝不该重打
    nowMs += 60_000;
    await w.probeStatus(new Date(nowMs));
    assert.equal(calls, 1, '失败后没有限流，下一轮巡检又重打了一次');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('probeStatus：失败时沿用上一次的值，不能写 0 或 NaN', async () => {
  let nowMs = Date.parse('2026-11-11T10:00:00Z');
  const dir = mkdtempSync(join(tmpdir(), 'jr-probe-keep-'));
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, meetUrl: 'https://x.app.tcloudbase.com' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(nowMs),
  });
  let ok = true;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => (ok
    ? new Response(JSON.stringify({ ok: true, pool: 68, mineTaken: 3, list: [] }), { status: 200 })
    : new Response('boom', { status: 500 }));
  try {
    await w.probeStatus(new Date(nowMs));
    assert.equal(w.poolProbe?.value, 68, '成功时应该记下 68');

    // 跨过 60 分钟限流窗口后服务器失败：必须保留上次的 68，不能掉成 0
    ok = false;
    nowMs += 61 * 60_000;
    await w.probeStatus(new Date(nowMs));
    assert.equal(w.poolProbe?.value, 68, `失败分支没有保留旧值（实际：${w.poolProbe?.value}）`);
    assert.equal(w.poolProbe?.taken, 3, 'taken 计数也应该保留旧值');
  } finally {
    globalThis.fetch = origFetch;
  }
});
