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

test('火车按距离换档：长途是卧铺，600 公里起含全景观光专列，短途才是座位', () => {
  const veryShort = train.grades(300).map((g) => g.name);
  const short = train.grades(600).map((g) => g.name);
  const long = train.grades(2000).map((g) => g.name);
  assert.deepEqual(veryShort, ['二等座', '一等座', '商务座']);
  assert.deepEqual(short, ['二等座', '一等座', '商务座', '全景观光专列']);
  assert.deepEqual(long, ['硬卧', '软卧', '高级软卧', '全景观光专列']);
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
  assert.equal(pickGrade(modeById('bike'), 40, 20), undefined);
  assert.equal(pickGrade(modeById('car'), 150, 20), undefined);
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

test('二期（P2）：全景观光专列（scenic-train）选档、文案、拍照提示词与过夜反哺', async () => {
  const { roadText } = await import('../src/helpers.ts');
  const { photoPrompt } = await import('../src/photo.ts');
  const { buildPhotoFacts } = await import('../src/photo-facts.ts');

  const g800 = train.grades(800);
  const scenic800 = g800.find((g) => g.id === 'scenic-train');
  assert.ok(scenic800 && scenic800.mult === 3.6, 'train >= 600km 应包含 mult=3.6 的全景观光专列');

  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(pickGrade(train, 1200, 15, () => (i + 0.5) / 300).id);
  assert.ok(seen.has('scenic-train'), `余钱充裕的长途应能选中全景观光专列：${[...seen].join('/')}`);
  assert.equal(pickGrade(train, 1200, 1.2).id, 'hard-sleeper', '钱紧时退回硬卧');

  assert.equal(modeIdOf('坐全景观光专列去'), 'train');
  assert.equal(modeIdOf('我想搭冰川快车'), 'train');
  assert.equal(seatHintOf('全景观光专列'), 'scenic-train');
  assert.equal(seatHintOf('冰川快车'), 'scenic-train');

  const cd = cityById('chengdu');
  const ls = cityById('lasa');
  const leg = buildJourney({
    from: cd, to: ls, mode: train, km: 1200,
    at: new Date('2026-11-24T08:00:00Z'), speed: 1, grade: scenic800,
  });
  const midDay = roadText('train', 1, leg, cd, ls, 14, 0.5);
  assert.match(midDay, /全景餐车|峡谷与旷野/);
  assert.doesNotMatch(midDay, /鱼|虾|蟹|海鲜|生鱼/);

  const prompt = photoPrompt({
    city: '拉萨', cityId: 'lasa', onRoad: true, mode: '全景观光专列',
    hour: 14, month: 11, day: 24, minimal: true,
  });
  assert.match(prompt, /全景窗.*雪山|森林|旷野/);
  const facts = buildPhotoFacts({
    city: ls, hour: 14, month: 11, day: 24, onRoad: true, mode: '全景观光专列',
  });
  assert.match(facts.placeLabel, /全景观光专列.*雪山|森林|旷野/);
});

test('二期（P2）：房车自驾（campervan）分档、驾照门控联动、营地露营过夜省房费与持久化', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { JourneyWorld } = await import('../src/world.ts');
  const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
  const { StateStore, initialState } = await import('../src/state.ts');
  const { camperLodging, rollLodging } = await import('../src/plan/lodging.ts');
  const { roadText } = await import('../src/helpers.ts');

  const car = modeById('car');
  assert.deepEqual(car.grades(200), [], 'car < 300km 不分档');
  const grades400 = car.grades(400);
  assert.deepEqual(grades400.map((g) => g.id), ['standard-car', 'campervan']);
  assert.equal(grades400.find((g) => g.id === 'campervan')?.mult, 1.5);
  assert.equal(pickGrade(car, 500, 1.2).id, 'standard-car');
  assert.equal(modeIdOf('开房车去玩'), 'car');
  assert.equal(seatHintOf('开房车去玩'), 'campervan');

  const cd = cityById('chengdu');
  const kmCity = cityById('kunming');
  const camperGrade = grades400.find((g) => g.id === 'campervan');
  const leg = buildJourney({
    from: cd, to: kmCity, mode: car, km: 800,
    at: new Date('2026-11-24T08:00:00Z'), speed: 1, grade: camperGrade,
  });
  const midCamp = roadText('car', 1, leg, cd, kmCity, 13, 0.5);
  assert.match(midCamp, /房车便携灶台|营地/);
  assert.doesNotMatch(midCamp, /鱼|虾|蟹|海鲜/);

  const campLod = camperLodging(kmCity.priceIdx, false);
  const hotelLod = rollLodging(() => 0.7, false, kmCity.priceIdx, false, false);
  assert.equal(campLod.kind, '房车营地露营过夜');
  assert.ok(campLod.price < hotelLod.price, `房车营地过夜（${campLod.price}）应显著省于同城酒店（${hotelLod.price}）`);

  const dir = mkdtempSync(join(tmpdir(), 'jr-camper-'));
  const origFetch = globalThis.fetch;
  let wNoLic;
  try {
    let fixedNow = new Date('2026-11-24T08:00:00Z');
    new StateStore(dir).save({ ...initialState('lanzhou'), phase: 'home', hereId: 'lanzhou' });
    globalThis.fetch = async () => { throw new Error('offline'); };
    const fakeHost = {
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e) => ({ ...e, blobs: [] }),
      pushDeferred() {},
      store: {},
      drainPendingEvents: async () => [],
    };
    wNoLic = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', hasLicense: false },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => fixedNow,
    });
    await wNoLic.start(fakeHost);
    const goTo = wNoLic.tools().find((t) => t.name === 'journey_go_to').handler;
    const hotelNightTool = wNoLic.tools().find((t) => t.name === 'journey_hotel_night').handler;

    const blocked = await goTo({ city: '成都', mode: '房车' });
    assert.equal(blocked.isError, true);
    assert.match(String(blocked.text), /驾照/);

    // 兼容旧版 life-public.json（缺 certs 字段）时，回退读取 life-state.json.job.certs
    writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
      schema: 2,
      updatedAt: fixedNow.toISOString(),
    }), 'utf8');
    writeFileSync(join(dir, 'life-state.json'), JSON.stringify({
      job: { certs: ['驾照'] },
    }), 'utf8');
    assert.equal(wNoLic.effectiveHasLicense(), true, '旧版 life-public.json 缺 certs 时应回退识别 life-state.json 中的驾照');

    // 新版 life-public.json 若显式声明 certs: []，必须以公开广播为准返回 false（不穿透旧状态）
    writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
      schema: 2,
      updatedAt: fixedNow.toISOString(),
      certs: [],
    }), 'utf8');
    assert.equal(wNoLic.effectiveHasLicense(), false, '新版 life-public.json 显式写 certs:[] 时应以公开广播为准');

    // 生活层考下驾照后广播进 life-public.json，即便 journey 设置未开 hasLicense 也应放行房车自驾并落盘 camper=true
    writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
      schema: 2,
      updatedAt: fixedNow.toISOString(),
      certs: ['驾照'],
    }), 'utf8');
    assert.equal(wNoLic.effectiveHasLicense(), true);
    const goRes = await goTo({ city: '成都', mode: '房车' });
    assert.notEqual(goRes.isError, true, String(goRes.text));
    assert.equal(wNoLic.st.leg?.modeId, 'car');
    assert.equal(wNoLic.st.leg?.seatId, 'campervan');
    assert.equal(wNoLic.st.car?.camper, true);

    // 验证重启读档保持 car.camper 且到站排程走房车营地过夜
    const reloaded = new StateStore(dir).load('lanzhou').state;
    assert.equal(reloaded.car?.camper, true, 'StateStore.load 必须保留 car.camper');

    wNoLic.hotels.hotels = async () => [];
    wNoLic.weather.forecast = async () => null;
    wNoLic.st = {
      ...wNoLic.st,
      phase: 'staying',
      hereId: 'chengdu',
      leg: null,
      stayStartedAt: fixedNow.toISOString(),
      stayDateKey: '2026-11-24',
      lodging: null,
    };
    await wNoLic.rebuildPlan(fixedNow, 'arrival', 10, cd);
    assert.equal(wNoLic.plan?.lodging.kind, '房车营地露营过夜');
    assert.deepEqual(wNoLic.plan?.lodging.amen, ['camper']);
    assert.match(wNoLic.nowSummary(), /房车.*营地过夜省房费/);

    // 房车营地夜间独立项（不套酒店泡澡/房间窗帘，并兼容无 amen 老房车存档）
    const { hotelNightOptions, hotelEvening } = await import('../src/plan/leisure.ts');
    const campOpts = hotelNightOptions(campLod.tier, campLod.amen, [], '', campLod.kind);
    const legacyCampOpts = hotelNightOptions('view', [], [], '', '房车营地露营过夜');
    for (const opts of [campOpts, legacyCampOpts]) {
      assert.deepEqual(opts.map((o) => o.label), ['营地看星空', '车里煮面', '营地散步']);
      const joined = opts.map((o) => `${o.label}:${o.text}`).join('|');
      assert.doesNotMatch(joined, /泡澡|浴缸|在房间待着|窗帘/);
    }
    const campEve = hotelEvening('view', 123, true, [], [], '', '房车营地露营过夜');
    assert.ok(campEve && ['营地看星空', '车里煮面', '营地散步'].includes(campEve.item));
    fixedNow = new Date('2026-11-24T12:00:00Z'); // 北京 20:00
    const bathDeny = await hotelNightTool({ what: '泡澡' });
    assert.equal(bathDeny.isError, true);
    assert.doesNotMatch(String(bathDeny.text), /在房间待着/);
    const starOk = await hotelNightTool({ what: '营地看星空' });
    assert.notEqual(starOk.isError, true, String(starOk.text));
    assert.match(String(starOk.text), /天窗|夜空/);
  } finally {
    wNoLic?.stop?.();
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('二期（P2）：内河游轮（river-cruise）与远洋海港航线区分、点名、途中文案与拍照场景', async () => {
  const { isInlandRiverRoute, gradesFor } = await import('../src/plan/journey.ts');
  const { roadText } = await import('../src/helpers.ts');
  const { photoPrompt } = await import('../src/photo.ts');

  const cq = cityById('chongqing');
  const yc = cityById('yichang');
  const wh = cityById('wuhan');
  const nj = cityById('nanjing');
  const sh = cityById('shanghai');
  const qd = cityById('qingdao');
  const tok = cityById('tokyo');
  const sy = cityById('sanya');
  const gz = cityById('guangzhou');

  assert.equal(isInlandRiverRoute(cq, yc), true, '重庆↔宜昌应判为内河游轮航线');
  assert.equal(isInlandRiverRoute(cq, wh), true, '重庆↔武汉应判为内河游轮航线');
  assert.equal(isInlandRiverRoute(wh, nj), true, '武汉↔南京应判为内河游轮航线');
  assert.equal(isInlandRiverRoute(sh, qd), false, '上海↔青岛不得判为内河游轮');
  assert.equal(isInlandRiverRoute(sh, tok), false, '上海↔东京跨海不得判为内河游轮');
  assert.equal(isInlandRiverRoute(gz, sy), false, '广州↔三亚沿海航线不得判为内河游轮');

  const riverGrades = gradesFor(ship, 600, { from: cq, to: wh });
  assert.deepEqual(riverGrades.map((g) => g.id), ['inside-cabin', 'river-cruise']);
  assert.equal(riverGrades.some((g) => g.id === 'theme-cruise'), false, '内河航线不应混入主题远洋游轮');

  const seaGrades = gradesFor(ship, 700, { from: sh, to: qd });
  assert.deepEqual(seaGrades.map((g) => g.id), ['inside-cabin', 'ocean-balcony', 'theme-cruise']);

  assert.equal(modeIdOf('坐三峡河轮去宜昌'), 'ship');
  assert.equal(seatHintOf('内河游轮'), 'river-cruise');

  const riverGrade = riverGrades.find((g) => g.id === 'river-cruise');
  const leg = buildJourney({
    from: cq, to: yc, mode: ship, km: 550,
    at: new Date('2026-11-24T08:00:00Z'), speed: 1, grade: riverGrade,
  });
  const midDay = roadText('ship', 1, leg, cq, yc, 14, 0.5);
  const midNight = roadText('ship', 1, leg, cq, yc, 22, 0.5);
  assert.match(midDay, /河轮.*两岸|峡谷|山坡/);
  assert.match(midNight, /河轮.*灯火|山影/);
  assert.doesNotMatch(midDay + midNight, /鱼|虾|蟹|海鲜/);

  const prompt = photoPrompt({
    city: '宜昌', cityId: 'yichang', onRoad: true, mode: '内河峡谷游轮',
    hour: 22, month: 11, day: 24, minimal: true,
  });
  assert.match(prompt, /两岸山影.*灯火|江面/);
});

test('游轮/专列未开记账（purse=null）不再 0% 锁死，双港口选船与长途船票分档合理，港口提示透出', async () => {
  const { pickMode } = await import('../src/plan/journey.ts');
  const { JourneyWorld } = await import('../src/world.ts');
  const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
  const { StateStore, initialState } = await import('../src/state.ts');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  // 1) purse=null 时，theme-cruise 与 scenic-train 均不再被 0% 锁死
  const shipNullGrades = new Set();
  const trainNullGrades = new Set();
  for (let i = 0; i < 200; i++) {
    shipNullGrades.add(pickGrade(ship, 800, null, () => (i + 0.5) / 200).id);
    trainNullGrades.add(pickGrade(train, 1200, null, () => (i + 0.5) / 200).id);
  }
  assert.ok(shipNullGrades.has('theme-cruise'), `purse=null 时长途船应能随出 theme-cruise：${[...shipNullGrades].join('/')}`);
  assert.ok(trainNullGrades.has('scenic-train'), `purse=null 时长途火车应能随出 scenic-train：${[...trainNullGrades].join('/')}`);

  // 2) 开启记账门槛降至 p >= 3.4
  const ship36 = new Set();
  for (let i = 0; i < 100; i++) ship36.add(pickGrade(ship, 800, 3.6, () => (i + 0.5) / 100).id);
  assert.ok(ship36.has('theme-cruise'), 'p=3.6 应能买到主题远洋游轮');

  // 3) 正常预算双港口选船不受 slowness 错杀
  const sh = cityById('shanghai');
  const qd = cityById('qingdao');
  let shipPicked = 0;
  for (let i = 0; i < 1000; i++) {
    const m = pickMode(sh, qd, 600, () => (i + 0.5) / 1000, false);
    if (m?.id === 'ship') shipPicked++;
  }
  assert.ok(shipPicked >= 120, `正常预算上海↔青岛双港口选船频次应显著提升（实测 ${shipPicked}/1000）`);

  // 4) 长途船票分段定价（300km 内 0.7/km，超出部分 0.35/km）、wishes 广播与港口提示
  const dir = mkdtempSync(join(tmpdir(), 'journey-ship-tier-'));
  try {
    const st = { ...initialState('shanghai'), wishes: ['zhoushan'] };
    new StateStore(dir).save(st);
    const w = new JourneyWorld({ cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeId: 'shanghai' }, dataDir: dir });
    w.st = st;
    assert.equal(w.fareOf('ship', 200, false, 1), 140);
    assert.equal(w.fareOf('ship', 1000, false, 1), 455);
    assert.match(w.nowSummary(), /港口码头.*游轮或河轮/);
    const pub = publicSnapshot({
      worldNow: Date.now(), speed: 1, phase: 'home', city: sh, leg: null,
      money: { enabled: true, budget: 2000, spent: 0, earned: 0, unsettledRideFare: 0 },
      diary: { enabled: true, dir }, applied: [], nextStop: null, wishes: ['舟山'],
    });
    assert.deepEqual(pub.wishes, ['舟山']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同开模拟鱼生时严格认生活驾照（忽略 hasLicense=true），生病静养期间禁止从家出发', async () => {
  const { JourneyWorld } = await import('../src/world.ts');
  const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'jr-life-gate-'));
  const fixedNow = new Date('2026-11-28T10:00:00+08:00');
  try {
    writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
      schema: 2,
      updatedAt: fixedNow.toISOString(),
      certs: [],
      sickUntil: new Date(fixedNow.getTime() + 18 * 3_600_000).toISOString(),
      sickReason: '过劳静养。需要闭门休息。',
    }), 'utf8');

    const w = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', hasLicense: true, moneyEnabled: false },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => fixedNow,
    });
    await w.start({
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e) => ({ ...e, blobs: [] }),
      pushDeferred() {},
      store: {},
      drainPendingEvents: async () => [],
    });

    assert.equal(w.effectiveHasLicense(), false, '同开 life 且未持驾照时必须忽略 cfg.hasLicense=true');

    const goTo = w.tools().find((t) => t.name === 'journey_go_to').handler;
    const sickGo = await goTo({ city: '成都', mode: 'train' });
    assert.equal(sickGo.isError, true, '生病静养期应禁止从家出发');
    assert.match(String(sickGo.text), /生病静养/);

    await w.depart(fixedNow);
    assert.equal(w.st.phase, 'home', 'tick/depart 自动出发在生病静养期也应留在家里');
    await assert.rejects(() => w.panelInvoke('now', 'depart', []), /生病静养/);

    // 病愈到期但仍未考驾照：允许坐火车出门，但禁止自驾/开房车
    writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
      schema: 2,
      updatedAt: fixedNow.toISOString(),
      certs: [],
      sickUntil: '',
      sickReason: '',
    }), 'utf8');

    const noLicDrive = await goTo({ city: '成都', mode: '房车' });
    assert.equal(noLicDrive.isError, true, '病愈但无驾照应仍拦住自驾/房车');
    assert.match(String(noLicDrive.text), /没考下驾照/);

    // 考下驾照后立即放行自驾
    writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
      schema: 2,
      updatedAt: fixedNow.toISOString(),
      certs: ['驾照'],
      sickUntil: '',
      sickReason: '',
    }), 'utf8');
    assert.equal(w.effectiveHasLicense(), true);
    const driveOk = await goTo({ city: '成都', mode: 'car' });
    assert.notEqual(driveOk.isError, true, String(driveOk.text));
    assert.equal(w.st.leg?.modeId, 'car');

    await w.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('4x倍速 worldNow 超前下 sickUntil 仍拦截全部出门与 takeInvite，超过24h旧 life-public 不锁死单机驾照', async () => {
  const { JourneyWorld } = await import('../src/world.ts');
  const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'jr-p0-clock-'));
  const fixedReal = new Date('2026-11-28T10:00:00+08:00');
  try {
    writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
      schema: 2,
      updatedAt: fixedReal.toISOString(),
      certs: [],
      sickUntil: new Date(fixedReal.getTime() + 24 * 3_600_000).toISOString(),
      sickReason: '过劳静养中',
    }), 'utf8');

    const w = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', speed: 4, hasLicense: true, moneyEnabled: false },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => fixedReal,
    });
    await w.start({
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e) => ({ ...e, blobs: [] }),
      pushDeferred() {},
      store: {},
      drainPendingEvents: async () => [],
    });

    w.st = {
      ...w.st,
      clock: {
        realEpoch: new Date(fixedReal.getTime() - 2 * 86_400_000).toISOString(),
        worldEpoch: new Date(fixedReal.getTime() + 5 * 86_400_000).toISOString(),
        speed: 4,
      },
    };
    const goTo = w.tools().find((t) => t.name === 'journey_go_to').handler;
    const goRes = await goTo({ city: '成都', mode: 'train' });
    assert.equal(goRes.isError, true, '倍速世界时钟超前时，sickUntil 仍须拦住从家出发');
    assert.match(String(goRes.text), /生病静养/);

    const takeRes = await w.takeInvite('inv-fake', true);
    assert.equal(takeRes.isError, true, '在家生病静养期 takeInvite 必须直接拒单');
    assert.match(String(takeRes.text), /生病静养/);

    writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
      schema: 2,
      updatedAt: new Date(fixedReal.getTime() - 26 * 3_600_000).toISOString(),
      certs: [],
      sickUntil: '',
      sickReason: '',
    }), 'utf8');
    assert.equal(w.hasLifeInstalled(), false);
    assert.equal(w.effectiveHasLicense(), true, '超过 24h 无心跳的旧档不得锁死单机 hasLicense=true');

    await w.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('跨日离线 arrive() 只排一次新日期日程且不误说上午十点正在补觉', async () => {
  const { JourneyWorld } = await import('../src/world.ts');
  const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
  const { buildJourney } = await import('../src/plan/journey.ts');
  const { cityById } = await import('../src/geo/cities.ts');
  const { modeById } = await import('../src/geo/modes.ts');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'jr-crossday-arr-'));
  const arrivedIso = '2026-11-27T00:31:00+08:00';
  const wakeNow = new Date('2026-11-28T10:00:00+08:00');
  try {
    const pushed = [];
    const w = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', moneyEnabled: false },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => wakeNow,
    });
    await w.start({
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e) => { pushed.push(e); return { ...e, blobs: [] }; },
      pushDeferred() {},
      store: {},
      drainPendingEvents: async () => [],
    });
    const from = cityById('lanzhou');
    const to = cityById('zhoushan');
    const leg = buildJourney({
      from, to, mode: modeById('train'), km: 1800,
      at: new Date('2026-11-26T05:00:00+08:00'), speed: 1,
    });
    leg.arriveAt = arrivedIso;

    let rebuildCount = 0;
    const origRebuild = w.rebuildPlan.bind(w);
    w.rebuildPlan = async (...args) => {
      rebuildCount += 1;
      return origRebuild(...args);
    };
    await w.arrive(wakeNow, leg);
    assert.equal(rebuildCount, 1, '跨日离线到站应只排一次次日 full 日程，不重排旧日');
    const arrEv = pushed.find((e) => e.type === 'journey.arrive');
    assert.ok(arrEv);
    assert.match(arrEv.text, /2026-11-27/);
    assert.match(arrEv.text, /2026-11-28/);
    assert.doesNotMatch(arrEv.text, /办好入住补觉/);

    await w.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
