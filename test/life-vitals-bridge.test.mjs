import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { pickMode } = await import('../src/plan/journey.ts');
const { planDay } = await import('../src/plan/dayplan.ts');
const { rollLodging } = await import('../src/plan/lodging.ts');
const { cityById } = await import('../src/geo/cities.ts');
const { purseMethods } = await import('../src/world-purse.ts');

test('低精力（effective < 25）时 pickMode 自动避开步行与自行车', () => {
  const from = cityById('suzhou');
  const to = cityById('shanghai');
  for (let i = 0; i < 40; i++) {
    const m = pickMode(from, to, 85, () => (i + 0.5) / 40, false, false, undefined, false, 18);
    assert.ok(m && m.id !== 'walk' && m.id !== 'bike', `不应选到 ${m?.id}`);
  }
});

test('高体质时 dayplan 跳过「脚有点酸」与「走不动」抱怨', () => {
  const city = cityById('chengdu');
  for (let dayIdx = 0; dayIdx < 10; dayIdx++) {
    const plan = planDay({
      city,
      dateKey: `2026-11-${String(10 + dayIdx).padStart(2, '0')}`,
      shape: 'full',
      dayIdx,
      lodging: rollLodging(() => 0.2),
      highFitness: true,
    });
    for (const b of plan.beats) {
      assert.ok(!/脚有点酸|走不动/.test(b.what), `高体质不应出现脚酸文案：${b.what}`);
    }
  }
});

test('低精力放宽景区代步门槛（余钱 200 时低精力放行、正常精力拦住）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journey-vitals-'));
  try {
    const now = Date.parse('2026-11-18T08:00:00Z');
    const makePurse = () => ({
      opts: { dataDir: dir },
      cfg: { moneyEnabled: true, budget: 0 },
      st: { spent: 0, earned: 0 },
      realNow: () => new Date(now),
      lifeAllowance: () => 200,
      purseLeft: purseMethods.purseLeft,
      readLifeVitals: purseMethods.readLifeVitals,
      effectiveLifeEnergy: purseMethods.effectiveLifeEnergy,
      spotSpendOk: purseMethods.spotSpendOk,
    });
    writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
      updatedAt: new Date(now - 60_000).toISOString(),
      vitals: { energy: 80, fitness: 30 },
    }));
    assert.equal(makePurse().spotSpendOk(), false);

    writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
      updatedAt: new Date(now - 60_000).toISOString(),
      vitals: { energy: 20, fitness: 20 },
    }));
    assert.equal(makePurse().spotSpendOk(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queueLifeEffect 可在请客模式（amount=0）写五维与心情条子到 life-spend', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journey-effect-'));
  try {
    writeFileSync(join(dir, 'life-state.json'), '{}');
    const now = Date.parse('2026-11-18T08:00:00Z');
    const ctx = {
      opts: { dataDir: dir },
      realNow: () => new Date(now),
      log: null,
      cleanupSpendTickets: () => {},
      queueLifeSpend: purseMethods.queueLifeSpend,
      queueLifeEffect: purseMethods.queueLifeEffect,
    };
    ctx.queueLifeEffect('大巴过夜', {
      vitalsDelta: { energy: -18 },
      moodlet: { text: '大巴硬坐了一宿，腰背发僵', kind: 'bad', hours: 5 },
    });
    const files = readdirSync(join(dir, 'life-spend')).filter((n) => n.endsWith('.json'));
    assert.equal(files.length, 1);
    const ticket = JSON.parse(readFileSync(join(dir, 'life-spend', files[0]), 'utf8'));
    assert.equal(ticket.amount, 0);
    assert.equal(ticket.vitalsDelta.energy, -18);
    assert.equal(ticket.moodlet.kind, 'bad');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
