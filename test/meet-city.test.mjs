/**
 * 「约在哪儿见面 → 一起去 → 在哪儿分开」—— 2026-11-07
 *
 * Mr.Q 的原话：
 *   「有关一起出游能不能这样，约好在哪个城市见面，然后一起走，最后从哪个城市一起分开。」
 *   「2、发起人的城，用户能改。3、继续等（有约定的情况下其他迟到的人应该尽快到碰面点）。」
 *
 * 查下来协议里只缺**一个**字段：`to`（一起走的城）本来就是「最后分开的地方」，
 * 少的是「先在哪儿碰头」。所以这一组测的重点不是「多了一个字段」，
 * 而是**两段路不能混成一段**：
 *
 *   还在赶去会合 → 不许说成「已经在一起」；
 *   到了会合点、人没来 → 不许自己往下走（这是「继续等」）；
 *   到了目的地 → 「待几天」从这一刻起算，不是从接约起算。
 *
 * 这三条只要有一条错，表现都是「她说的和做的不一样」—— 而那种错不会报错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');
const { cityById } = await import('../src/geo/cities.ts');
const { buildJourney } = await import('../src/plan/journey.ts');
const { modeById } = await import('../src/geo/modes.ts');
const { distanceKm } = await import('../src/geo/distance.ts');
const { paceGap, PACE_RATIO_MAX } = await import('../src/meet.ts');

function fakeHost(events) {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => { events.push(e); return { ...e, blobs: [] }; },
    pushDeferred() {},
    store: {},
    drainPendingEvents: async () => [],
  };
}

async function boot(trip, nowISO) {
  const dataDir = mkdtempSync(join(tmpdir(), 'jr-meet-'));
  new StateStore(dataDir).save({ ...initialState('lanzhou'), ...trip });
  const events = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir,
    botName: '大肥鱼',
    now: () => new Date(nowISO),
  });
  await world.start(fakeHost(events));
  return {
    world, events, dir: dataDir,
    restore: () => { globalThis.fetch = origFetch; world.stop?.(); },
  };
}

/* ---------------- 流速对不对得上 ---------------- */

test('流速：差两倍以内能赴约，差太多就直说凑不到', () => {
  /*
   * 这一条不是「技术限制」，是**别让她答应一桩兑现不了的事**。
   * 24 倍速的人过一个世界日只要一小时 —— 等她赶到会合点，人家那边早过了大半个月。
   */
  assert.equal(paceGap(1, 1), null, '同一个流速不该被拒');
  assert.equal(paceGap(1, PACE_RATIO_MAX), null, `刚好 ${PACE_RATIO_MAX} 倍应该放行`);
  const bad = paceGap(1, 24);
  assert.ok(bad, '1 倍对 24 倍居然放行了');
  assert.match(bad, /对不上|凑不到/, `不像人话：${bad}`);
  // 老客户端不报（0）不能当成「不兼容」
  assert.equal(paceGap(1, 0), null, '对方没报流速就被拒了');
  assert.equal(paceGap(0, 24), null, '自己没报流速就被拒了');
});

/* ---------------- 两段路 ---------------- */

const meetPledge = (extra = {}) => ({
  cityId: 'lasa',
  days: 3,
  withPet: '小满',
  inviteId: 'abcdef0123456789',
  acceptedAt: '2026-11-03T12:00:00Z',
  arrivedAt: null,
  meetCityId: 'chengdu',
  meetArrivedAt: null,
  ...extra,
});

test('下一站：没到见面城就去见面城，到了才去一起走的那座', async () => {
  const { world, restore } = await boot({ phase: 'staying', hereId: 'xian' }, '2026-11-04T04:00:00Z');
  try {
    assert.equal(world.pledgeStop(meetPledge()), 'chengdu', '还没碰头就直奔拉萨了');
    assert.equal(world.pledgeStop(meetPledge({ meetArrivedAt: '2026-11-04T02:00:00Z' })), 'lasa',
      '见了面还不走，一直在成都待着');
    // 没有见面城这一级的约定（老数据）必须保持原样
    assert.equal(world.pledgeStop(meetPledge({ meetCityId: undefined })), 'lasa', '把老约定也当成两段了');
  } finally { restore(); }
});

test('到见面城：只记「到了会合点」，不算「一起待的三天」开始', async () => {
  const arriveAt = new Date('2026-11-04T06:00:00Z');
  const leg = buildJourney({
    from: cityById('xian'), to: cityById('chengdu'),
    mode: modeById('train'), km: Math.round(distanceKm(cityById('xian'), cityById('chengdu'))),
    at: new Date('2026-11-03T20:00:00Z'), speed: 1,
  });
  const { world, events, restore } = await boot({
    phase: 'traveling', hereId: 'xian', leg,
    tripStartedAt: '2026-11-01T00:00:00Z',
    pledge: meetPledge(),
  }, arriveAt.toISOString());
  try {
    await world.arrive(arriveAt, leg);

    assert.equal(world.st.hereId, 'chengdu');
    assert.ok(world.st.pledge, `到会合点把约定弄丢了：${JSON.stringify(world.st.pledge)}`);
    assert.equal(world.st.pledge.meetArrivedAt, arriveAt.toISOString(), '没记「到了会合点」');
    assert.equal(world.st.pledge.arrivedAt, null,
      '把「到会合点」当成了「到了一起走的城」—— 那三天的账提前开始算了');

    const arrive = events.filter((e) => e.type === 'journey.arrive');
    assert.equal(arrive.length, 1);
    const text = String(arrive[0].text);
    assert.match(text, /碰头|等/, `到会合点那句没说在等人：${text}`);
    assert.doesNotMatch(text, /待 3 天/, `人还没见着就说要在这儿待三天：${text}`);
  } finally { restore(); }
});

test('在见面城等的人，窗口从到站那一刻重新算 —— 赶路两天不该吃掉等人的三天', async () => {
  /*
   * 真实场景：兰州 → 拉萨路上两天。接约后第三天落地，
   * 若还按「接约后三天」算，她一落地约定就只剩几小时。
   */
  const now = new Date('2026-11-07T04:00:00Z');
  const { world, restore } = await boot({ phase: 'staying', hereId: 'chengdu' }, now.toISOString());
  try {
    // 接约是 5 天前（早就超过「赶路三天」），但到会合点只是 1 天前
    world.st = {
      ...world.st,
      pledge: meetPledge({
        acceptedAt: '2026-11-02T04:00:00Z',
        meetArrivedAt: '2026-11-06T04:00:00Z',
      }),
    };
    assert.ok(world.activePledge(now), '在会合点等了一天就被判过期了');

    // 还在赶路的（没到会合点）同样时间就该作废
    world.st = { ...world.st, pledge: meetPledge({ acceptedAt: '2026-11-02T04:00:00Z' }) };
    assert.equal(world.activePledge(now), null, '赶路窗口过了还没作废');
  } finally { restore(); }
});

test('她读到的字分得清「正在赶去会合」和「已经在会合点等人」', async () => {
  const now = new Date('2026-11-07T04:00:00Z');
  const { world, restore } = await boot({ phase: 'staying', hereId: 'chengdu' }, now.toISOString());
  try {
    world.st = { ...world.st, pledge: meetPledge({ acceptedAt: '2026-11-06T04:00:00Z' }) };
    const onTheWay = world.pledgeText(now);
    assert.match(onTheWay, /成都/, `没提会合的地方：${onTheWay}`);
    assert.match(onTheWay, /赶|路上/, `在路上的时候说错了：${onTheWay}`);

    world.st = {
      ...world.st,
      pledge: meetPledge({ acceptedAt: '2026-11-05T04:00:00Z', meetArrivedAt: '2026-11-06T04:00:00Z' }),
    };
    const waiting = world.pledgeText(now);
    assert.match(waiting, /等/, `已经在等的人，摘要里没有「等」：${waiting}`);
    assert.doesNotMatch(waiting, /正在往成都赶/, `人已经到了还说在赶路：${waiting}`);
  } finally { restore(); }
});

test('等的那几天，日记正文里要有「你在等人」这件事', async () => {
  /*
   * 「功能在，但她看不见」这一类：到会合点之后，她那几天手上的事实只有「我在成都」。
   * 没有这一句，被问「你在这儿干嘛」时只能现编。
   */
  const now = new Date('2026-11-07T04:00:00Z');
  const { world, restore } = await boot({ phase: 'staying', hereId: 'chengdu' }, now.toISOString());
  try {
    const line = world.mateLine(meetPledge({ meetArrivedAt: '2026-11-05T04:00:00Z' }), 'chengdu', 2);
    assert.match(line, /小满/, `没提是在等谁：${line}`);
    assert.match(line, /等/, `没说在等：${line}`);
    assert.match(line, /拉萨/, `没说等到了要去哪儿：${line}`);
    // 到了目的地之后的说法不该被这一条盖掉
    const together = world.mateLine(meetPledge({ meetArrivedAt: '2026-11-05T04:00:00Z', arrivedAt: '2026-11-06T04:00:00Z' }), 'lasa', 1);
    assert.match(together, /第 2 天/, `一起待的那几天没算天数：${together}`);
  } finally { restore(); }
});

/* ---------------- 接约 ---------------- */

function inviteServer(one, calls) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/accept')) {
      calls.accept++;
      return {
        ok: true, status: 200,
        json: async () => ({
          ok: true, with: one.pet, to: one.to, days: one.days, note: one.note,
          meet: one.meet, pace: one.pace,
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, list: [one] }) };
  };
}

test('接下一条带见面城的邀约：状态里真的多出那一段', async () => {
  const now = new Date('2026-11-04T04:00:00Z');
  const { world, restore } = await boot({
    phase: 'staying', hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z', stayDateKey: '2026-11-04',
  }, now.toISOString());
  const calls = { accept: 0 };
  try {
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    globalThis.fetch = inviteServer({
      id: 'abcdef0123456789', pet: '小满', to: 'lasa', days: 3, note: '',
      meet: 'chengdu', pace: 1,
    }, calls);
    const r = await world.takeInvite('abcdef0123456789');
    assert.equal(r.isError, undefined, `该接成：${r.text}`);
    assert.equal(world.st.pledge?.meetCityId, 'chengdu', '见面城没写进约定');
    assert.equal(world.st.pledge?.meetArrivedAt, null, '人还在西安，却记成已经到了成都');
    assert.equal(world.st.pledge?.cityId, 'lasa');
    assert.match(r.text, /成都/, `回执没提先在哪儿碰头：${r.text}`);
  } finally { restore(); }
});

test('流速差太多：直接拒，而且**不许已经替她占了名额**', async () => {
  /*
   * 顺序和 2026-11-05 那次教训一样：所有校验都要在发出「接」之前完成。
   * 先接再拒，别人名单上就多一只永远不出现的鱼。
   */
  const now = new Date('2026-11-04T04:00:00Z');
  const { world, restore } = await boot({
    phase: 'staying', hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-02T00:00:00Z', stayDateKey: '2026-11-04',
  }, now.toISOString());
  const calls = { accept: 0 };
  try {
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    world.cfg.speed = 1;
    globalThis.fetch = inviteServer({
      id: 'abcdef0123456789', pet: '小满', to: 'lasa', days: 3, note: '',
      meet: '', pace: 24,
    }, calls);
    const r = await world.takeInvite('abcdef0123456789');
    assert.equal(r.isError, true, '流速差 24 倍居然接成了');
    assert.equal(calls.accept, 0, `校验没过就已经发了「接」：${calls.accept} 次`);
    assert.equal(world.st.pledge, null, '被拒了却留下了约定');
  } finally { restore(); }
});

/* ---------------- 接线 ---------------- */

test('发邀约必须把自己的流速带上，接约必须看对方的', async () => {
  /*
   * 「可选参数 + 合法默认值 + 漏传不报错」这个病在这个仓库里已经犯过三次
   * （`negative`、`subject`、`subject` 的传递）。`pace` 是第四个有同样体质的东西，
   * 这里用行为断言验证 inviteSomeone 实发 payload 带上了 pace = speedNow()。
   */
  const { world, restore } = await boot(
    { phase: 'staying', hereId: 'beijing', stayStartedAt: '2026-11-01T00:00:00Z' },
    '2026-11-01T02:00:00Z',
  );
  try {
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    world.cfg.speed = 4;
    let sentBody = null;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/sight/invite') && init.method === 'POST') {
        sentBody = JSON.parse(String(init.body || '{}'));
        return new Response(JSON.stringify({ ok: true, id: 'abcdef0123456789' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };
    const r = await world.inviteSomeone('成都', 3, '一起走');
    assert.equal(!r.isError, true, r.text);
    assert.equal(sentBody?.pace, 4, `发邀约没带上自己的流速：${JSON.stringify(sentBody)}`);
  } finally { restore(); }
});

test('她人就在目的地：不做「先去别处碰头」这一级', async () => {
  /*
   * 2026-11-07 长跑的不变量抓到的真 bug：
   * 她人在西安，邀约说「先去成都碰头，再一起回西安」。当时状态里同时有
   * `arrivedAt`（已经在一起）和 `meetCityId`（还没碰头）—— 两条都成立，
   * 等于让已经到了终点的人先跑回起点，而且「一起待三天」的账立刻开始走。
   *
   * 正确处理是**忽略见面这一级**：她就在他们要去的地方，等着就行。
   */
  const now = new Date('2026-11-07T04:00:00Z');
  const { world, restore } = await boot({
    phase: 'staying', hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-06T00:00:00Z', stayDateKey: '2026-11-07',
  }, now.toISOString());
  const calls = { accept: 0 };
  try {
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    world.cfg.speed = 1;
    globalThis.fetch = inviteServer({
      id: 'abcdef0123456789', pet: '小满', to: 'xian', days: 3, note: '',
      meet: 'chengdu', pace: 1,
    }, calls);
    const r = await world.takeInvite('abcdef0123456789');
    assert.equal(r.isError, undefined, `该接成：${r.text}`);
    const p = world.st.pledge;
    assert.ok(p, '没留下约定');
    assert.equal(p.meetCityId, undefined, '人在目的地，却被要求先去成都碰头');
    assert.ok(p.arrivedAt, '本来就在这儿，应该算已经到了');
  } finally { restore(); }
});

test('赶不到就别接：坐船去南美要几十天，而约的只给了三天', async () => {
  /*
   * 2026-11-07 的 invite 档在日志里抓到这一行：
   *   `洛阳当地 八点七分，动身去悉尼 —— 跟小满约在那儿碰头。轮船，8619 公里，13 天。`
   *
   * 赶路窗口只有三天 —— 这份约定从接下的那一刻就注定作废，而三天后她会说
   * 「没赶上」，听起来像是她自己的错。入口就该拦住，并且说出要多少天。
   *
   * 造这个局面：钱紧到买不起机票（`noFly`），会合点在南半球。
   */
  const now = new Date('2026-11-07T04:00:00Z');
  const { world, restore } = await boot({
    phase: 'staying', hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-06T00:00:00Z', stayDateKey: '2026-11-07',
  }, now.toISOString());
  const calls = { accept: 0 };
  try {
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    world.cfg.speed = 1;
    /*
     * 钱放到 cfg 上，不是 state —— `budget` 是配置项。第一版写进 state 里了，
     * 于是她还是「很有钱」，直接买了机票十几小时就到，这条测试什么都没验到。
     */
    world.cfg.moneyEnabled = true;
    world.cfg.budget = 400;
    globalThis.fetch = inviteServer({
      id: 'abcdef0123456789', pet: '小满', to: 'chengdu', days: 3, note: '',
      // 会合点在阿根廷，目的地是成都 —— 先得跨半个地球去碰头
      meet: 'buenosaires', pace: 1,
    }, calls);
    const r = await world.takeInvite('abcdef0123456789');
    assert.equal(r.isError, true, `这种约居然接成了：${r.text}`);
    assert.equal(calls.accept, 0, '被拒了却已经把「接」发出去了');
    assert.match(r.text, /天|赶|到不了/, `没说清为什么去不了：${r.text}`);
  } finally { restore(); }
});

/* ---------------- 发约 ---------------- */

/**
 * 不填 `meet` 的时候，见面城必须是**她脚下这座城**，而且真的要发出去（2026-11-12）。
 *
 * 原来默认 `null`：邀请里没有 `meet_city`，接的人 `pledge.meetCityId` 也是空，
 * `pledgeStop` 直接返回目的地 —— 两个人各走各的到拉萨才碰头。
 * 「先在西安会合、一起上车」这一级从此永远不会发生：能力在，路径不经过它。
 *
 * Mr.Q 的原话：「我记得我有做到一个地方一起出发去另一个地方旅游，旅游完了再解散的功能啊，
 * 怎么从来没见过」。根子就在这一处默认值。
 */
test('发邀约不填 meet：默认在脚下这座城碰头，再一起走', async () => {
  const now = new Date('2026-11-12T04:00:00Z');
  const { world, restore } = await boot({
    phase: 'staying', hereId: 'xian',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-10T00:00:00Z', stayDateKey: '2026-11-12',
  }, now.toISOString());
  let sent = null;
  try {
    world.cfg.meetUrl = 'https://x.app.tcloudbase.com';
    globalThis.fetch = async (u, init) => {
      if (String(u).includes('/invite')) {
        sent = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ ok: true, id: 'abcdef0123456789' }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, list: [] }) };
    };
    const r = await world.inviteSomeone('拉萨', 3, '');
    assert.equal(r.isError, undefined, `该发出去：${r.text}`);
    assert.equal(world.st.ask ?? null, null, '不该莫名其妙挂一张待批单');
    assert.equal(sent?.meet, 'xian',
      `没填 meet 却没带见面城（${sent?.meet}）—— 那就只能各走各的到拉萨碰头`);
    assert.match(r.text, /西安/, `回执没说先在西安见面：${r.text}`);
  } finally { restore(); }
});

/**
 * 约满那天，**散伙要单独说一句**（2026-11-12）。
 *
 * 原来这件事只藏在 `journey.depart` 的一句从句里（「跟某某说好的 3 天到了，动身」）——
 * 说完就上车了，听上去像「合同到期」，不像「跟人道别」。
 * Mr.Q：「旅游完了再解散……怎么从来没见过」。
 */
test('约满那天要单独说一句「散了」，不能只在出发句里带过', async () => {
  const now = new Date('2026-11-12T04:00:00Z');
  const { world, events, restore } = await boot({
    phase: 'staying', hereId: 'xian',
    tripStartedAt: '2026-11-05T00:00:00Z',
    stayStartedAt: '2026-11-09T00:00:00Z',
    stayDateKey: '2026-11-12',
    pledge: {
      cityId: 'xian', days: 2, withPet: '大肥鱼', withPets: ['大肥鱼'],
      inviteId: 'abcdef0123456789',
      acceptedAt: '2026-11-09T00:00:00Z',
      arrivedAt: '2026-11-10T00:00:00Z',
    },
  }, now.toISOString());
  try {
    await world.tick();
    const types = events.map((e) => e.type).join(',');
    const part = events.find((e) => e.type === 'journey.part');
    assert.ok(part, `散伙没有独立一条，只有出发句带过：${types}`);
    assert.match(String(part.text), /大肥鱼/, `没说跟谁散的：${part.text}`);
    assert.match(String(part.text), /2 天/, `没说待了几天：${part.text}`);
  } finally { restore(); }
});
