/**
 * 「旅行花她的钱」—— 递条子，不自己扣（2026-11-15）。
 *
 * Mr.Q 的原话：「journey 没开钱（无上限）鱼生这边的钱该怎么算」。
 * 答案不是二选一，是分清两本账：
 *
 * - **这一趟花了多少** → journey 自己的 `spent`（`moneyEnabled` 管）
 * - **这笔谁出** → `payFromLife` 管：关着是他请，打开就从她的钱包扣
 *
 * 而「扣」这件事**不能由 journey 直接做** —— `life-state.json` 只有一个写者。
 * 所以这里只验证递条子这一半；扣钱那一半在 life 的冒烟里（`test/smoke.mjs` [31]）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');

function opts(dir, cfgOver = {}) {
  return {
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', ...cfgOver },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-15T09:00:00Z'),
  };
}

const dirWithLife = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jw-spend-'));
  /* 她在场的事实：life 的那份状态文件在。**判在场不判开关**（卷二十 §4）。 */
  writeFileSync(join(dir, 'life-state.json'), JSON.stringify({ version: 1 }));
  return dir;
};

test('旅行花她的钱：递条子，不写她的状态文件', () => {
  const dir = dirWithLife();
  const w = new JourneyWorld(opts(dir, { payFromLife: true }));
  /* 私有方法在运行时就是普通属性 —— 这条测的是「递没递出去」，不是封装好不好看。 */
  w.addSpent(451, '路费');

  const files = readdirSync(join(dir, 'life-spend')).filter((n) => n.endsWith('.json'));
  assert.equal(files.length, 1, '该递一张条子');
  const one = JSON.parse(readFileSync(join(dir, 'life-spend', files[0]), 'utf8'));
  assert.equal(one.amount, 451);
  assert.equal(one.note, '路费');
  /* 文件名必须等于 id —— 坏文件要靠它回一条 rejected。 */
  assert.equal(files[0], `${one.id}.json`, '文件名要等于 id');

  /* 她的状态文件一个字节都没被写（写者唯一）。 */
  assert.equal(readFileSync(join(dir, 'life-state.json'), 'utf8'), JSON.stringify({ version: 1 }));
});

test('没装 life：不递条子（只有 journey 的人在用自己的预算）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jw-spend-'));
  const w = new JourneyWorld(opts(dir, { payFromLife: true }));
  w.addSpent(120, '路费');
  assert.throws(() => readdirSync(join(dir, 'life-spend')), '不该建这个目录');
});

test('开关关着（默认 = 你请）：也不递条子', () => {
  const dir = dirWithLife();
  const w = new JourneyWorld(opts(dir, { payFromLife: false }));
  w.addSpent(120, '路费');
  assert.throws(() => readdirSync(join(dir, 'life-spend')), '不该建这个目录');
});
