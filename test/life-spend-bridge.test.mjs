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
const { JOURNEY_DEFAULTS, journeyConfigGroups } = await import('../src/config.ts');

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

test('请客模式（payFromLife=false）：不受鱼生余额为 0 限制，提示明确由他出钱且面板标为你请客', () => {
  const dir = dirWithLife();
  writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
    schema: 2, asleepUntil: '', ledger: { cash: 0, travelAllowance: 0 },
  }));
  const w = new JourneyWorld(opts(dir, { payFromLife: false, budget: 0 }));
  w.st = { ...w.st, spent: 207 };
  assert.equal(w.purseLeft(), null);
  assert.equal(w.purseStage(), 'ok');
  const money = w.moneyLine();
  const travel = w.purseTravelLine();
  assert.match(money, /由他出钱（不扣你的钱包）/);
  assert.doesNotMatch(money, /还能动用/);
  assert.match(travel, /由他出钱（不扣你的钱包）/);
  assert.doesNotMatch(travel, /见底|还能动用/);

  const badges = w.settingBadges();
  const treat = badges.find((b) => b.label === '你请客');
  assert.ok(treat, '请客模式下设置页徽章应标为「你请客」而非「花销」');
  assert.equal(treat.value, '207 元');
  const snap = w.uiSnapshot();
  assert.equal(snap.trip.payFromLife, false);
});

test('请客模式下直接调 queueLifeSpend 不写扣款条子，纯状态 queueLifeEffect 仍正常保留', () => {
  const dir = dirWithLife();
  const w = new JourneyWorld(opts(dir, { payFromLife: false }));
  w.queueLifeSpend(200, '路费');
  assert.throws(() => readdirSync(join(dir, 'life-spend')), '请客模式下 amount>0 不得落盘扣款条子');

  w.queueLifeEffect('逛景点', { vitalsDelta: { fun: 10 } });
  const files = readdirSync(join(dir, 'life-spend')).filter((n) => n.endsWith('.json'));
  assert.equal(files.length, 1);
  const one = JSON.parse(readFileSync(join(dir, 'life-spend', files[0]), 'utf8'));
  assert.equal(one.amount, 0);
  assert.equal(one.vitalsDelta.fun, 10);
});

test('运行中将 payFromLife 热切为 false 时 tick() 清掉未结算扣款条子并保留纯状态条子；配置均含 x-hot', async () => {
  const life = journeyConfigGroups().find((g) => g.id === 'journey.life');
  for (const key of ['worlds.journey.moneyEnabled', 'worlds.journey.payFromLife']) {
    const prop = life?.schema.properties[key];
    assert.ok(prop, `缺少 ${key}`);
    assert.equal(prop['x-hot'], true, `${key} 须声明 x-hot: true`);
    assert.doesNotMatch(prop.description ?? '', /\*/, `${key} 描述不应含 markdown 星号`);
  }

  const dir = dirWithLife();
  const w = new JourneyWorld(opts(dir, { payFromLife: true }));
  await w.start({
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => ({ ...e, cursor: 1, blobs: [] }),
    store: {},
    drainPendingEvents: async () => [],
    modelFacts: { accepts: () => true },
  });
  w.addSpent(300, '酒店');
  w.queueLifeEffect('旅途早饭', { vitalsDelta: { food: 22 } });
  assert.equal(readdirSync(join(dir, 'life-spend')).length, 2);

  // 热切换为请客模式 -> tick() 自动清理尚未结算的正数扣款条子
  w.cfg.payFromLife = false;
  await w.tick();
  const left = readdirSync(join(dir, 'life-spend')).filter((n) => n.endsWith('.json'));
  assert.equal(left.length, 1, '正数扣款条子应被清理，仅保留 amount===0 状态反哺条子');
  const remained = JSON.parse(readFileSync(join(dir, 'life-spend', left[0]), 'utf8'));
  assert.equal(remained.amount, 0);
  assert.equal(remained.note, '旅途早饭');
});
