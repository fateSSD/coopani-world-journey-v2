/**
 * 座位档 —— 2026-11-06
 *
 * 一位用户来信：「舍不得我家小鱼吃苦，经常逛到腿软，2000 多公里的路程居然选择自驾
 * 30 多小时，劝了好久才换了个好的酒店，结果出行还是硬卧」。
 *
 * 根因不是选项少，是**她只有「换交通方式」这一个手段**：同一趟车没有二等商务之分，
 * 也没有硬卧软卧之分。有了档位，她可以在同一趟车上买到舒服。
 *
 * Mr.Q 定的规矩是「让她自己判断」，所以这里没有「舒适度设置」，
 * 只有三条依据：手上有多少钱、这一趟多长、什么条件都不满足就最省。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pickGrade, buildJourney } = await import('../src/plan/journey.ts');
const { modeById } = await import('../src/geo/modes.ts');
const { cityById } = await import('../src/geo/cities.ts');
const { modeIdOf, seatHintOf } = await import('../src/helpers.ts');
const { publicSnapshot } = await import('../src/bridge.ts');

const train = modeById('train');
const plane = modeById('plane');
const ship = modeById('ship');

test('火车按距离换档：长途是卧铺，短途才是座位', () => {
  const short = train.grades(600).map((g) => g.name);
  const long = train.grades(2000).map((g) => g.name);
  assert.deepEqual(short, ['二等座', '一等座', '商务座']);
  assert.deepEqual(long, ['硬卧', '软卧', '高级软卧']);
});

test('钱紧就只买最低档 —— 一次都不许升', () => {
  // 余钱只够一张半票：升舱等于赌她到站没钱吃饭
  for (let i = 0; i < 200; i++) {
    assert.equal(pickGrade(train, 2000, 1.2).name, '硬卧');
    assert.equal(pickGrade(plane, 2000, 1.2).name, '经济舱');
  }
});

test('钱松又长途：会买到商务座 / 公务舱', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(pickGrade(train, 800, 20).id);
  assert.ok(seen.has('business'), `300 次里一次都没买商务座：${[...seen].join('/')}`);
  const seenPlane = new Set();
  for (let i = 0; i < 300; i++) seenPlane.add(pickGrade(plane, 2000, 20).id);
  assert.ok(seenPlane.has('business-class'), `公务舱一次都没有：${[...seenPlane].join('/')}`);
});

test('短途不买顶档 —— 两个小时的车买商务座不值', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(pickGrade(train, 300, 50).id);
  assert.equal(seen.has('business'), false, '三百公里也买商务座，那不叫舍得，叫乱花');
});

test('不分档的方式返回 undefined，不是崩', () => {
  assert.equal(pickGrade(modeById('walk'), 10, 20), undefined);
  assert.equal(pickGrade(modeById('car'), 500, 20), undefined);
});

test('没记账（purse=null）也能给出一档，不当成没钱', () => {
  const g = pickGrade(train, 1500, null);
  assert.ok(g && g.id, 'null 应该按「不紧不松」算，不是直接回最低档');
});

test('每一档都有 feel —— 没有依据，她只能瞎猜', () => {
  for (const km of [300, 2000]) {
    for (const g of train.grades(km)) {
      assert.ok(g.feel && g.feel.length > 8, `${g.name} 没有体感描述`);
    }
  }
  for (const g of plane.grades(1000)) {
    assert.ok(g.feel && g.feel.length > 8, `${g.name} 没有体感描述`);
  }
  for (const km of [150, 1000]) {
    for (const g of ship.grades(km)) {
      assert.ok(g.feel && g.feel.length > 8, `${g.name} 没有体感描述`);
    }
  }
});

test('轮船按距离分档：短途是渡轮游船，长途含海景阳台房与主题远洋游轮', () => {
  assert.deepEqual(ship.grades(150).map((g) => g.id), ['ferry', 'sightseeing-boat']);
  assert.deepEqual(ship.grades(1000).map((g) => g.id), ['inside-cabin', 'ocean-balcony', 'theme-cruise']);

  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(pickGrade(ship, 500, 15).id);
  assert.ok(seen.has('theme-cruise'), `长途余钱宽裕应能选中主题远洋游轮：${[...seen].join('/')}`);
  assert.equal(pickGrade(ship, 500, 1.2).id, 'inside-cabin', '钱紧时轮船退回客轮内舱房');
});

test('听得懂游轮点名，并把 seatId / seat / seatMult 写入行程与广播快照', () => {
  assert.equal(modeIdOf('坐主题游轮去'), 'ship');
  assert.equal(modeIdOf('我想搭邮轮'), 'ship');
  assert.equal(seatHintOf('迪士尼联名游轮'), 'theme-cruise');
  assert.equal(seatHintOf('海景阳台游轮'), 'ocean-balcony');
  assert.equal(seatHintOf('普通游轮'), 'cruise-prefer');

  const sh = cityById('shanghai');
  const qd = cityById('qingdao');
  const themeGrade = ship.grades(700).find((g) => g.id === 'theme-cruise');
  const leg = buildJourney({
    from: sh, to: qd, mode: ship, km: 700,
    at: new Date('2026-11-23T08:00:00Z'), speed: 1, grade: themeGrade,
  });
  assert.equal(leg.seatId, 'theme-cruise');
  assert.equal(leg.seat, '主题远洋游轮');
  assert.equal(leg.seatMult, 3.2);

  const snap = publicSnapshot({
    worldNow: Date.parse('2026-11-23T09:00:00Z'),
    speed: 1,
    phase: 'traveling',
    city: { id: sh.id, name: sh.name, tz: sh.tz },
    leg: {
      fromId: sh.id, toId: qd.id, fromName: sh.name, toName: qd.name,
      modeId: 'ship', seatId: leg.seatId, seat: leg.seat, seatMult: leg.seatMult,
      departedAt: leg.departedAt, arriveAt: leg.arriveAt,
    },
    money: { enabled: true, budget: 0, spent: 0, earned: 0, unsettledRideFare: 0 },
    diary: { enabled: true, dir: '' },
    applied: [],
    nextStop: null,
  });
  assert.equal(snap.leg.seatId, 'theme-cruise');
  assert.equal(snap.leg.seat, '主题远洋游轮');
  assert.equal(snap.leg.seatMult, 3.2);
});

test('审查回归：uiSnapshot().leg 透出 seatId / seat / seatMult / fare，poor 档轮船权重不低于原基准', async () => {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { JourneyWorld } = await import('../src/world.ts');
  const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
  const { initialState } = await import('../src/state.ts');
  const { pickMode } = await import('../src/plan/journey.ts');

  const dir = mkdtempSync(join(tmpdir(), 'jr-seat-ui-'));
  try {
    const fixedNow = new Date('2026-11-23T09:00:00Z');
    const world = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '上海' },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => fixedNow,
    });
    const sh = cityById('shanghai');
    const qd = cityById('qingdao');
    const themeGrade = ship.grades(700).find((g) => g.id === 'theme-cruise');
    const leg = buildJourney({
      from: sh, to: qd, mode: ship, km: 700,
      at: new Date('2026-11-23T08:00:00Z'), speed: 1, grade: themeGrade,
    });
    world.st = {
      ...initialState('shanghai'),
      phase: 'traveling',
      hereId: sh.id,
      leg: { ...leg, fare: 576 },
    };
    const ui = world.uiSnapshot();
    assert.ok(ui.leg, '在途状态 uiSnapshot().leg 不能为空');
    assert.equal(ui.leg.seatId, 'theme-cruise');
    assert.equal(ui.leg.seat, '主题远洋游轮');
    assert.equal(ui.leg.seatMult, 3.2);
    assert.equal(ui.leg.fare, 576);
    assert.match(ui.leg.code, /主题远洋游轮/, 'ui.leg.code 应带上舱位名');

    const webuiSrc = readFileSync(new URL('../dist/webui.js', import.meta.url), 'utf8');
    assert.match(webuiSrc, /s\.leg\.seat/, 'dist/webui.js 应兜底展示 s.leg.seat');
    assert.match(webuiSrc, /s\.leg\.fare/, 'dist/webui.js 应支持显示 s.leg.fare');

    // 验证 poor 档下中长途轮船仍可被合理选中（权重不低于原本的 1.5/1.4）
    let shipCount = 0;
    for (let i = 0; i < 1000; i++) {
      const m = pickMode(sh, qd, 600, () => (i + 0.5) / 1000, true);
      if (m?.id === 'ship') shipCount++;
    }
    assert.ok(shipCount >= 25, `手头紧时坐普通船仍应保底合理频次（实测 ${shipCount}/1000）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
