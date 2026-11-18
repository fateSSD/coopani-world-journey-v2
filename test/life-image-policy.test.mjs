import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { photoMethods } = await import('../src/world-photo.ts');
const { PhotoBook } = await import('../src/photo-book.ts');
const { cityById } = await import('../src/geo/cities.ts');

function makeCtx(dir, nowMs) {
  const photos = new PhotoBook(dir);
  const ctx = {
    opts: { dataDir: dir },
    cfg: {
      imageUrl: 'http://127.0.0.1:1/mock',
      imageKey: 'test-key',
      imageModel: 'mock',
      imageCast: true,
      imageCastChance: 1,
    },
    photos,
    plan: null,
    st: { phase: 'traveling', cityId: 'chengdu' },
    shooting: false,
    log: null,
    realNow: () => new Date(nowMs),
    photoConfigProblem: () => '',
    readLifeActivityNow: photoMethods.readLifeActivityNow,
    readLifeImagePolicy: photoMethods.readLifeImagePolicy,
    maybePhoto: photoMethods.maybePhoto,
  };
  return { ctx, photos };
}

function writeLifePublic(dir, updatedAtIso, policy, cooldownMin) {
  writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
    schema: 2,
    updatedAt: updatedAtIso,
    imagePolicy: { policy, cooldownMin },
  }));
}

test('imagePolicy=off 时挡住自动拍照（replace=false）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journey-policy-'));
  try {
    const now = Date.parse('2026-11-18T04:00:00Z');
    writeLifePublic(dir, new Date(now - 60_000).toISOString(), 'off', 60);
    const { ctx } = makeCtx(dir, now);
    const city = cityById('chengdu');
    const res = await ctx.maybePhoto(city, 12, '2026-11-18', '宽窄巷子', null, false);
    assert.equal(res.ok, false);
    assert.match(res.reason ?? '', /静默/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('imagePolicy 冷却未到时拦住自动拍照', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journey-policy-'));
  try {
    const now = Date.parse('2026-11-18T04:00:00Z');
    writeLifePublic(dir, new Date(now - 60_000).toISOString(), 'active', 60);
    const { ctx, photos } = makeCtx(dir, now);
    photos.add({
      handle: 'log:prev.png',
      cityId: 'chengdu',
      cityName: '成都',
      dateKey: '2026-11-18',
      title: '上午的宽窄巷子',
      spot: '宽窄巷子',
      at: new Date(now - 10 * 60_000).toISOString(),
    });
    const city = cityById('chengdu');
    const res = await ctx.maybePhoto(city, 12, '2026-11-18', '锦里', null, false);
    assert.equal(res.ok, false);
    assert.match(res.reason ?? '', /60 分钟冷却/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('milestone 同城同日已拍时即使过了冷却也拦住', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journey-policy-'));
  try {
    const now = Date.parse('2026-11-18T04:00:00Z');
    writeLifePublic(dir, new Date(now - 60_000).toISOString(), 'milestone', 30);
    const { ctx, photos } = makeCtx(dir, now);
    photos.add({
      handle: 'log:prev.png',
      cityId: 'chengdu',
      cityName: '成都',
      dateKey: '2026-11-18',
      title: '上午的宽窄巷子',
      spot: '宽窄巷子',
      at: new Date(now - 90 * 60_000).toISOString(),
    });
    const city = cityById('chengdu');
    const res = await ctx.maybePhoto(city, 12, '2026-11-18', '锦里', null, false);
    assert.equal(res.ok, false);
    assert.match(res.reason ?? '', /已经拍过/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('active 且冷却已过允许同城同日再拍，过期 life-public.json 退回 null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journey-policy-'));
  try {
    const now = Date.parse('2026-11-18T04:00:00Z');
    writeLifePublic(dir, new Date(now - 45 * 60_000).toISOString(), 'off', 60);
    const { ctx } = makeCtx(dir, now);
    assert.equal(ctx.readLifeImagePolicy(), null);
    writeLifePublic(dir, new Date(now - 60_000).toISOString(), 'active', 30);
    assert.deepEqual(ctx.readLifeImagePolicy(), { policy: 'active', cooldownMin: 30 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
