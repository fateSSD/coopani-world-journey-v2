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
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/world.ts', import.meta.url), 'utf8');

test('probeStatus：失败也要记时间 —— 赋值必须在 early return 之前', () => {
  const at = src.indexOf('private async probeStatus');
  assert.ok(at > 0, '找不到 probeStatus');
  /*
   * 从函数头往后取一段足够覆盖到 handleInvites 的位置，
   * **并把注释剥掉** —— 函数说明里就抄着那段旧代码（为了讲清为什么这么改），
   * 不剥的话 `indexOf` 命中的是注释里的 `return`，测试会假红。
   */
  const body = src.slice(at, at + 3000)
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//');
    })
    .join('\n');

  const assign = body.indexOf('this.poolProbe = {');
  const early = body.indexOf('if (!r.ok) return;');

  assert.ok(assign > 0, 'probeStatus 里没有更新 poolProbe —— 限流靠什么生效？');
  assert.ok(early > 0, '找不到失败分支，这条测试的前提不成立了');
  assert.ok(
    assign < early,
    'poolProbe 的赋值在 `if (!r.ok) return;` 之后 —— 服务器一挂，'
    + '每轮巡检（60 秒）都会重打一次，60 分钟的限流直接退化成 60 秒。'
    + '2026-11-11 线上就是这么被放大 60 倍、把免费额度打满的。',
  );
});

test('probeStatus：失败时沿用上一次的值，不能写 0 或 NaN', () => {
  const at = src.indexOf('private async probeStatus');
  const body = src.slice(at, at + 3000)
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//');
    })
    .join('\n');
  /*
   * 写入失败时必须保留旧值。写 0 的话，面板上「池子今天 0 只」——
   * 那比旧数字更误导人：用户会以为自己被踢出池子了。
   */
  assert.match(
    body,
    /value:\s*r\.ok\s*\?\s*r\.pool\s*:/,
    '失败分支没有保留旧值 —— 池子数字会掉成 0，看着像「没人了」',
  );
});
