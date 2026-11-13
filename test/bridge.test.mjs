/**
 * 车费桥的纯函数测试（1.1.0）。
 *
 * ## 为什么不启动 World
 *
 * 一旦把结算写进 `world.ts`，就只能靠「跑一整天看她花没花对钱」来验，
 * 一轮改动十分钟，而且红了还看不出是哪一步。这里喂数组、看数组，
 * 一秒跑完，红了直接指到函数。
 *
 * ## 每个用例盯的都是**会重复扣钱**或**会永久堆积**的那一类错
 *
 * 少加一次钱用户看不出来（余额偏乐观），多加一次他一定看得出来（钱没了）。
 * 所以「同一条只加一次」和「坏记录也要回传」比「正常路径」更该有测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BRIDGE_SCHEMA, APPLIED_KEEP, FARE_MAX, PENDING_STALE_MS,
  readPending, validateRide, settle, publicSnapshot, rideParagraph, parseLive, settledWindow,
} from '../src/bridge.ts';

const TZ = 'Asia/Shanghai';
const CITY = 'luoyang';
/** 2026-11-09T12:30:00Z = 洛阳 20:30，归 11-09。 */
const AT = '2026-11-09T12:30:00.000Z';
const AT_MS = Date.parse(AT);
const TRIP_START = '2026-10-31T10:25:01.249Z';

const ctx = {
  tripStartedAt: TRIP_START,
  worldNow: AT_MS + 60_000,
  cityExists: (id) => id === CITY,
  tzOf: () => TZ,
};

/** 造一条待结算单，不落盘。 */
const pend = (over = {}, fileId = 'ride-a') => ({
  id: fileId,
  path: `x/${fileId}.json`,
  mtimeMs: AT_MS + 60_000,
  broken: false,
  value: {
    schema: BRIDGE_SCHEMA,
    id: fileId,
    at: AT,
    cityId: CITY,
    fare: 54,
    kind: 'normal',
    note: '洛阳 当前位置 → 龙门石窟，9.7 公里。',
    ...over,
  },
});

const baseSettle = (pending, over = {}) => settle({
  pending,
  applied: [],
  spent: 1000,
  moneyEnabled: true,
  budget: 6000,
  tripStartedAt: TRIP_START,
  worldNow: AT_MS + 60_000,
  realNow: AT_MS + 60_000,
  cityExists: ctx.cityExists,
  tzOf: ctx.tzOf,
  ...over,
});

test('正常一条：入账一次，回传 applied', () => {
  const r = baseSettle([pend()]);
  assert.equal(r.spent, 1054);
  assert.equal(r.settledCount, 1);
  assert.deepEqual(settledWindow(r.applied), [{ id: 'ride-a', status: 'applied' }]);
  assert.equal(r.applied[0].dateKey, '2026-11-09');
  assert.equal(r.notices.length, 0);
});

test('同一个 id 再来一遍：不重复扣', () => {
  const first = baseSettle([pend()]);
  const again = settle({
    pending: [pend()],
    applied: first.applied,
    spent: first.spent,
    moneyEnabled: true,
    budget: 6000,
    tripStartedAt: TRIP_START,
    worldNow: AT_MS + 60_000,
    realNow: AT_MS + 60_000,
    cityExists: ctx.cityExists,
    tzOf: ctx.tzOf,
  });
  assert.equal(again.spent, 1054, '重复文件不能再加一次');
  assert.equal(again.settledCount, 0);
  assert.equal(again.applied.length, 1, '判重表不该长出第二条');
});

test('fare 同时超过上限和预算：判非法，不进 spent', () => {
  const r = baseSettle([pend({ fare: 90000 }, 'ride-high')]);
  assert.equal(r.spent, 1000, '非法记录一分钱都不能记');
  assert.equal(r.applied[0].status, 'rejected');
  assert.equal(r.applied[0].reason, 'fare');
  assert.equal(r.notices[0].kind, 'rejected');
});

test('schema 不认识：拒收并留下痕迹', () => {
  const r = baseSettle([pend({ schema: 99 }, 'ride-schema')]);
  assert.equal(r.applied[0].status, 'rejected');
  assert.equal(r.applied[0].reason, 'schema');
  assert.equal(r.spent, 1000);
  assert.equal(r.notices.length, 1, '静默跳过是最难查的一种错');
});

test('at 早于行程开始：拒收', () => {
  const early = new Date(Date.parse(TRIP_START) - 86_400_000).toISOString();
  const r = baseSettle([pend({ at: early }, 'ride-early')]);
  assert.equal(r.applied[0].reason, 'before-trip');
  assert.equal(r.spent, 1000);
});

test('at 在未来：用当前世界时刻盖掉，并记 atClamped', () => {
  const future = new Date(AT_MS + 10 * 60_000).toISOString();
  const r = baseSettle([pend({ at: future }, 'ride-future')]);
  assert.equal(r.applied[0].status, 'applied');
  assert.equal(r.applied[0].atClamped, true);
  assert.equal(r.applied[0].at, new Date(ctx.worldNow).toISOString());
});

test('文件名和 id 不一致：拒收（防手改过的文件）', () => {
  const bad = pend({ id: 'ride-other' }, 'ride-a');
  const r = baseSettle([bad]);
  assert.equal(r.applied[0].reason, 'id');
});

test('超过预算 10%：照记 + 提醒，不拒收', () => {
  const r = baseSettle([pend({ fare: 900 }, 'ride-odd')], { budget: 3000 });
  assert.equal(r.spent, 1900);
  assert.equal(r.applied[0].status, 'applied');
  assert.equal(r.notices[0].kind, 'odd');
});

test('记账关着：照结算、进判重表，但不动 spent', () => {
  const r = baseSettle([pend()], { moneyEnabled: false });
  assert.equal(r.spent, 1000);
  assert.equal(r.applied[0].status, 'applied');
});

test('空目录空表：不抛错、不产生事件', () => {
  const r = baseSettle([]);
  assert.equal(r.spent, 1000);
  assert.equal(r.applied.length, 0);
  assert.equal(r.notices.length, 0);
});

test('判重表按容量滚动，不无限长', () => {
  const many = Array.from({ length: APPLIED_KEEP + 20 }, (_, i) => pend({}, `ride-${i}`));
  const r = baseSettle(many);
  assert.equal(r.applied.length, APPLIED_KEEP);
  assert.equal(r.spent, 1000 + 54 * (APPLIED_KEEP + 20));
});

test('额外的字段一律丢掉，不进 state', () => {
  const r = baseSettle([pend({
    car: '比亚迪秦 PLUS', plate: '豫C·D20387', rarity: 'legendary', insideAccess: true,
  }, 'ride-extra')]);
  const row = r.applied[0];
  for (const k of ['car', 'plate', 'rarity', 'insideAccess']) {
    assert.equal(k in row, false, `${k} 不该被存下来`);
  }
});

test('日记段落：同一天调两次结果完全一样，不叠加', () => {
  const r = baseSettle([pend()]);
  const a = rideParagraph(r.applied, '2026-11-09');
  const b = rideParagraph(r.applied, '2026-11-09');
  assert.equal(a, b);
  assert.equal(a.includes('龙门石窟'), true);
  assert.equal(a.includes('54 块'), true);
  assert.equal(rideParagraph(r.applied, '2026-11-10'), '', '别的日子一条都不该有');
});

test('日记段落：被拒的记录不进正文', () => {
  const r = baseSettle([pend({ fare: 90000 }, 'ride-high')]);
  assert.equal(rideParagraph(r.applied, '2026-11-09'), '');
});

test('日记段落：超过三条只引前三条', () => {
  const rows = ['a', 'b', 'c', 'd'].map((k) => pend({}, `ride-${k}`));
  const r = baseSettle(rows);
  const p = rideParagraph(r.applied, '2026-11-09');
  assert.equal(p.includes('叫了 4 次车'), true);
  assert.equal(p.includes('还有 1 次没说'), true);
});

test('日记段落：note 自带句号时不出现「。）。」这种拼接', () => {
  const r = baseSettle([pend({ note: '从住处到龙门石窟，9.7 公里。' }, 'ride-note')]);
  const p = rideParagraph(r.applied, '2026-11-09');
  assert.equal(p.includes('公里。。'), false);
  assert.equal(p.includes('车费 54 块。'), true);
});

test('公开快照：remaining 扣掉未结算车费，能力位与记账位分开', () => {
  const snap = publicSnapshot({
    worldNow: AT_MS, speed: 1, phase: 'staying',
    city: { id: CITY, name: '洛阳', tz: TZ },
    leg: null,
    money: { enabled: true, budget: 6000, spent: 1234, earned: 0, unsettledRideFare: 54 },
    diary: { enabled: true, dir: 'D:/diary' },
    applied: [{ id: 'ride-a', at: AT, fare: 54, dateKey: '2026-11-09', status: 'applied' }],
  });
  assert.equal(snap.money.remaining, 6000 - 1234 - 54);
  assert.equal(snap.rides.supported, true);
  assert.equal(snap.rides.spendEnabled, true);
  assert.equal(snap.clock.worldNow, new Date(AT_MS).toISOString());
  assert.equal(snap.leg, null);
});

test('公开快照：记账关着 = supported true + spendEnabled false + remaining null', () => {
  const snap = publicSnapshot({
    worldNow: AT_MS, speed: 1, phase: 'home',
    city: { id: CITY, name: '洛阳', tz: TZ },
    leg: null,
    money: { enabled: false, budget: 0, spent: 0, earned: 0, unsettledRideFare: 0 },
    diary: { enabled: false, dir: '' },
    applied: [],
  });
  assert.equal(snap.rides.supported, true);
  assert.equal(snap.rides.spendEnabled, false);
  assert.equal(snap.money.remaining, null);
});

test('首页卡：正常/过期/未激活三种', () => {
  const live = {
    schema: 1, active: true, id: 'ride-live', status: 'assigned',
    car: '比亚迪秦 PLUS', plate: '豫C·D20387', from: '当前位置', to: '龙门石窟',
    cityName: '洛阳', fare: 54, progress: 20,
    secondsToPickup: 180, secondsToDropoff: 300,
    expiresAt: new Date(AT_MS + 5 * 60_000).toISOString(),
  };
  assert.equal(parseLive(live, AT_MS).to, '龙门石窟');
  assert.equal(parseLive(live, AT_MS + 6 * 60_000), null, '过期必须自己消失，不等对方写 active:false');
  assert.equal(parseLive({ ...live, active: false }, AT_MS), null);
  assert.equal(parseLive({ ...live, schema: 99 }, AT_MS), null);
});

test('首页卡：包车与叫车靠 service 分开，缺了就当叫车', () => {
  /*
   * 2026-11-11 鱼鱼出行来信：包车订单的车费、车型都是包车的，
   * 卡上却一直写「正在打车」—— 因为 `service` 原来根本没进来。
   *
   * 契约上它是**可选**字段：缺了、空了、没见过的值，一律按叫车显示。
   */
  const base = {
    schema: 1, active: true, id: 'ride-c', status: 'assigned', cityName: '洛阳',
    car: '比亚迪秦 PLUS', plate: '豫C·T48329', fare: 456,
    expiresAt: new Date(AT_MS + 5 * 60_000).toISOString(),
  };
  assert.equal(parseLive({ ...base, service: 'charter' }, AT_MS).service, 'charter');
  assert.equal(parseLive({ ...base, service: 'hailing' }, AT_MS).service, 'hailing');
  assert.equal(parseLive(base, AT_MS).service, '', '旧文件没有这一格，读成空串');
  assert.equal(parseLive({ ...base, service: 'spaceship' }, AT_MS).service, 'spaceship',
    '不认识的值也原样透传，由前端决定怎么显示（只有 charter 才画成包车）');
});

test('读目录：不存在算空，坏 JSON 用文件名当 id 回传', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
  const empty = readPending(dir);
  assert.deepEqual(empty.files, []);
  assert.equal(empty.problem, null);

  const pdir = join(dir, 'ride-pending');
  mkdirSync(pdir);
  writeFileSync(join(pdir, 'ride-ok.json'), JSON.stringify({
    schema: 1, id: 'ride-ok', at: AT, cityId: CITY, fare: 54, kind: 'normal', note: '',
  }));
  writeFileSync(join(pdir, 'ride-broken.json'), '{ 这不是 JSON');

  const got = readPending(dir);
  assert.equal(got.files.length, 2);
  const broken = got.files.find((f) => f.id === 'ride-broken');
  assert.equal(broken.broken, true, '坏文件也得回传，否则对方永远删不掉');
  const v = validateRide(broken, ctx);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'unreadable');
});

test('读目录：躺了 30 天以上的单判过期，不查内容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-stale-'));
  const pdir = join(dir, 'ride-pending');
  mkdirSync(pdir);
  const file = join(pdir, 'ride-old.json');
  writeFileSync(file, JSON.stringify({
    schema: 1, id: 'ride-old', at: AT, cityId: CITY, fare: 54, kind: 'normal', note: '',
  }));
  const oldSec = (AT_MS - PENDING_STALE_MS - 86_400_000) / 1000;
  utimesSync(file, oldSec, oldSec);

  const got = readPending(dir);
  const r = baseSettle(got.files);
  assert.equal(r.applied[0].status, 'rejected');
  assert.equal(r.applied[0].reason, 'stale');
});

test('单笔上限是 20000：刚好等于可以，多一块不行', () => {
  assert.equal(baseSettle([pend({ fare: FARE_MAX }, 'ride-max')]).spent, 1000 + FARE_MAX);
  assert.equal(baseSettle([pend({ fare: FARE_MAX + 1 }, 'ride-over')]).applied[0].reason, 'fare');
});
