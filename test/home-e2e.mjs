/**
 * 改出发地 = 搬家；刚加载不出发。
 *
 * 这两条都是 2026-10-31 用户截图逼出来的：
 *
 * 1. 面板上「兰州 · 从石家庄出发 · 兰州→敦煌」三句话互相打架；
 * 2. 群里两个人抱怨「World 一加载的时候就立马出发了」。
 *
 * 这两件事都发生在 `start()` 里，没有界面可点，只能靠测试盯住。
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
  const events = [];
  return {
    events,
    /*
     * 宿主的 Logger 是五个方法（trace/debug/info/warn/error）。
     * 桩只写 info/warn 会晚一步炸：新代码调 log.debug 时，异常发生在
     * 异步链里、测试已经结束了 —— 报出来的是「测试结束后仍有异步活动」，
     * 而不是「你的桩少了个方法」。2026-11-02 又撞了一次。
     */
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => { const env = { ...e, blobs: [] }; events.push(env); return env; },
    pushDeferred: () => {},
    store: {},
    drainPendingEvents: async () => [],
  };
}

/** 造一个已经写盘的状态，再让 World 从盘上把它读起来。 */
function seed(state) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-home-'));
  new StateStore(dir).save({ ...initialState('lanzhou'), ...state });
  return dir;
}

function makeWorld(dir, cfgOver = {}, now) {
  return new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', ...cfgOver },
    dataDir: dir,
    botName: '大肥鱼',
    now: now ?? (() => new Date('2026-10-31T02:00:00Z')), // 北京 10:00
  });
}

test('改出发地：她在家的时候，人跟着搬过去', () => {
  const dir = seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou' });
  const world = makeWorld(dir, { homeCity: '石家庄' });
  const host = fakeHost();
  world.start(host);
  // 不看日志，看状态：「她在家」+「家搬到石家庄」= 人就在石家庄。
  assert.equal(world.st.homeId, 'shijiazhuang', '家没搬');
  assert.equal(world.st.hereId, 'shijiazhuang', `人还留在 ${world.st.hereId}`);
});

test('改出发地：她还在外面的时候，人不动，只是回家目标变了', () => {
  const dir = seed({
    phase: 'traveling',
    hereId: 'nanning',
    homeId: 'lanzhou',
    leg: {
      id: 'leg-1', fromId: 'nanning', toId: 'kunming', modeId: 'train',
      km: 800, durationWorldHours: 6,
      departedAt: '2026-10-31T00:00:00Z', arriveAt: '2026-10-31T06:00:00Z',
      speed: 1, viaIds: [], createdAt: '2026-10-31T00:00:00Z',
    },
    tripStartedAt: '2026-10-28T00:00:00Z',
  });
  const world = makeWorld(dir, { homeCity: '石家庄' });
  world.start(fakeHost());
  assert.equal(world.st.homeId, 'shijiazhuang', '家没换');
  assert.equal(world.st.hereId, 'nanning', '她明明在南宁，被瞬移了');
  assert.equal(world.st.tripStartedAt, '2026-10-28T00:00:00Z', '这一趟的起点被抹掉了');

  // 面板上不能出现「兰州 · 家石家庄 · 南宁→昆明」三句打架的话：
  // home 是新家，tripHome 是这一趟的起点，两者不同时必须能分辨。
  const snap = world.uiSnapshot();
  assert.equal(snap.home, '石家庄', `家显示成 ${snap.home}`);
  assert.equal(snap.homeChanged, true, '家搬了却没标记');
  assert.notEqual(snap.tripHome, snap.home, '这一趟的起点被新家覆盖了');
});

test('还没改过出发地的时候，什么都不该发生', () => {
  const dir = seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou', spent: 120 });
  const world = makeWorld(dir, { homeCity: '兰州' });
  world.start(fakeHost());
  assert.equal(world.st.hereId, 'lanzhou');
  assert.equal(world.st.spent, 120, '没改配置却把账清了');
});

test('刚加载不出发：加载两分钟内不动身', async () => {
  const dir = seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou' });
  // 时钟要能推：宽限比的是**真实时刻**，用固定时钟去测永远推不过去。
  let clock = new Date('2026-10-31T02:00:00Z');
  const world = makeWorld(dir, {}, () => clock);
  world.start(fakeHost());
  // 直接戳 depart，绕开定时器 —— 定时器第一次是在 6 秒后。
  clock = new Date('2026-10-31T02:00:30Z');
  await world.depart(clock);
  assert.equal(world.st.phase, 'home', '刚加载 30 秒就跑了');
  assert.equal(world.st.leg, null, '刚加载就有行程了');
});

test('宽限过了就能正常出发（不是把她永久关在家里）', async () => {
  const dir = seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou' });
  let clock = new Date('2026-10-31T02:00:00Z');
  const world = makeWorld(dir, {}, () => clock);
  world.start(fakeHost());
  // 宽限是 2 分钟，推 3 分钟（北京 10:03，也在 7–21 点的出门窗口里）。
  clock = new Date('2026-10-31T02:03:00Z');
  await world.depart(clock);
  assert.equal(world.st.phase, 'traveling', '过了宽限还是不走');
  assert.ok(world.st.leg, '没有行程');
});

/* ---------------- 出门等他点头 ---------------- */

test('开了「等点头」：她在家歇够了也不会自己走', async () => {
  const dir = seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou' });
  let clock = new Date('2026-10-31T02:00:00Z');   // 北京 10:00
  const world = makeWorld(dir, { askBeforeDepart: true }, () => clock);
  world.start(fakeHost());
  clock = new Date('2026-10-31T02:30:00Z');       // 过了加载宽限，也在出门窗口里
  await world.tick();
  assert.equal(world.st.phase, 'home', '开关开着，她还是自己走了');
  assert.equal(world.st.leg, null);
});

test('开关关着（默认）：她照旧自己走', async () => {
  const dir = seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou' });
  let clock = new Date('2026-10-31T02:00:00Z');
  const world = makeWorld(dir, {}, () => clock);
  world.start(fakeHost());
  clock = new Date('2026-10-31T02:30:00Z');
  await world.tick();
  assert.equal(world.st.phase, 'traveling', '默认设置下居然不走');
});

test('按一下出发：真的走，而且跳过「夜里不出门」的门禁', async () => {
  const dir = seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou' });
  // 北京时间凌晨 3 点 —— 自动那条路会被门禁挡住，手动那条不该挡。
  let clock = new Date('2026-10-30T19:00:00Z');
  const world = makeWorld(dir, { askBeforeDepart: true }, () => clock);
  world.start(fakeHost());
  clock = new Date('2026-10-30T19:00:30Z');
  const snap = await world.panelInvoke('now', 'depart', []);
  assert.equal(world.st.phase, 'traveling', '按了按钮没走');
  assert.equal(snap.mode, 'traveling', '返回的面板数据没跟上');
});

test('按一下出发：休息期里也走 —— 按了就是「不等了，现在就走吧」', async () => {
  /*
   * 2026-11-06 改的口径。原来这里是一句 `throw new Error('她还在休息…')`。
   *
   * 那份 bug 报告里用户看到的就是这句话（他的「在家歇几天」明明已经是 0）。
   * 判据盖死那一层已经修了，但还剩一种情形：她确实在歇，而他想现在让她走 ——
   * 手动出发本来就是「他明确要求」，`depart` 早为手动跳过了 7–21 点和加载宽限，
   * 没道理单独在这儿卡住。
   */
  const dir = seed({
    phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou',
    restingUntil: '2026-11-05T02:00:00Z',
    homeAt: '2026-11-02T02:00:00Z',
  });
  const clock = new Date('2026-10-31T02:00:00Z');
  const world = makeWorld(dir, { askBeforeDepart: true }, () => clock);
  world.start(fakeHost());
  const snap = await world.panelInvoke('now', 'depart', []);
  assert.equal(world.st.phase, 'traveling', '休息期里按了却没走');
  assert.equal(snap.mode, 'traveling', '返回的面板数据没跟上');
  // 提前收假 = 休息期作废，不该留一条会跟着她的旧戳。
  assert.equal(world.st.restingUntil, null);
  assert.equal(world.st.homeAt, null);
});

test('休息期跟着配置走：改成 0，她立刻不用再歇（自动那条路也会走）', async () => {
  /*
   * 报告原话：「间隔改 0 也没法让它手动出门」。
   *
   * 根因是 `restingUntil` 到家那一瞬盖死。现在它是派生值（`homeAt + cfg.restDays`），
   * 所以这条测试盯的是「配置一改就生效」，不是「某个回调有没有被调到」。
   */
  const dir = seed({
    phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou',
    homeAt: '2026-10-31T00:00:00Z',          // 今早到家
    restingUntil: '2026-11-03T00:00:00Z',    // 按 restDays=3 盖的戳
  });
  // 兰州当天 12:00 —— 在 7–21 点的出门窗口里。
  let clock = new Date('2026-10-31T04:00:00Z');
  const world = makeWorld(dir, { restDays: 3, askBeforeDepart: false }, () => clock);
  world.start(fakeHost());

  let snap = await world.panelInvoke('now', 'snapshot', []);
  assert.ok(snap.restUntil, '配置写着歇 3 天，面板却没说她还在歇');
  assert.equal(world.st.phase, 'home');

  world.cfg.restDays = 0;                    // 用户在设置里改成 0
  snap = await world.panelInvoke('now', 'snapshot', []);
  assert.equal(snap.restUntil, null, `改成 0 了，面板还显示歇到 ${snap.restUntil}`);

  // 不用手动点：过了加载宽限的下一轮巡检就该自己走。
  clock = new Date(clock.getTime() + 180_000);
  await world.tick();
  assert.equal(world.st.phase, 'traveling', '改成 0 之后自动那条路仍然被挡着');
});

test('按一下出发：她已经不在家就拒绝（按钮锁定那句要有依据）', async () => {
  const dir = seed({
    phase: 'traveling', hereId: 'nanning', homeId: 'lanzhou',
    leg: {
      id: 'leg-1', fromId: 'nanning', toId: 'kunming', modeId: 'train',
      km: 800, durationWorldHours: 6,
      departedAt: '2026-10-31T00:00:00Z', arriveAt: '2026-10-31T06:00:00Z',
      speed: 1, viaIds: [], createdAt: '2026-10-31T00:00:00Z',
    },
  });
  const world = makeWorld(dir, { askBeforeDepart: true });
  world.start(fakeHost());
  await assert.rejects(() => world.panelInvoke('now', 'depart', []), /已经在外面/);
});

/* ---------------- 坐过站 ---------------- */

function travelingWorld(over = {}) {
  const dir = seed({
    phase: 'traveling', hereId: 'lanzhou', homeId: 'lanzhou',
    leg: {
      id: 'leg-miss', fromId: 'lanzhou', toId: 'xian', modeId: 'train',
      km: 600, durationWorldHours: 5,
      departedAt: '2026-10-31T00:00:00Z', arriveAt: '2026-10-31T05:00:00Z',
      speed: 1, viaIds: [], createdAt: '2026-10-31T00:00:00Z',
    },
    tripStartedAt: '2026-10-31T00:00:00Z',
    ...over,
  });
  // 进度 90%：刚到该掷骰子的区间
  const clock = new Date('2026-10-31T04:30:00Z');
  return { world: makeWorld(dir, {}, () => clock), clock };
}

test('坐过站：中了就把到站时间往后推，人还在车上（不凭空换城市）', async () => {
  const { world, clock } = travelingWorld();
  const host = fakeHost();
  world.start(host);
  const before = world.st.leg.arriveAt;
  const hereBefore = world.st.hereId;

  await world.maybeMissStop(clock, world.st.leg, 1); // 必中

  const after = world.st.leg.arriveAt;
  assert.ok(Date.parse(after) > Date.parse(before), '到站时间没往后推');
  const extraMin = (Date.parse(after) - Date.parse(before)) / 60_000;
  assert.ok(extraMin >= 38 && extraMin <= 72, `顺延了 ${extraMin} 分钟，不在合理区间`);
  assert.equal(world.st.hereId, hereBefore, '位置被改了 —— 过站不该换城市');
  assert.equal(world.st.phase, 'traveling', '还在车上，不该变成到了');
  assert.ok(host.events.some((e) => e.type === 'journey.mishap'), '没推过站事件');
});

test('坐过站：一趟只掷一次，没中也不会反复掷', async () => {
  const { world, clock } = travelingWorld();
  world.start(fakeHost());
  await world.maybeMissStop(clock, world.st.leg, 0);  // 必不中
  assert.ok(world.st.roadMarks.includes('leg-miss|miss'), '没中的那次没记下来');
  const before = world.st.leg.arriveAt;
  await world.maybeMissStop(clock, world.st.leg, 1);  // 再掷也不会中
  assert.equal(world.st.leg.arriveAt, before, '同一趟掷了两次');
});

test('坐过站：飞机不参与，进度不到 82% 也不掷', async () => {
  const plane = seededTraveling('plane');
  plane.world.start(fakeHost());
  await plane.world.maybeMissStop(plane.clock, plane.world.st.leg, 1);
  assert.equal(plane.world.st.roadMarks.length, 0, '飞机居然掷了过站');

  const early = travelingWorld();
  early.world.start(fakeHost());
  const earlyClock = new Date('2026-10-31T01:00:00Z'); // 进度 20%
  await early.world.maybeMissStop(earlyClock, early.world.st.leg, 1);
  assert.equal(early.world.st.roadMarks.length, 0, '刚上车就掷过站');
});

/** 同 travelingWorld，但可以换交通方式。 */
function seededTraveling(modeId) {
  const dir = seed({
    phase: 'traveling', hereId: 'lanzhou', homeId: 'lanzhou',
    leg: {
      id: 'leg-any', fromId: 'lanzhou', toId: 'xian', modeId,
      km: 600, durationWorldHours: 5,
      departedAt: '2026-10-31T00:00:00Z', arriveAt: '2026-10-31T05:00:00Z',
      speed: 1, viaIds: [], createdAt: '2026-10-31T00:00:00Z',
    },
  });
  const clock = new Date('2026-10-31T04:30:00Z');
  return { world: makeWorld(dir, {}, () => clock), clock };
}

/* ---------------- 指示灯 ---------------- */

test('指示灯：四条链路都在，且状态说得清', () => {
  const dir = seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou' });
  const world = makeWorld(dir, {}, () => new Date('2026-10-31T02:00:00Z'));
  world.start(fakeHost());
  const lamps = world.webUi().lamps ?? [];
  const labels = lamps.map((l) => l.label);
  assert.deepEqual(labels, ['天气', '日记', '照片', '听歌'], `灯的组成变了：${labels.join('/')}`);

  for (const l of lamps) {
    assert.ok(['online', 'loading', 'error', 'offline'].includes(l.state), `${l.label} 的状态不合法：${l.state}`);
    assert.ok(typeof l.hint === 'string' && l.hint.length > 0, `${l.label} 没有悬停说明`);
  }

  // 没配生图接口是「没启用」，不是故障 —— 灰点，不是红点
  const photo = lamps.find((l) => l.label === '照片');
  assert.equal(photo.state, 'offline', '没配接口却报了故障');
  assert.match(photo.hint, /没配/);

  // 日记目录是临时目录，可写 → 绿
  const diary = lamps.find((l) => l.label === '日记');
  assert.equal(diary.state, 'online');
});

test('指示灯：配了生图接口，状态从「没启用」变成「还没拍过」', () => {
  const dir = seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou' });
  const world = makeWorld(dir, { imageApi: 'http://127.0.0.1:1/v1' }, () => new Date('2026-10-31T02:00:00Z'));
  world.start(fakeHost());
  const photo = (world.webUi().lamps ?? []).find((l) => l.label === '照片');
  assert.equal(photo.state, 'offline');
  assert.match(photo.hint, /还没拍过/, `提示不对：${photo.hint}`);
});

test('指示灯：天气没查过时是灰的，别装作一切正常', () => {
  const dir = seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou' });
  const world = makeWorld(dir, {}, () => new Date('2026-10-31T02:00:00Z'));
  world.start(fakeHost());
  const weather = (world.webUi().lamps ?? []).find((l) => l.label === '天气');
  assert.equal(weather.state, 'offline', '还没查过就说自己在线');
  assert.match(weather.hint, /Open-Meteo|高德/, '没说明走的是哪条源');
});

/* ---------------- 听歌联动：换歌即时进「想去」 ---------------- */

test('换歌：歌名带地名，当场进「想去」，不用等出发', async () => {
  // 原来只有 depart 和路上中间节点两个采样点 —— 用户放一首《成都》，
  // 她可能几个小时都没反应，因为**根本没往这儿看**。
  const dir = seed({ phase: 'staying', hereId: 'lanzhou', homeId: 'lanzhou' });
  let song = { title: '爱错', artist: '王力宏', at: Date.now() };
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: dir, botName: 'x',
    now: () => new Date('2026-10-31T02:00:00Z'),
    nowPlaying: () => song,
  });
  world.start(fakeHost());

  // 第一首不带地名：什么都不该发生
  world.syncSongWish();
  assert.deepEqual(world.st.wishes, [], '不带地名的歌也记了想去');

  // 换一首带地名的
  song = { title: '成都', artist: '赵雷', at: Date.now() };
  world.syncSongWish();
  assert.deepEqual(world.st.wishes, ['chengdu'], `没记住想去：${world.st.wishes}`);

  // 同一首歌再巡检几次，不能重复记
  world.syncSongWish();
  world.syncSongWish();
  assert.equal(world.st.wishes.length, 1, '同一首歌被记了多次');

  // 面板上能看到
  assert.deepEqual(world.uiSnapshot().wishes, ['成都']);
});

test('换歌：不推事件，免得和「一起听歌」抢话', async () => {
  // 音乐扩展自己「换歌必说一句」，这边再推一条，桌宠会连着说两句同样的事。
  const dir = seed({ phase: 'staying', hereId: 'lanzhou', homeId: 'lanzhou' });
  let song = { title: '成都', artist: '赵雷', at: Date.now() };
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: dir, botName: 'x',
    now: () => new Date('2026-10-31T02:00:00Z'),
    nowPlaying: () => song,
  });
  const host = fakeHost();
  world.start(host);
  const before = host.events.length;
  world.syncSongWish();
  assert.equal(host.events.length, before, '记想去的时候顺手推了事件');
});

test('面板：时钟下面给的是她所在地的时区，不是「比你快多少」', async () => {
  // 2026-11-02 Mr.Q：「这个同步是不是没什么意义？换成当地的时区怎么样」
  // 时区必须是**她所在那座城市**的，不是本机时区 —— 她在东京就该是 UTC+9。
  const dir = seed({ phase: 'staying', hereId: 'tokyo', homeId: 'lanzhou' });
  const world = makeWorld(dir, {}, () => new Date('2026-11-01T04:00:00Z'));
  await world.start(fakeHost());
  const snap = world.uiSnapshot();
  assert.equal(snap.tzLabel, 'UTC+9', `时区算错了：${snap.tzLabel}`);
  assert.equal(typeof snap.clockDriftMs, 'number', '漂移仍然要给后端算，前端只负责决定什么时候说');
});
test('停留：下午到、第二天早上算「第 2 天」，不然连着两天排同一批景点', async () => {
  /*
   * 2026-11-02 自查抓到的代码缺陷，与 2026-11-01 那条「第二天还是卢浮宫」是同一条线。
   *
   * 根因不在 spotText —— 那边早就会按 dayIndex 往后推两格；问题在喂进去的 dayIndex 一直是 0：
   * `stayDaysSoFar()` 算的是「过了几个 24 小时」，下午三点到、第二天早上七点，
   * 才 16 小时，Math.floor 之后还是 0。
   *
   * ⚠️ 这条**没有**拿真实日记当证据：她 11-01 白天的行程事件已被交接笔记截断，
   * 查不到当天实际排的是哪几处，所以「她连着两天去玉泉观」这个现象归因不成立。
   * 这里测的是代码本身的口径，不是「那个现象就是它害的」。
   *
   * 判据：**「第几天」按当地日期算，「住了几晚」才按 24 小时算。** 两个口径不能混用。
   */
  const dir = seed({
    phase: 'staying', hereId: 'tianshui', homeId: 'lanzhou',
    stayStartedAt: '2026-11-01T07:00:00Z',      // 当地 15:00 到
  });
  const now = new Date('2026-11-02T00:00:00Z');  // 当地次日 08:00，只过了 17 小时
  const world = makeWorld(dir, {}, () => now);
  await world.start(fakeHost());

  assert.equal(world.stayDaysSoFar(now), 0, '按整晚算确实是 0 —— 这个口径没变');
  assert.equal(world.stayDayIndex(now), 1, 'dayIndex 还是 0 的话，第二天照旧同一批景点');
});


test('日记工具：能给一天全文，也能给一个月的目录', async () => {
  /*
   * 2026-11-02：模拟跑 144 天后，最早那天和跨年那天用「最近 N 天」读不回来。
   * 补了两个入口：dateKey 精确取、month 列目录。
   * 这里量的是**工具层真的接上了**，不只是 DiaryStore 有这个方法。
   */
  const dir = seed({ phase: 'staying', hereId: 'tianshui', homeId: 'lanzhou', stayStartedAt: '2026-11-01T07:00:00Z' });
  const world = makeWorld(dir, {}, () => new Date('2026-11-02T00:00:00Z'));
  await world.start(fakeHost());

  const tools = world.tools();
  const w = tools.find((t) => t.name === 'journey_diary_write');
  const r = tools.find((t) => t.name === 'journey_diary_read');

  await w.handler({ body: '第一天。台阶一段接一段，走完一段还有一段，腿开始发酸才到上头。', dateKey: '2026-11-01' });
  await w.handler({ body: '第二天，下雨没出门。', dateKey: '2026-11-02' });

  const one = await r.handler({ dateKey: '2026-11-01' });
  assert.match(one.text, /2026-11-01/, '按天取没回日期');
  assert.match(one.text, /台阶一段接一段/, '按天取没回正文');

  const mon = await r.handler({ month: '2026-11' });
  assert.match(mon.text, /共 2 天/, `按月没数对：${mon.text.slice(0, 80)}`);
  assert.match(mon.text, /2026-11-01 · 天水 · 第一天/, '目录里每行要有日期、城市和一句摘要');
  assert.match(mon.text, /2026-11-02 · 天水 · 第二天，下雨没出门/, '短句不该被截');
  assert.doesNotMatch(mon.text, /腿开始发酸/, '目录只该给摘要，不该把整段正文都塞进去');

  const missing = await r.handler({ dateKey: '2026-01-01' });
  assert.match(missing.text, /没有/, '查一个没写过的日子要说清楚，不能静默返回空');
});

test('预算分档：按比例算，再压一个绝对下限', async () => {
  /*
   * 起因：模拟跑 144 个世界天，预算 3000 花掉 16.9 万 —— 旧逻辑里预算只影响
   * 「住哪家、坐什么」，不影响总量。这条量的是**真的那个方法**，不是复刻一遍常量。
   */
  const dir = seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou' });
  const world = makeWorld(dir, { moneyEnabled: true, budget: 2000 });
  await world.start(fakeHost());

  const at = (left) => {
    world.st = { ...world.st, spent: 2000 - left };
    return world.purseStage();
  };
  assert.equal(at(1500), 'ok', '两千预算剩一千五还嫌紧，那是抢钱');
  assert.equal(at(800), 'tight', '剩八百还没开始省');
  assert.equal(at(400), 'low', '剩四百还能坐飞机就说不过去了');
  assert.equal(at(100), 'empty', '剩一百还不去打工');

  // 比例制：两万预算剩五千，按 30% 早就该紧了
  const rich = makeWorld(seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou' }), { moneyEnabled: true, budget: 20000 });
  await rich.start(fakeHost());
  rich.st = { ...rich.st, spent: 15000 };
  assert.equal(rich.purseStage(), 'tight', '两万预算剩五千还不够省 —— 说明还是按绝对值在判');

  // 记账关着 / 预算 0：永远不替用户省钱
  const off = makeWorld(seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou' }), { moneyEnabled: false, budget: 2000 });
  await off.start(fakeHost());
  off.st = { ...off.st, spent: 1900 };
  assert.equal(off.purseStage(), 'ok', '记账关着还在算钱');
});

test('钱见底：先找活干，六天后收工，期间不往外走', async () => {
  /*
   * 这是这次改造的核心行为，也是唯一没法用纯函数测的一段：
   *   钱到 empty → 当天早上 8 点决策时开工 → 不 moveOn、不 goHome →
   *   六个世界日之后自动收工 → 才能接着走。
   */
  const dir = seed({
    phase: 'staying', hereId: 'tianshui', homeId: 'lanzhou',
    stayStartedAt: '2026-11-01T07:00:00Z', stayDateKey: '2026-11-01',
    tripStartedAt: '2026-10-31T07:00:00Z', decidedOn: null,
  });
  /*
   * 时钟必须**可变地**注入。makeWorld 默认给一个固定时刻，
   * 那样 tick 往前跑、时间却一直停在原地 —— 第一版这条测试就是这么假绿的。
   */
  let clock = new Date('2026-11-02T00:30:00Z');
  const world = makeWorld(dir, { moneyEnabled: true, budget: 2000, beatGap: 0 }, () => clock);
  await world.start(fakeHost());

  // 剩一百块 = 见底
  world.st = { ...world.st, spent: 1900 };
  /*
   * 每天走两次 tick：第一次跨天（换 stayDateKey、重排作息表），
   * 第二次才落进「早上八点决策」那个分支。
   */
  const day = async (iso) => {
    clock = new Date(iso);
    await world.tick();
    clock = new Date(new Date(iso).getTime() + 60_000);
    await world.tick();
  };
  await day('2026-11-02T00:30:00Z');   // 天水当地 08:30

  const w = world.st.work;
  assert.ok(w, '钱见底了还在往前走，没去找活');
  assert.equal(w.cityId, 'tianshui', '打工不该换城市');
  assert.ok(w.pay > 150, `日薪 ${w.pay} 太低，干六天攒不出路费`);
  assert.equal(world.st.hereId, 'tianshui', '开工那天就该待在原地');

  // 中途：还在打工，不该动
  await day('2026-11-05T00:30:00Z');
  assert.ok(world.st.work, '第三天就收工了，六天没干满');
  assert.equal(world.st.hereId, 'tianshui', '打工期间挪窝了');

  // 第七天：收工
  // 收工点是「开工 + 六天」，那个时刻在 00:31 附近，所以推后两个钟头再查。
  await day('2026-11-08T03:00:00Z');
  assert.equal(world.st.work, null, '干满六天还没收工，会一直耗在这儿');
});

test('状态兼容：老 state.json 里没有 work 字段，读出来是 null 不是坏了', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'jr-legacy-state-'));
  mkdirSync(dir, { recursive: true });
  // 手写一份 0.5.15 时代的状态：没有 work
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 1, clock: null, phase: 'staying', hereId: 'tianshui', homeId: 'lanzhou',
    tripHomeId: 'lanzhou', leg: null, tripStartedAt: '2026-10-31T07:00:00.000Z',
    stayStartedAt: '2026-11-01T07:00:00.000Z', tripVisited: ['tianshui'],
    everVisited: ['tianshui'], restingUntil: null, wishes: [], spent: 320,
    heading: 90, lastKm: 300, returning: false, lastBeatKey: null, roadMarks: [],
    stayDateKey: '2026-11-01', decidedOn: null,
  }), 'utf8');

  const st = new StateStore(dir).load('lanzhou');
  assert.equal(st.problem, null, `老状态被当成坏了：${st.problem}`);
  assert.equal(st.state.work, null, '没有 work 字段应该读成「没在打工」，不是 undefined');
  assert.equal(st.state.spent, 320, '别的字段被新加的解析带坏了');
});

test('票价上限：买不起的那张票直接不给，别让它把预算打穿', async () => {
  /*
   * 2026-11-02 模拟跑 144 天抓到的：预算 3000 的她飞到了乌斯怀亚。
   * 因为「这张票多少钱」从来没被问过 —— 压权和禁飞机都只管方式。
   * 一张跨洲票把她打穿，她在南美打了四份工，最后一路花八万回家。
   */
  const dir = seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou' });
  const world = makeWorld(dir, { moneyEnabled: true, budget: 3000 });
  await world.start(fakeHost());
  world.st = { ...world.st, spent: 2000 };   // 还剩 1000

  const far = world.affordMode(9000);        // 兰州→温哥华那量级
  assert.ok(far, '还有钱的时候应该给出「买得起什么」的判据');
  assert.equal(far({ id: 'plane' }), false, '9000 公里的机票一万三，剩一千还给得起？');
  assert.equal(far({ id: 'train' }), false, '火车也要四千五，一样买不起');

  const near = world.affordMode(300);
  assert.equal(near({ id: 'train' }), true, '三百公里的火车一百五，这都买不起就没法走了');
  /*
   * 2026-11-03 改：飞机按国内经济舱算（0.4 元/公里），不再按全价票的 1.5。
   * Mr.Q 给的真实数字是「兰州飞三亚淡季 800/900」，两千公里八百块上下。
   */
  assert.equal(near({ id: 'plane' }), true, '三百公里机票一百二，余钱一半是五百，买得起');
  assert.equal(world.affordMode(1500)({ id: 'plane' }), false, '一千五百公里机票六百，超了五百的上限');

  // 没记账 / 预算 0：不限制
  const off = makeWorld(seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou' }), { moneyEnabled: false, budget: 3000 });
  await off.start(fakeHost());
  assert.equal(off.affordMode(9000), undefined, '记账关着还去算票钱');
});

test('回家路上不卡票钱：卡住就永远回不来', async () => {
  const dir = seed({ phase: 'staying', hereId: 'tokyo', homeId: 'lanzhou', stayStartedAt: '2026-11-01T07:00:00Z' });
  const world = makeWorld(dir, { moneyEnabled: true, budget: 3000 });
  await world.start(fakeHost());
  world.st = { ...world.st, spent: 2900, returning: true };   // 只剩 100

  const afford = world.affordMode(3000);
  assert.ok(afford, '回家路上也得给判据，只是判据更宽');
  assert.equal(afford({ id: 'plane' }), false, '剩余 100 连机票零头都不够，按「买得起」算就不对');
  /*
   * 真的一分不剩：**只留最便宜的两种（公交 / 走路）**。
   *
   * 2026-11-03 改：原来这里返回 `undefined`（不限制），本意是「别把人卡死在外地」——
   * 但 `undefined` 的语义是「什么都不限」，于是钱花光了反而能坐飞机，
   * 144 天模拟里预算 3000 花掉三万三。现在留个下限：走得起，但只走得慢的。
   */
  world.st = { ...world.st, spent: 3100 };
  const broke = world.affordMode(3000);
  assert.ok(broke, '超支了一分不放行，她会永远卡在国外');
  assert.equal(broke({ id: 'bus' }), true, '一分钱不剩也该让她坐得起最便宜的');
  assert.equal(broke({ id: 'plane' }), false, '一分钱不剩还能坐飞机？');
});

test('同一趟打到第四次工还是没钱，就该回家了', async () => {
  /*
   * 不加这条上限的话她永远不回家：144 天模拟里打了 17 次工，
   * 那不叫旅行，叫在外地常年打工。
   */
  const dir = seed({
    phase: 'staying', hereId: 'tianshui', homeId: 'lanzhou',
    stayStartedAt: '2026-11-01T07:00:00Z', stayDateKey: '2026-11-01', decidedOn: null,
  });
  let clock = new Date('2026-11-02T00:30:00Z');
  const world = makeWorld(dir, { moneyEnabled: true, budget: 2000 }, () => clock);
  await world.start(fakeHost());

  // 已经打过四次，钱又见底了
  world.st = { ...world.st, spent: 1900, workStints: 4 };
  await world.tick();

  /*
   * 2026-11-15 起**回家不再一步到家**：天水到兰州三百公里，得真的走回去
   * （`HOME_RADIUS_KM` 500 → 60，只收同城范围）。所以这里推到「到家」为止。
   *
   * 原来只 tick 两次就断言「计数清零」—— 那时 `goHome` 会用直达票当场收尾。
   * 现在这条路要走一到两天，测的仍然是同一件事：**打满四次不许再打工，得回家。**
   */
  let guard = 0;
  while (world.st.phase !== 'home' && guard < 240) {
    clock = new Date(clock.getTime() + 3_600_000);
    await world.tick();
    guard += 1;
  }
  assert.equal(world.st.phase, 'home', `十天还没走到家（在这儿：${world.st.hereId}）`);

  assert.equal(world.st.work, null, '第五次还在找活，说明上限没生效');
  assert.equal(world.st.workStints, 0, '回家之后这一趟的计数该清零');
  assert.equal(world.st.spent, 0, '回家就是这一趟结束，账要结清 —— 不然预算和打工次数两个口径永远对不上');
  assert.equal(world.st.earned, 0, '挣的也清');
});

test('叫她回来：当场飞回，钱不够也照飞（2026-11-15 改）', async () => {
  /*
   * 原来这条测的是「钱不够就一站一站走回去」。
   *
   * Mr.Q 11-15 改了：「叫回也应该是当场坐飞机回来（钱不够允许她借钱，回来报销）。」
   * 判据只剩一条 —— **叫了就是当天到家**，不看余钱。
   *
   * 「借钱」那一半等他定下 life 与 journey 的钱怎么合账再落（见 CHANGELOG 1.8.7），
   * 这一版先保证人飞得回来，不会因为差两百块滞留在千里之外。
   */
  const dir = seed({
    phase: 'staying', hereId: 'chengdu', homeId: 'lanzhou',
    stayStartedAt: '2026-11-01T07:00:00Z', stayDateKey: '2026-11-01', decidedOn: null,
    moneyEnabled: true, budget: 3000, spent: 2800, earned: 0,
  });
  const world = makeWorld(dir, { moneyEnabled: true, budget: 3000, beatGap: 0 });
  await world.start(fakeHost());

  const tool = world.tools().find((t) => t.name === 'journey_return_home');
  assert.ok(tool, '没有 journey_return_home 这个工具 —— 聊天里说「回来吧」她听不见');
  const r = await tool.handler({});

  // 余钱两百，成都回兰州的票要三百 —— 按老规则她只能一站站挪，现在是直接飞
  assert.equal(world.st.phase, 'home', '叫回来了却没到家');
  assert.equal(world.st.hereId, 'lanzhou', '人还不在家');
  assert.equal(world.st.returning, false, '已经到家了还挂着回程状态');
  assert.match(r.text, /回兰州/, `回执不对：${r.text}`);
});

test('叫她回来：已经在家、已经在路上，都不许重复触发', async () => {
  const home = makeWorld(seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou' }), {});
  await home.start(fakeHost());
  const t1 = home.tools().find((t) => t.name === 'journey_return_home');
  assert.match((await t1.handler({})).text, /已经在家/);

  const back = makeWorld(seed({
    phase: 'staying', hereId: 'chengdu', homeId: 'lanzhou',
    stayStartedAt: '2026-11-01T07:00:00Z', returning: true,
  }), {});
  await back.start(fakeHost());
  const t2 = back.tools().find((t) => t.name === 'journey_return_home');
  assert.match((await t2.handler({})).text, /已经在往回走/, '已经在返程了还让她再动一次');
});

test('叫她回来：正在打工就先收工，工钱不扣', async () => {
  const dir = seed({
    phase: 'staying', hereId: 'chengdu', homeId: 'lanzhou',
    stayStartedAt: '2026-11-01T07:00:00Z', stayDateKey: '2026-11-01',
    moneyEnabled: true, budget: 3000, spent: 3150, earned: 400,
    work: { cityId: 'chengdu', startedOn: '2026-11-01', until: '2026-11-09T07:00:00Z', pay: 300, gig: '青旅换宿' },
  });
  const world = makeWorld(dir, { moneyEnabled: true, budget: 3000, beatGap: 0 });
  await world.start(fakeHost());

  const t = world.tools().find((x) => x.name === 'journey_return_home');
  await t.handler({});

  assert.equal(world.st.work, null, '叫回来了还在打它的工');
  /*
   * 两种结局都合法，但含义不同：
   *   · 走回去 → 这一趟还没结束，挣的工钱必须留着；
   *   · 一趟到家 → 这一趟结账，spent/earned 一起清零（那是「结束一趟」的语义，不是扣钱）。
   * 这里只认第一种，因为它是这条测试要盯的：**叫回来不该顺手把工钱抹了**。
   */
  if (world.st.phase !== 'home') {
    assert.equal(world.st.earned, 400, '把已经挣到的工钱扣掉了 —— 那是按天结过的，不该动');
  }
});

test('叫她回来：孤岛走不出去会直接到家，但回执得说实话', async () => {
  /*
   * 三亚这种地方，出岛要么飞机、要么轮渡，而轮渡在城市表里没有建模。
   * `moveOn` 选不出路时有个兜底：直接 `settleHome`。这是 0.5.15 起就有的行为，
   * 不是召回引入的 —— 但**召回必须把它说出来**。
   *
   * 判据：一步到家了还回「往回走了」，第二天他一看人在兰州，会觉得这个按钮在骗人。
   */
  const dir = seed({
    phase: 'staying', hereId: 'sanya', homeId: 'lanzhou',
    stayStartedAt: '2026-11-01T07:00:00Z', stayDateKey: '2026-11-01',
    moneyEnabled: true, budget: 3000, spent: 2800, earned: 900,
  });
  const world = makeWorld(dir, { moneyEnabled: true, budget: 3000, beatGap: 0 });
  await world.start(fakeHost());

  const t = world.tools().find((x) => x.name === 'journey_return_home');
  const r = await t.handler({});

  if (world.st.phase === 'home') {
    assert.match(r.text, /回兰州了/, `一步到家了，回执却说「${r.text}」`);
  } else {
    // 哪天有人把轮渡补进城市表，这条就走到这里：那更好，走回去本来就是对的
    assert.match(r.text, /往回走/);
  }
});

test('叫她回来：钱紧也不会因为挑了个买不起的地方就传送', async () => {
  /*
   * 2026-11-03 查出来的真根因（不是「缺轮渡」）：
   *
   * 三亚 → 兰州的返程选点，可能挑到**离家近、但要绕远路**的城市 —— 张掖离兰州 500 公里，
   * 所以它在「离目标更近」这条判据下通过了；但三亚到张掖 2460 公里，
   * 票价超过余钱的一半，`pickMode` 一个方式都给不出来，`moveOn` 兜底直接 `settleHome`。
   *
   * 用户看到的是：按了「叫她回来」，她瞬移回兰州。
   *
   * 修法：**选点的时候就把距离卡在买得起的范围里**（`purseRangeKm`），
   * 而不是等选完了才发现走不了。
   */
  const dir = seed({
    phase: 'staying', hereId: 'sanya', homeId: 'lanzhou',
    stayStartedAt: '2026-11-01T07:00:00Z', stayDateKey: '2026-11-01',
    moneyEnabled: true, budget: 3000, spent: 2800, earned: 900,
  });
  const world = makeWorld(dir, { moneyEnabled: true, budget: 3000, beatGap: 0 });
  await world.start(fakeHost());

  // 净值 1100，按最便宜的地面方式估能走 1375 公里
  const range = world.purseRangeKm();
  assert.ok(range > 600 && range < 2000, `可走范围算成了 ${range} 公里，不合理`);

  const t = world.tools().find((x) => x.name === 'journey_return_home');
  const r = await t.handler({});
  /*
   * 两种结局都合法：钱够就直飞（那是有票就买，不是传送），不够才一站站走。
   * 这条盯的是**回执不许撒谎** —— 人到家了却说「往回走了」，第二天他一看人已在兰州，
   * 就会觉得这个按钮在骗人。
   */
  if (world.st.phase === 'home') {
    assert.match(r.text, /回兰州了/, '人到家了，回执却说「往回走了」');
  } else {
    assert.match(r.text, /往回走/, '人还在路上，回执却说到了家');
    assert.equal(world.st.hereId, 'sanya', '没到家就该还在三亚');
  }
});

test('出发地写了个不认识的名字，面板上要说出这句话', async () => {
  /*
   * 2026-11-03 一位读者来信：「我尝试加了城市（常熟），发现城市里面没有这个城市，
   * 于是它默认设置成了兰州」。
   *
   * `resolveHome()` 里早就准备好了那句话，但**没有一个调用点读过 `problem`** ——
   * 全都只用 `.city`。于是设置里写着常熟、面板上写着兰州，中间一句解释都没有。
   */
  const world = makeWorld(seed({ phase: 'home', hereId: 'lanzhou', homeId: 'lanzhou' }), { homeCity: '火星' });
  await world.start(fakeHost());

  const snap = world.uiSnapshot();
  assert.ok(snap.homeProblem, '出发地认不出来，面板上一个字都没说');
  assert.match(snap.homeProblem, /火星/, '得说清是哪个名字没认出来');
  assert.match(snap.homeProblem, /兰州/, '还得说清先按哪里算');
});

test('重启之后，同一个地方还是同一家旅馆', async () => {
  /*
   * 2026-11-03 Mr.Q：「她每天的宾馆本身都定下来了，后面又换了一家旅馆」。
   *
   * 根因：作息表（`plan`）只活在内存里，没有任何一处从磁盘恢复 ——
   * 所以**每重启一次扩展，住宿就重新掷一次**。那天为了发版重启了十二次。
   *
   * 修法：住宿改成按「城 + 这次入住从哪天开始 + 钱紧不紧」算种子，
   * 重启多少次都是同一家；钱紧了种子跟着变，所以「紧就换便宜」照样成立。
   */
  const dir = seed({
    phase: 'staying', hereId: 'jiuzhaigou', homeId: 'lanzhou',
    stayStartedAt: '2026-11-03T06:20:19.895Z', stayDateKey: '2026-11-03',
  });

  const first = makeWorld(dir, {});
  await first.start(fakeHost());
  const a = first.plan?.lodging;
  assert.ok(a, '第一次启动没排作息表');

  const second = makeWorld(dir, {});
  await second.start(fakeHost());
  const b = second.plan?.lodging;
  assert.ok(b, '第二次启动没排作息表');

  const key = (l) => `${l.name ?? ''}|${l.kind ?? ''}|${l.price ?? ''}`;
  assert.equal(key(a), key(b), `重启一次就换了一家：${key(a)} → ${key(b)}`);
});

test('碰面：配了地址，作息表里就带上「谁也在这儿」', async () => {
  /*
   * 2026-11-04 Mr.Q：想让她看见「昨天有只叫 XX 的也来过这儿」，
   * 几只宠物一块逛、一块吃饭、一块住 —— 最多四个。
   * **不能留言、不能加好友、不能私聊。**
   *
   * 这条测整条链路：起一个假服务器 → 她排作息时拉一次 → 那一句进到当天的事件里。
   * 顺带确认上报真的发出去了（没有上报，别人就看不见她）。
   */
  const { createServer } = await import('node:http');

  const seen = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ method: 'POST', body: JSON.parse(body || '{}') });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    seen.push({ method: 'GET', url: req.url });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, list: [{ pet: '小满', doing: '吃面' }, { pet: '阿七', doing: '逛夜市' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const dir = seed({
      phase: 'staying', hereId: 'xian', homeId: 'lanzhou',
      stayStartedAt: '2026-11-04T00:00:00Z', stayDateKey: '2026-11-04',
    });
    const world = makeWorld(dir, { meetUrl: base });
    await world.start(fakeHost());

    // 1) 拉到了，进了作息表
    const nb = world.plan?.neighbors ?? [];
    assert.equal(nb.length, 2, `没拉到邻居（${nb.length} 个）`);
    assert.equal(nb[0].pet, '小满');

    /*
     * 2) 上报也发了 —— 不发的话别人看不见她。
     *
     * 上报是 `void` 出去的（不 await）：`rebuildPlan` 跑在巡检里，等它 5 秒会卡住整个 tick。
     * 所以这里要给它一点时间落地 —— 不是实现有问题，是测试得按它的约定等。
     */
    for (let i = 0; i < 20 && !seen.some((x) => x.method === 'POST'); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(seen.some((x) => x.method === 'POST'), '只查了没报，别人永远看不见她');
    const posted = seen.find((x) => x.method === 'POST').body;
    assert.equal(posted.pet, '大肥鱼', '上报里没带宠物名');
    assert.equal(posted.city, 'xian');
    assert.ok(['morning', 'afternoon', 'evening', 'night'].includes(posted.slot), `时段不对：${posted.slot}`);

    // 3) 那一句进了叙事
    const { neighborLine } = await import('../src/meet.ts');
    assert.match(neighborLine(nb), /小满和阿七/, '两个名字没连起来');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('ETA 只在跨时区时才标时区', async () => {
  /*
   * 2026-11-04 读者报「12:30 到巴黎，13:15 还没下飞机」—— 其实没错：
   * 面板的「现在」是莫斯科时间、ETA 是巴黎时间，差两小时，两个并排就是会看错。
   *
   * 修法是给 ETA 标时区，但**只在真跨时区时标**。国内飞国内同时区，
   * 加个「（西安时间）」纯属噪音。
   */
  const mk = async (fromId, toId, tz) => {
    const dir = seed({
      phase: 'traveling', hereId: fromId, homeId: 'lanzhou',
      leg: {
        id: 'leg-1', fromId, toId, modeId: 'plane',
        km: 2500, durationWorldHours: 3,
        departedAt: '2026-11-04T06:00:00Z', arriveAt: '2026-11-04T09:00:00Z',
        speed: 1, viaIds: [], createdAt: '2026-11-04T06:00:00Z',
      },
      tripStartedAt: '2026-11-02T00:00:00Z',
    });
    const w = makeWorld(dir, {});
    await w.start(fakeHost());
    return w.uiSnapshot().leg?.eta ?? '';
  };

  const cross = await mk('moscow', 'paris');
  assert.match(cross, /巴黎时间/, `跨时区的 ETA 没标：${cross}`);

  const same = await mk('tianshui', 'xian');
  assert.doesNotMatch(same, /时间）/, `同时区不该加标注：${same}`);
});
