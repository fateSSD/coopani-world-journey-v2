/*
 * 两个「能用」的动作（2026-11-09）：
 *
 *   `journey_hotel_night` —— 今晚在住处干什么（按这家店真有的设施）
 *   `journey_spot_ride`   —— 景区里坐什么（索道/观光车/滑竿/滑道/自行车/讲解/自己走）
 *
 * 起因是 Mr.Q 的两句话：
 *
 * > 加上具体酒店信息了，晚上的语句是不是也可丰富的多了，
 * > 甚至可以让桌宠自己靠设备自己选择发生什么事件。
 *
 * > 爬山、景区交通得能用啊，要不一天靠走路可以嘛？
 *
 * 在这之前，这两件事都只在**排程时自动决定**（`planDay` 里按种子挑一个），
 * 她手里没有任何能执行的动作 —— 用户说「坐索道上山」「晚上去游泳」，
 * 她只能说「我这儿没找着」，或者硬演一段。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

function fakeHost() {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => ({ ...e, blobs: [] }),
    pushDeferred() {}, store: {}, drainPendingEvents: async () => [],
  };
}

/**
 * 起一个世界。
 *
 * `localHour` 是**当地时间**（成都/上海 tz），内部换算成 UTC ——
 * 直接写 `2026-11-05T02:00:00Z` 是当地 10 点，很容易看错，
 * 所以这里明写「我要下午三点」。
 */
async function boot({ hereId = 'chengdu', localHour = 20, cfg = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-night-'));
  new StateStore(dir).save({
    ...initialState('lanzhou'),
    phase: 'staying',
    hereId,
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z',
    stayDateKey: '2026-11-05',
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  /* 上海 = UTC+8；当地 localHour 点 = UTC (localHour - 8) */
  const utcHour = ((localHour - 8) % 24 + 24) % 24;
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', ...cfg },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(Date.UTC(2026, 10, 5, utcHour, 0, 0)),
  });
  await world.start(fakeHost());
  const restore = () => { globalThis.fetch = origFetch; world.stop?.(); };
  return { world, restore };
}

const tool = (w, name) => w.tools().find((t) => t.name === name);

/** 把今天的表换成一个可控的：几点、在哪、什么 kind。 */
function setPlan(world, beats, lodging = {}) {
  world.plan = {
    ...world.plan,
    dateKey: '2026-11-05',
    cityId: 'chengdu',
    beats,
    lodging: { ...world.plan.lodging, ...lodging },
  };
}

/* ---------------- 晚上在住处 ---------------- */

test('夜间：这家店有泳池，就能去游泳', async () => {
  const { world, restore } = await boot();
  try {
    setPlan(world, [{ at: 19, kind: 'hotel', what: '回酒店了' }], {
      tier: 'luxury', name: '成都某酒店', amen: ['pool', 'gym'], price: 400,
    });
    const out = await tool(world, 'journey_hotel_night').handler({ what: 'pool' });
    assert.doesNotMatch(out.text, /没有|没这个/, `有泳池却被拒了：${out.text}`);
    assert.match(out.text, /泳池|游/, `回执不像在游泳：${out.text}`);
    /* 这一段要真进时间轴，不能只在回执里说一句。 */
    assert.ok(
      world.plan.beats.some((b) => /泳池|游了/.test(b.what)),
      `回执说了但时间轴上没有：${world.plan.beats.map((b) => b.what).join(' / ')}`,
    );
  } finally { restore(); }
});

test('夜间：这家店没有泳池，不许硬演 —— 要说明并列出能干的', async () => {
  /*
   * 这是整个改造的边界。以前的错是「五星档一律给泳池」，
   * 而用户上携程一查那家店根本没有 —— 于是「加了具体酒店信息」反而更假。
   */
  const { world, restore } = await boot();
  try {
    setPlan(world, [{ at: 19, kind: 'hotel', what: '回酒店了' }], {
      tier: 'luxury', name: '天水皇冠假日酒店', amen: ['gym'], price: 200,
    });
    const out = await tool(world, 'journey_hotel_night').handler({ what: 'pool' });
    assert.ok(out.isError, `没有泳池却答应了：${out.text}`);
    assert.match(out.text, /没这个|没有/, '没直说没有');
    assert.match(out.text, /健身房/, '没列出这家店能干什么');
    assert.ok(
      !world.plan.beats.some((b) => /泳池/.test(b.what)),
      '拒绝了却还是写进了时间轴',
    );
  } finally { restore(); }
});

test('夜间：便宜店真有泳池就给 —— 档位不比事实可靠', async () => {
  const { world, restore } = await boot();
  try {
    setPlan(world, [{ at: 19, kind: 'hotel', what: '回酒店了' }], {
      tier: 'budget', name: '某县城宾馆', amen: ['pool'], price: 120,
    });
    const out = await tool(world, 'journey_hotel_night').handler({ what: 'pool' });
    assert.doesNotMatch(out.text, /没这个/, `便宜店有泳池反而不给：${out.text}`);
  } finally { restore(); }
});

test('夜间：SPA 要花钱，账上要真扣', async () => {
  const { world, restore } = await boot({ cfg: { moneyEnabled: true, budget: 5000 } });
  try {
    setPlan(world, [{ at: 19, kind: 'hotel', what: '回酒店了' }], {
      tier: 'luxury', name: '某酒店', amen: ['spa'], price: 400,
    });
    const before = world.st.spent;
    const out = await tool(world, 'journey_hotel_night').handler({ what: 'spa' });
    assert.ok(!out.isError, `SPA 被拒了：${out.text}`);
    assert.equal(world.st.spent - before, 380, 'SPA 没记账（或记错数）');
    assert.match(out.text, /380|花了/, '回执里没提花了多少');
  } finally { restore(); }
});

test('夜间：手头不够就说不够，不许先享受再欠账', async () => {
  const { world, restore } = await boot({ cfg: { moneyEnabled: true, budget: 100 } });
  try {
    setPlan(world, [{ at: 19, kind: 'hotel', what: '回酒店了' }], {
      tier: 'luxury', name: '某酒店', amen: ['spa'], price: 400,
    });
    const before = world.st.spent;
    const out = await tool(world, 'journey_hotel_night').handler({ what: 'spa' });
    assert.ok(out.isError, '钱不够却做了 SPA');
    assert.equal(world.st.spent, before, '钱不够却记了账');
  } finally { restore(); }
});

test('夜间：白天问「晚上干什么」不答', async () => {
  const { world, restore } = await boot({ localHour: 15 });
  try {
    setPlan(world, [{ at: 14, kind: 'activity', what: '下午，宽窄巷子', spot: '宽窄巷子' }], {
      tier: 'luxury', name: '某酒店', amen: ['pool'],
    });
    const out = await tool(world, 'journey_hotel_night').handler({ what: 'pool' });
    assert.ok(out.isError, '下午三点就把晚上的事安排了');
    assert.match(out.text, /还没到晚上|天黑/, `不像在说时候不对：${out.text}`);
  } finally { restore(); }
});

/* ---------------- 景区里坐什么 ---------------- */

test('景区：在山上说坐索道，能买上、能记账', async () => {
  /*
   * 这就是「爬山得能用」那一条。以前只有文案，没有工具 ——
   * 她说「我坐索道上去」是凭空说的，用户问「票呢」就答不上。
   */
  const { world, restore } = await boot({ localHour: 10, cfg: { moneyEnabled: true, budget: 3000 } });
  try {
    setPlan(world, [{ at: 9.5, kind: 'activity', what: '上午，黄山', spot: '黄山' }]);
    const before = world.st.spent;
    const out = await tool(world, 'journey_spot_ride').handler({ how: 'cableway' });
    assert.ok(!out.isError, `索道被拒了：${out.text}`);
    assert.match(out.text, /索道/, '回执不像坐了索道');
    assert.equal(world.st.spent - before, 140, '索道票价没记账');
  } finally { restore(); }
});

test('景区：博物馆里没有滑竿 —— 拒绝并列出这儿有什么', async () => {
  const { world, restore } = await boot({ localHour: 10 });
  try {
    setPlan(world, [{ at: 9.5, kind: 'activity', what: '上午，四川博物院', spot: '四川博物院' }]);
    const out = await tool(world, 'journey_spot_ride').handler({ how: 'sedan' });
    assert.ok(out.isError, `博物馆里坐上了滑竿：${out.text}`);
    assert.match(out.text, /讲解/, '没列出这儿能干的（讲解）');
    assert.ok(
      !world.plan.beats.some((b) => /滑竿/.test(b.what)),
      '拒绝了却写进了时间轴',
    );
  } finally { restore(); }
});

test('景区：自己走永远可以，不花钱', async () => {
  /*
   * Mr.Q 问「要不一天靠走路可以嘛」—— 答案要能说出口：
   * 可以，但腿会酸。不能因为「没买票」就什么都不记。
   */
  const { world, restore } = await boot({ localHour: 10, cfg: { moneyEnabled: true, budget: 3000 } });
  try {
    setPlan(world, [{ at: 9.5, kind: 'activity', what: '上午，青城山', spot: '青城山' }]);
    const before = world.st.spent;
    const out = await tool(world, 'journey_spot_ride').handler({ how: 'walk' });
    assert.ok(!out.isError, `自己走都不让：${out.text}`);
    assert.equal(world.st.spent, before, '自己走还收了钱');
  } finally { restore(); }
});

test('景区：不在景点里就说买不上 —— 车票得人到了才买', async () => {
  const { world, restore } = await boot({ localHour: 15 });
  try {
    setPlan(world, [{ at: 8, kind: 'activity', what: '上午，宽窄巷子', spot: '宽窄巷子' }]);
    const out = await tool(world, 'journey_spot_ride').handler({ how: 'bike' });
    assert.ok(out.isError, '离开景点六个小时了还能买景区车票');
    assert.match(out.text, /不在|已经/, `没说明为什么买不上：${out.text}`);
  } finally { restore(); }
});

test('景区：钱不够就说不，别先坐后欠', async () => {
  const { world, restore } = await boot({ localHour: 10, cfg: { moneyEnabled: true, budget: 50 } });
  try {
    setPlan(world, [{ at: 9.5, kind: 'activity', what: '上午，黄山', spot: '黄山' }]);
    const before = world.st.spent;
    const out = await tool(world, 'journey_spot_ride').handler({ how: 'cableway' });
    assert.ok(out.isError, '钱不够还坐了索道');
    assert.equal(world.st.spent, before, '钱不够却记了账');
  } finally { restore(); }
});

test('两个工具都标成写操作 —— 它们会改时间轴、动钱', async () => {
  const { world, restore } = await boot();
  try {
    for (const name of ['journey_hotel_night', 'journey_spot_ride']) {
      const t = tool(world, name);
      assert.ok(t, `工具表里没有 ${name}`);
      assert.ok(t.tags.includes('write'), `${name} 会改状态，不该标成只读`);
    }
  } finally { restore(); }
});

/* ---------------- 她看不看得见（2026-11-09 补） ---------------- */

test('她现在看得见今天已经过完的那几段 —— 否则日记只能靠编', async () => {
  /*
   * Mr.Q 问：「这些附加的东西，会不会写进日记里？」
   *
   * 查下来原来**看不见**：`nowSummary` 只报「此刻在哪」和「下一个点」。
   * 上午坐索道、中午请讲解，到晚上写日记时已经不在可见范围里，
   * 她只能靠被截断的上下文回忆 —— 回忆不起来就写成「今天逛了逛」，或者编一段。
   */
  const { world, restore } = await boot({ localHour: 18 });
  try {
    setPlan(world, [
      { at: 9.5, kind: 'activity', what: '上午，黄山', spot: '黄山' },
      { at: 10.2, kind: 'beat', what: '坐索道上去的，缆车在钢索上轻轻晃' },
      { at: 14, kind: 'activity', what: '下午，宏村', spot: '宏村' },
      { at: 19, kind: 'dinner', what: '晚饭，臭鳜鱼' },
    ]);
    const line = world.todaySoFar(world.plan, 18);
    /*
     * 措辞是「今天去过」，不是「今天走过：9.5 …；10.2 …」——
     * 第一版做成带时间戳的清单，Mr.Q 当场纠「日记主要还是靠她自己的人格去写」。
     * 清单会把模型变成打勾机器，素材才会长成日记。
     */
    assert.match(line, /今天去过：/, '没给今天已经过完的部分');
    assert.match(line, /坐索道上去的/, '上午坐索道那条丢了 —— 日记就写不出这件事');
    assert.match(line, /宏村/, '下午去过的地方丢了');
    assert.doesNotMatch(line, /\d{1,2}:\d{2}/, `带上了时间戳，又成清单了：${line}`);
    /* 晚饭还没发生（19 点 > 现在 18 点），不该出现。 */
    assert.doesNotMatch(line, /臭鳜鱼/, '把还没发生的算进「今天走过」了');
  } finally { restore(); }
});

test('「今天走过」不带标点残渣，也不无限膨胀', async () => {
  const { world, restore } = await boot({ localHour: 22 });
  try {
    const beats = [];
    for (let i = 0; i < 14; i++) {
      beats.push({ at: 8 + i, kind: 'activity', what: `第${i}处景点。`, spot: `S${i}` });
    }
    setPlan(world, beats);
    const line = world.todaySoFar(world.plan, 22);
    assert.doesNotMatch(line, /。；/, `标点残渣：${line}`);
    const n = line.split('；').length;
    assert.ok(n <= 8, `塞了 ${n} 条，会把上下文撑爆`);
  } finally { restore(); }
});

test('一起玩的时候，坐索道和酒店夜间也要带上人', async () => {
  /*
   * 「写进和其他鱼一起玩的规划里」—— 内容本来就在（act / settleIn 照常跑），
   * 缺的是**文案里没有同伴**：一起吃、一起逛夜景都有 dineWith / nightWith，
   * 唯独「坐索道」「在泳池游泳」读起来像她一个人去的。
   */
  const { planDay } = await import('../src/plan/dayplan.ts');
  const { cityById } = await import('../src/geo/cities.ts');
  const p = planDay({
    city: cityById('huangshan'), dateKey: '2026-11-05', shape: 'full', startHour: 0,
    lodging: { tier: 'luxury', kind: '度假酒店', price: 600, feel: '窗很大', amen: ['pool', 'gym', 'spa'] },
    weather: { dayWeather: '晴', nightWeather: '晴', wet: false },
    dayIndex: 1, comfortable: true, mate: '小满', warmth: 24,
  });
  const beats = p.beats.map((b) => b.what).join(' / ');
  assert.match(beats, /小满也在/, `带同伴爬山那天，额外项目里没有同伴：${beats}`);
});

test('三期端到端：journey_spot_ride（热气球/敞篷缆车/齿轨）与 journey_hotel_night（夜游船/乌篷船/叮叮车）扣费、写时间轴并反哺 life', async () => {
  const { readdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const readPendingMoodlets = (dataDir) => {
    const pdir = join(dataDir, 'life-spend');
    return readdirSync(pdir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(pdir, f), 'utf8')));
  };
  const installLifeBridge = (world) => {
    writeFileSync(join(world.opts.dataDir, 'life-state.json'), JSON.stringify({ version: 1 }), 'utf8');
    writeFileSync(join(world.opts.dataDir, 'life-public.json'), JSON.stringify({
      schema: 2, updatedAt: world.worldNow().toISOString(), asleepUntil: '', ledger: { cash: 3000, travelAllowance: 2100 },
    }), 'utf8');
  };

  // 1) 桂林漓江坐高空热气球（¥280）+ 反哺 life moodlet
  {
    const { world, restore } = await boot({ hereId: 'guilin', localHour: 9, cfg: { moneyEnabled: true, budget: 3000 } });
    try {
      installLifeBridge(world);
      setPlan(world, [{ at: 8.5, kind: 'activity', what: '上午，漓江', spot: '漓江' }]);
      world.plan.cityId = 'guilin';
      world.plan.weather = { dayWeather: '晴', nightWeather: '晴', wet: false };
      const before = world.st.spent;
      const out = await tool(world, 'journey_spot_ride').handler({ how: 'balloon' });
      assert.ok(!out.isError, out.text);
      assert.equal(world.st.spent - before, 180);
      assert.ok(world.plan.beats.some((b) => /热气球/.test(b.what)));
      const effects = readPendingMoodlets(world.opts.dataDir);
      assert.ok(effects.some((x) => x.amount === 0 && /热气球/.test(x.moodlet?.text || '') && x.vitalsDelta?.fun === 24));
    } finally { restore(); }
  }

  // 2) 上海夜游船（¥80）& 绍兴乌篷船（¥60）& 香港叮叮车（¥10）
  for (const [cityId, what, cost, kw] of [
    ['shanghai', 'night-cruise', 80, '夜游船'],
    ['shaoxing', 'rowboat', 60, '乌篷船'],
    ['xianggang', 'tram', 10, '叮叮车'],
  ]) {
    const { world, restore } = await boot({ hereId: cityId, localHour: 20, cfg: { moneyEnabled: true, budget: 3000 } });
    try {
      installLifeBridge(world);
      setPlan(world, [{ at: 19, kind: 'hotel', what: '回酒店了' }], { tier: 'budget', name: '某宾馆', amen: [], price: 180 });
      world.plan.cityId = cityId;
      const before = world.st.spent;
      const out = await tool(world, 'journey_hotel_night').handler({ what });
      assert.ok(!out.isError, `${cityId}/${what} 失败：${out.text}`);
      assert.equal(world.st.spent - before, cost);
      assert.ok(world.plan.beats.some((b) => b.what.includes(kw)));
      const effects = readPendingMoodlets(world.opts.dataDir);
      assert.ok(effects.some((x) => x.amount === 0 && x.moodlet?.kind === 'good' && (x.moodlet?.text || '').includes(kw)));
    } finally { restore(); }
  }
});
