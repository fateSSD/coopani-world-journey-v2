/**
 * 长跑验收：N 个世界天，带不变量断言。
 *
 * 为什么写成「带断言」的：Mr.Q 说「大更新，怕出问题」。
 * 光看「没报错」不够 —— 停摆、状态泄漏、事件重复、账目失真，都不是报错，
 * 是**跑得下去但跑得不对**。所以这里把已知的每条不变量都写成检查项。
 *
 * 用法：
 *   node tools/longrun.mjs 144 plain    # 纯旅行
 *   node tools/longrun.mjs 144 invite   # 带邀约（会反复接约）
 *   node tools/longrun.mjs 144 money    # 带邀约 + 记账 6000（撞打工、买不起、被约去家）
 *   node tools/longrun.mjs 144 goto     # 带邀约 + 记账 + 他反复「点名去哪、怎么去」
 *   node tools/longrun.mjs 144 set      # 带邀约 + 他反复「中午别吃面了」这类改作息
 *
 * 四档都跑过一遍才算过（2026-11-05 的结果见 CHANGELOG 0.5.48）。
 * 退出码非 0 = 有不变量没过。
 */
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { CITIES, cityById } = await import('../src/geo/cities.ts');
const { distanceKm } = await import('../src/geo/distance.ts');
const { localMoment } = await import('../src/clock.ts');

const WORLD_DAYS = Number(process.argv[2] ?? 144);
const MODE = process.argv[3] ?? 'invite';
const SPEED = 24;
const STEP_MS = 60_000;

const dir = mkdtempSync(join(tmpdir(), `journey-${MODE}-`));
let clock = new Date('2026-11-05T00:30:00Z');

const events = [];
const warns = [];
const host = {
  log: {
    trace() {}, debug() {}, info() {},
    warn(m) { warns.push(String(m)); },
    error(m) { warns.push(String(m)); },
  },
  pushEvent: async (e) => {
    events.push({ type: String(e.type), key: String(e.senderKey), text: String(e.text), at: String(e.ts) });
    return { ...e, blobs: [] };
  },
  pushDeferred() {}, store: {}, drainPendingEvents: async () => [],
};

/**
 * 长跑里那几个「别人」。
 *
 * 第一个必须是「小满」—— 同城邻居接口只回这个名字，`matesHere` 拿它比对
 * 「接我的话的人是不是真到了」。后面两个只在「多人接同一条邀约」时出现，
 * 用来压多人记账那条路径。
 */
const LONG_RUN_PETS = ['小满', '阿澈', '羽毛笔'];

/* ---------------- 假服务器 ---------------- */
let seq = 0;
const pool = new Map();
const newId = () => (seq++).toString(16).padStart(16, '0');
/**
 * 造一条邀约时挑目标城：七成在她四千公里内，三成全表随机。
 *
 * 见上面那段注释 —— 全表随机会让「拒绝」淹没真实的接约能力。
 */
function pickCity() {
  const here = cityById(st().hereId ?? '');
  if (here && Math.random() < 0.7) {
    const near = CITIES.filter((c) => c.id !== here.id && distanceKm(here, c) <= 4000);
    if (near.length) return near[Math.floor(Math.random() * near.length)];
  }
  return CITIES[Math.floor(Math.random() * CITIES.length)];
}

let acceptTries = 0;
let myTakenChecks = 0;
/*
 * 两段约定（2026-11-07）：先碰头、再一起走。
 *
 * 这三个数是「这条新路到底被走到没有」的唯一证据。没有它们，
 * 长跑全绿也可能一次都没进过那段代码 —— 那是最容易骗过自己的一种绿。
 */
let meetPledges = 0;
let meetWaits = 0;
let meetTogether = 0;
const meetSeen = new Set();
const meetWaitDays = new Map();
let acceptFails = 0;
let acceptOk = 0;
const refusals = [];

if (MODE !== 'plain') {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    /*
     * `mine=1` 是「我发出去的邀约被谁接了」（`myTakenInvites`），和「同城有哪些邀约」
     * 共用同一个端点、同一个正则 —— 原来它掉进了下面那个分支，把别人发的 6 条
     * 全当成「我的邀约被接」，于是 `claimTakenInvite` 一口气认领 6 条，
     * `claimedInvites` 塞满、`takeable` 永远为空。
     *
     * 表现是「她一次都不接别人的约」，看着像世界的 bug，其实是模拟器喂错了数据。
     */
    if (/[?&]mine=1/.test(u)) {
      myTakenChecks++;
      /* 每 7 次回一条 —— 让 `claimTakenInvite` 有覆盖，又不至于常年占着 pledge。 */
      const list = myTakenChecks % 7 === 0
        ? (() => {
            const c = CITIES[Math.floor(Math.random() * CITIES.length)];
            const m = Math.random() < 0.4 ? CITIES[Math.floor(Math.random() * CITIES.length)] : null;
            /*
             * **一条邀约可以有几个人接**（2026-11-11）。
             *
             * 原来这里每次都是 `newId()` + 固定一个「小满」，于是世界那边
             * `same = list.filter(x => x.id === one.id)` 永远只有一条 ——
             * 「多人同行」那条记账路径在长跑里一次都没跑到过。
             *
             * 而那条路径正是 11-11 修的两个 bug 的现场：
             *   ① 到站时把 `whoOf` 的拼接串（「小满、阿澈、羽毛笔」）当人名记账，
             *      会往记忆里写进一个假人；
             *   ② 接单名单被 `.slice(0, 3)` 裁过，第 4、5 位永远进不了记忆。
             *
             * 所以这里改成：同一个 `id`、多条不同 `pet` 的记录，人数 1–3 随机。
             * 名字必须和同城邻居那边一致（见下面邻居接口），否则 `matesHere` 对不上。
             */
            const id = newId();
            const n = Math.random() < 0.35 ? 2 + Math.floor(Math.random() * 2) : 1;
            return Array.from({ length: n }, (_, k) => ({
              id, pet: LONG_RUN_PETS[k] ?? '小满', to: c.id, days: 2, note: '',
              meet: m && m.id !== c.id ? m.id : '', pace: SPEED,
            }));
          })()
        : [];
      return { ok: true, status: 200, json: async () => ({ ok: true, list }) };
    }
    if (/\/invite\?/.test(u)) {
      /*
       * **池子空了才补。**
       *
       * 原来这里是「每看一眼就新造 1-2 条」，而 `list` 只回最后 3 条 ——
       * 于是世界先看一次拿到 id A，紧接着 `journey_accept` 为了「先看清再答应」
       * 又看一次，这两次之间池里已经多了两条，A 被挤出前三，
       * `find` 找不到就报「那条邀约不在了」。
       *
       * 2026-11-06 的 144 天四档跑出来全是这个：邀请档 0 次尝试、money 档 47 次、
       * goto 档 79 次，**一次都没接过**，而看起来像世界的 bug，其实是模拟器不真实 ——
       * 真服务端不会因为你多看一眼睛就多出两条邀约。
       */
      if (pool.size < 6) {
        const n = 6 - pool.size;
        for (let i = 0; i < n; i++) {
          /*
           * **邀约的城市不能全表乱抽**（2026-11-07）。
           *
           * 城市从 146 涨到 183 之后，全表随机抽出来的邀约有一半在跨洲 ——
           * 于是她一天要拒几十条「去圣巴巴拉」的约（买不起票），
           * 统计出来是「接成 4 次 / 没接成 124 条」，看着像世界坏了。
           *
           * 真实池子里的人大多在同一片地方活动：发起人自己也走不到的地方，
           * 他不会发那条邀约。所以七成取她四千公里内的城，三成才全表抽 ——
           * **远处也要留**，跨洲赴约那条路（买不起 / 赶不到）同样得压。
           */
          const c = pickCity();
          /*
           * 四成的邀约带见面城（2026-11-07）。
           *
           * 不带的话，「先碰头再一起走」这条路在长跑里**一次都不会被走到** ——
           * 而它恰恰是最容易出错的那条（两段目的地、等待、窗口重算）。
           * 全是随机城市，所以经常会出现「从没听过的地方碰头再一起去另一处」，
           * 这正是要压的场景。
           */
          const withMeet = Math.random() < 0.4;
          const m = withMeet ? pickCity() : null;
          pool.set(newId(), {
            pet: '小满',
            to: c.id,
            days: 1 + Math.floor(Math.random() * 4),
            note: '',
            meet: m && m.id !== c.id ? m.id : '',
            /*
             * **必须和模拟器自己的倍速一致。**
             *
             * 这个档跑在 SPEED 倍速下（默认 24），而 `paceGap` 会把「1 对 24」
             * 直接判成「凑不到一起」—— 假邀约写死 1 的话，这一档就变成
             * 「每次都拒、一次都不接」，而看着像世界的 bug。
             * 真实世界里两边倍速差太多确实约不成，那是设计；但模拟器不该自己造这种差。
             */
            pace: SPEED,
          });
        }
      }
      /*
       * 回**全部**，不是 `slice(-3)`。
       *
       * 世界那边会把「已经接过 / 让位过」的 id 过滤掉（`claimedInvites`），
       * 只回 3 条的话，这 3 条一旦都被过滤过，列表就空了 —— goto 档 144 天
       * 跑出「0 次尝试」，看着像世界不接约，其实是模拟器把牌发完了。
       */
      const list = [...pool.entries()].map(([id, v]) => ({
        id, pet: v.pet, to: v.to, days: v.days, note: v.note,
        meet: v.meet ?? '', pace: v.pace ?? 0,
      }));
      return { ok: true, status: 200, json: async () => ({ ok: true, list }) };
    }
    if (u.endsWith('/accept')) {
      acceptTries++;
      const body = JSON.parse(init.body);
      const v = pool.get(body.id);
      if (!v) return { ok: false, status: 404, json: async () => ({ ok: false, error: 'gone' }) };
      /* 接了就作数：这条不再挂给别人（真服务端按 MAX_PARTY 扣名额，这里直接摘掉）。 */
      pool.delete(body.id);
      return {
        ok: true, status: 200,
        json: async () => ({
          ok: true, with: v.pet, to: v.to, days: v.days, note: '',
          meet: v.meet ?? '', pace: v.pace ?? 0,
        }),
      };
    }
    if (u.endsWith('/invite')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, id: newId() }) };
    }
    /*
     * 同城邻居（`GET /sight?city=…&date=…&slot=…`）。
     *
     * 2026-11-07 之前这里一律回空数组 —— 那意味着「在见面城等人」这条路
     * **永远等不到人**，只能走到过期。长跑要压的是两条：等到了（一起走）、
     * 等不到（三天后自己走）。所以这里一半概率有人。
     *
     * 名字用「小满」：和池子里那些邀约的发起人同名，`matesHere` 才对得上。
     */
    if (/\/sight\?/.test(u) || /[?&]date=/.test(u)) {
      const list = Math.random() < 0.5 ? [{ pet: '小满', doing: '在等人' }] : [];
      return { ok: true, status: 200, json: async () => ({ ok: true, list, pool: 6 }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, list: [] }) };
  };
}

/* ---------------- 起 World ---------------- */
const cfg = {
  ...JOURNEY_DEFAULTS(),
  enabled: true,
  homeCity: '兰州',
  speed: SPEED,
  restDays: 2,
  maxTripWeeks: 8,
  meetUrl: MODE === 'plain' ? '' : 'https://x.test',
  // goto 档也开着记账：买不起票的那条路径（以及「点名要飞机但没钱」）才有机会被撞到。
  ...(MODE === 'money' || MODE === 'goto' ? { moneyEnabled: true, budget: 6000 } : {}),
  ...(MODE === 'set' ? { moneyEnabled: true, budget: 6000 } : {}),
};
const world = new JourneyWorld({ cfg, dataDir: dir, botName: '大肥鱼', now: () => clock });
await world.start(host);

const tool = (n) => world.tools().find((t) => t.name === n);
const acceptTool = tool('journey_accept');
const goToTool = tool('journey_go_to');
const rentTool = tool('journey_rent_car');
const setSlotTool = tool('journey_set_slot');
let rentOk = 0, rentTries = 0;
const rentFail = [];
let gotoTries = 0, gotoOk = 0, gotoRej = 0;
const gotoBad = [];
const st = () => world.st;

/* ---------------- set 档（2026-11-10 的 journey_set_slot） ---------------- */
let setTries = 0, setOk = 0, setRej = 0;
const setBad = [];
const setRejectWhy = new Map();
const setErrSample = [];
const slotKinds = new Set();
/** 改过的格子，等日程重算之后再看一眼还在不在。 */
const setPending = [];
/** 同一格只改一次 —— 不然「被后一次改动覆盖」会被当成「重算变回去了」。 */
const setTouched = new Set();
let patchPeak = 0;
let patchDays = 0;
let lockedTries = 0;
let lockedRej = 0;

/** 小数小时 → `21:30`。跟工具回执同一个格式 —— 模型会照抄回执里的时刻。 */
const clockOf = (h) => {
  const whole = Math.floor(h);
  return `${String(whole).padStart(2, '0')}:${String(Math.round((h - whole) * 60)).padStart(2, '0')}`;
};

const ticks = Math.ceil((WORLD_DAYS * 86_400_000) / (STEP_MS * SPEED));
const phaseCount = { home: 0, staying: 0, traveling: 0 };
let stuckLeg = 0;
let maxStuckLeg = 0;
let pledgeAges = [];
let pledgeMismatch = 0;
const pledgeMismatchSample = [];

for (let i = 0; i < ticks; i++) {
  clock = new Date(clock.getTime() + STEP_MS);
  await world.tick();
  phaseCount[st().phase] = (phaseCount[st().phase] ?? 0) + 1;

  // 不变量：leg 早该到站却没到（等一个巡检周期不算，超 2 小时算卡住）
  if (st().phase === 'traveling' && st().leg) {
    const late = clock.getTime() - Date.parse(st().leg.arriveAt);
    stuckLeg = late > 7_200_000 ? stuckLeg + 1 : 0;
    maxStuckLeg = Math.max(maxStuckLeg, stuckLeg);
  } else stuckLeg = 0;

  // 不变量：约定不会两边同时成立
  if (st().pledge && st().returning) throw new Error('同守约定又在回家 —— 两条路撞了');

  /*
   * 不变量：约定和「这趟去哪」不能打架（2026-11-06 加）。
   *
   * 抓到过的样子：面板上一边「在飞布宜诺斯艾利斯」一边「跟人说好去稻城亚丁」。
   * 根因是途中认领别人接的邀约 —— 飞机已经起飞，`depart` 里那条「有约就往约的城走」
   * 只在出发那一刻读 pledge，改不了航向。现在 `claimTakenInvite` 途中不认领，
   * `prunePledge` 会把这类脏数据当场作废，所以这里应该永远是 0。
   */
  if (st().pledge && st().phase === 'traveling' && st().leg?.toId) {
    /*
     * **比的是「下一站」，不是最终那座城**（2026-11-07）。
     *
     * 加了见面城之后，赴约的第一段是去会合点：「在飞成都、约的是稻城」是完全正确的。
     * 这条不变量原来拿 `pledge.cityId` 去比，会把每一次正常的两段赴约都判成
     * 「承诺和航向打架」—— 判据没跟上状态，就会把对的当成错的。
     */
    const p0 = st().pledge;
    const stop = p0.meetCityId && !p0.meetArrivedAt ? p0.meetCityId : p0.cityId;
    if (st().leg.toId !== stop) {
      pledgeMismatch++;
      if (pledgeMismatchSample.length < 3) {
        pledgeMismatchSample.push(`${st().leg.toId} ≠ ${stop}`);
      }
    }
  }

  /* ---------------- 两段约定：先碰头，再一起走 ---------------- */
  {
    const pl = st().pledge;
    if (pl && pl.meetCityId) {
      if (!meetSeen.has(pl.inviteId)) {
        meetSeen.add(pl.inviteId);
        meetPledges++;
      }
      /*
       * 不变量：**没到会合点，不许算「一起」**。
       *
       * `arrivedAt` 是「一起待 N 天」的起点。它比 `meetArrivedAt` 先有值，
       * 就意味着两个人还没见上，账就开始算了 —— 她会说「我们一起待了三天」，
       * 而实际那三天她一个人在成都等人。
       */
      if (pl.arrivedAt && !pl.meetArrivedAt) {
        throw new Error(`没到会合点就记成「一起」了：${pl.inviteId}`);
      }
      // 在会合点等着的那些天：按「约定 + 日期」去重，一天算一次
      if (pl.meetArrivedAt && !pl.arrivedAt
          && st().phase === 'staying' && st().hereId === pl.meetCityId) {
        const k = `${pl.inviteId}:${st().stayDateKey}`;
        if (!meetWaitDays.has(k)) {
          meetWaitDays.set(k, 1);
          meetWaits++;
          const days = [...meetWaitDays.keys()].filter((x) => x.startsWith(`${pl.inviteId}:`)).length;
          /*
           * 不变量：**不能死等**。
           *
           * 「继续等」是他定的口径，但等待必须有出口 —— `MEET_WAIT_WINDOW_MS`
           * 是三天。这里放到 7 天是留余量（时区、跨天判定、窗口按到站重算），
           * 真到 7 天还没动，说明那个窗口根本没生效。
           */
          if (days > 7) throw new Error(`在会合点等了 ${days} 天还没走 —— 等待没有出口`);
        }
      }
      if (pl.arrivedAt && pl.meetArrivedAt && !meetSeen.has(`${pl.inviteId}:together`)) {
        meetSeen.add(`${pl.inviteId}:together`);
        meetTogether++;
      }
    }
  }

  // 不变量：约定不会无限期挂着（接下一份三天内必定到或作废）
  if (st().pledge && !st().pledge.arrivedAt) {
    const age = clock.getTime() - Date.parse(st().pledge.acceptedAt);
    pledgeAges.push(age);
    if (age > 4 * 86_400_000) throw new Error(`约定挂了 ${Math.round(age / 86400000)} 天还没作废`);
  }

  /*
   * 模拟她「看到有人找伴就去接」：每 29 个巡检试一次。
   *
   * **只在兜里有钱的时候试。**（2026-11-07 修）
   *
   * 原来无条件试，而「接不接得成」取决于票钱：money 档两次连跑，一次接成 13 次、
   * 一次 0 次（那趟她几乎全程破产），于是「邀约真的接成过」这条断言偶发红。
   * 这不是产品行为，是把随机量当断言。钱够才试，这条才守得住。
   */
  const purseLeft = 6000 - (st().spent - st().earned);
  const canAffordInvite = MODE !== 'money' || purseLeft >= 1500;
  if (MODE !== 'plain' && canAffordInvite && st().phase === 'staying' && !st().pledge && i % 29 === 0) {
    const r = await acceptTool.handler({});
    if (r && !r.isError) {
      /*
       * **把列表里能看见的都试一遍，不是死磕第一条**（2026-11-07）。
       *
       * 原来只取第一行的 id：那条要是去不了 / 买不起，她就一遍遍拒同一条，
       * 池子不腾空、列表不变，于是「144 天接成 0 次」—— 看着像世界不接约，
       * 其实是模拟器只认得列表第一行。真人会往下翻，挑一条走得成的。
       *
       * 最多试三条：服务端一次也只回三条，全试一遍就是她真能做出的选择。
       */
      const ids = [...String(r.text).matchAll(/id=([a-f0-9]{16})/g)].map((m) => m[1]).slice(0, 3);
      for (const id of ids) {
        const got = await acceptTool.handler({ id });
        if (!got.isError) { acceptOk++; break; }
        acceptFails++;
        if (refusals.length < 5) refusals.push(String(got.text).slice(0, 70));
      }
    }
  }

  /*
   * 偶尔在城里租辆车（2026-11-06 的新功能 —— 不覆盖等于没测）。
   *
   * 要覆盖三条：租得到、租期内城里真的开车、到期自动还。
   * 只在 goto 档做，别的档已经够忙了。
   */
  /*
   * **只在付得起的时候试租。**（2026-11-07 修）
   *
   * 原来是无条件每 97 拍试一次，而「租不租得到」取决于她当时兜里有没有钱：
   * 同一份代码连跑，一次租到 33 回，一次 0 回（那一趟她几乎全程破产，
   * 150 次点名被拒 145 次）。于是 `rentOk > 0` 这条断言偶发红。
   *
   * 修法不是把阈值放软，是**让输入变成确定的**：钱够才去租。
   * 这样「想租就该租得到」才是能断言的**行为**，而不是碰运气的结果。
   */
  const left = 6000 - (st().spent - st().earned);
  if (MODE === 'goto' && st().phase === 'staying' && !st().car && i % 97 === 0 && left >= 600) {
    const r = await rentTool.handler({ days: 2 });
    rentTries++;
    if (!r.isError) rentOk++;
    else if (rentFail.length < 3) rentFail.push(String(r.text).slice(0, 60));
  }

  /*
   * 模拟「他随口说去哪、怎么去」：每 53 个巡检试一次。
   *
   * 这一档要抓的不是「能不能走」，是**走错**：
   *   - 要了成都却去了别处（被骰子盖掉）
   *   - 说了坐高铁却上了大巴（静默替换 —— 用户来信投诉的正是这个）
   *   - 出发了 `work` 还挂着（打工那条状态泄漏到下一座城）
   *   - 回程里又开了一趟（第二天一早还得掉头）
   *   - 被拒了却动了身（错误路径写了状态）
   */
  if (MODE === 'goto' && st().phase !== 'traveling' && i % 53 === 0) {
    const dest = CITIES[Math.floor(Math.random() * CITIES.length)];
    const wants = ['', '', '高铁', '飞机', '自驾', '大巴', '轮船', '自行车', '步行', '坐火箭'];
    const want = wants[Math.floor(Math.random() * wants.length)];
    const before = st();
    const depBefore = events.filter((e) => e.type === 'journey.depart').length;
    const r = await goToTool.handler({ city: dest.name, ...(want ? { mode: want } : {}) });
    gotoTries++;
    const depAfter = events.filter((e) => e.type === 'journey.depart').length;
    if (r.isError) {
      gotoRej++;
      if (before.phase !== st().phase) gotoBad.push(`被拒却动了身：${String(r.text).slice(0, 40)}`);
      if (depAfter !== depBefore) gotoBad.push(`被拒却推了「出发了」：${String(r.text).slice(0, 40)}`);
    } else {
      gotoOk++;
      if (st().leg?.toId !== dest.id) gotoBad.push(`要${dest.name}却去了${st().leg?.toId}`);
      if (st().work) gotoBad.push('出发了还挂着工');
      if (st().returning) gotoBad.push('回程里还开了新的一趟');
      if (!(st().leg?.km > 0)) gotoBad.push(`公里数是 ${st().leg?.km}`);
      if (want && want !== '坐火箭') {
        const m = { 高铁: 'train', 飞机: 'plane', 自驾: 'car', 大巴: 'bus', 轮船: 'ship', 自行车: 'bike', 步行: 'walk' }[want];
        if (st().leg?.modeId !== m) gotoBad.push(`说了${want}却安排了${st().leg?.modeId}`);
      }
    }
  }

  /*
   * ---------------- set 档：改作息与吃食（journey_set_slot） ----------------
   *
   * 要抓的不是「能不能改」，是**改了之后还算不算数**：
   *   - 回执说改了、表里没变（撒谎）
   *   - 日程一重算就变回去（补丁没贴回）—— 比「改不了」坏，用户以为已经改了
   *   - 被拒了却动了状态（错误路径写了东西）
   *   - 景点格 / 住处格被自由文本改掉（绕过候选表，说出这家店没有的东西）
   */
  if (MODE === 'set') {
    const plan = world.plan;

    for (let k = setPending.length - 1; k >= 0; k--) {
      const q = setPending[k];
      q.waited++;
      if (!plan || plan.dateKey !== q.dateKey) { setPending.splice(k, 1); continue; }
      const b = plan.beats.find((x) => x.at === q.at);
      if (!b) { setPending.splice(k, 1); continue; }
      if (b.what !== q.what) {
        setBad.push(`重算之后变回去了：${q.at} 现在是「${b.what.slice(0, 16)}」`);
        setPending.splice(k, 1);
        continue;
      }
      // 40 个世界分钟里一直在 —— 中间至少重排过一次，够了
      if (q.waited > 40) setPending.splice(k, 1);
    }

    const here = cityById(st().hereId);
    if (st().phase === 'staying' && here && plan) {
      /*
       * **必须用 `world.worldNow()`，不是脚本里的 `clock`**（2026-11-10 踩到）。
       *
       * `clock` 是真实时钟（每拍 +1 分钟），世界时钟是它的 24 倍 —— 拿 `clock` 算
       * 「当地几点」，挑出来的格子一半其实已经过去了，于是满屏「已经过去了」，
       * 看着像工具的毛病，其实是这一行的锅。表是 `rebuildPlan(worldNow())` 排的，
       * 拿它比才对得上。
       */
      const nowDec = localMoment(world.worldNow(), here.tz).decimal;
      const ahead = plan.beats.filter((b) => b.at > nowDec + 0.05);
      const sig = () => (world.plan?.beats ?? []).map((x) => `${x.at}:${x.what}`).join('|');

      /* 受保护的两格：景点归 plan_change，住处归 hotel_night。自由文本必须被挡。 */
      if (i % 61 === 0) {
        const locked = ahead.filter((b) => b.kind === 'activity' || b.kind === 'hotel');
        if (locked.length) {
          const b = locked[i % locked.length];
          const before = sig();
          const r = await setSlotTool.handler({ time: clockOf(b.at), what: '在泳池游了二十分钟' });
          setTries++;
          lockedTries++;
          if (!r.isError) setBad.push(`${b.kind} 格被自由文本改了：${String(r.text).slice(0, 40)}`);
          else {
            setRej++;
            lockedRej++;
            if (sig() !== before) setBad.push(`被拒却动了表：${b.kind} 格`);
          }
        }
      }

      /* 自由格：一半给类型词（模型不知道当天是 18:30 还是 19:30），一半给钟点。 */
      if (i % 11 === 0) {
        const freeKinds = new Set(['wake', 'breakfast', 'lunch', 'dinner', 'sleep', 'night', 'beat']);
        const free = ahead.filter(
          (b) => freeKinds.has(b.kind) && !setTouched.has(`${plan.dateKey}:${b.at}`),
        );
        if (free.length) {
          const b = free[Math.floor(Math.random() * free.length)];
          const word = { wake: '起床', breakfast: '早饭', lunch: '午饭', dinner: '晚饭', sleep: '睡觉', night: '夜里' }[b.kind];
          const byWord = !!word && Math.random() < 0.5;
          const what = `测试改动 ${setTries}`;
          const r = await setSlotTool.handler({ time: byWord ? word : clockOf(b.at), what });
          setTries++;
          if (r.isError) {
            setRej++;
            const why = String(r.text).replace(/[0-9:：]/g, '').slice(0, 10);
            setRejectWhy.set(why, (setRejectWhy.get(why) ?? 0) + 1);
            if (setErrSample.length < 6) {
              setErrSample.push(
                `${b.kind}@${b.at}→${byWord ? word : clockOf(b.at)} now=${nowDec.toFixed(3)}`
                + ` 日期 ${plan.dateKey}/${world.plan?.dateKey}｜${String(r.text).slice(0, 24)}`,
              );
            }
          } else {
            setOk++;
            slotKinds.add(b.kind);
            setTouched.add(`${plan.dateKey}:${b.at}`);
            if (!byWord) {
              // 按钟点改，命中就必须是那一格，内容也得对得上
              const hit = (world.plan?.beats ?? []).find((x) => x.at === b.at);
              if (!hit) setBad.push(`改完表里没有 ${b.at} 这一格了`);
              else if (hit.what !== what) setBad.push(`回执说改了，表里还是「${hit.what.slice(0, 20)}」`);
              else setPending.push({ dateKey: plan.dateKey, at: b.at, what, waited: 0 });
            }
          }
        }
      }

      const patches = st().planPatches ?? [];
      patchPeak = Math.max(patchPeak, patches.length);
      patchDays = new Set(patches.map((x) => x.dateKey)).size;
    }
  }
}

/* ---------------- 断言 ---------------- */
const fail = [];
const ok = (cond, label, detail = '') => { if (!cond) fail.push(`${label}${detail ? ` —— ${detail}` : ''}`); };

const byType = new Map();
for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);

// 1. 零告警
ok(warns.length === 0, '告警为 0', warns.slice(0, 3).join(' / '));

// 2. 事件 key 不重复（同一个 senderKey 只许推一次）
const keys = events.map((e) => e.key);
const dup = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
ok(dup.length === 0, '没有重复推的事件', dup.slice(0, 3).join(', '));

// 3. 从来没有卡在路上
ok(maxStuckLeg < 3, '没有卡在路上', `最长连续 ${maxStuckLeg} 次巡检超时未到站`);

// 3b. 约定和这趟的去向不许打架（2026-11-06）
ok(pledgeMismatch === 0, '约定和当前这趟没打架', pledgeMismatchSample.join(' / '));

// 3c. 邀约这一档必须真的接成过 —— 否则测的是「她从来不接」，不是「接了会怎样」
/*
 * 只要求 invite / money 两档。
 *
 * goto 档不要求：那一档每 53 个巡检就点一次名，她大半时间在车上或者刚落地就被
 * 带走，`staying && !pledge && i%29===0` 三个条件同时成立的窗口极窄 ——
 * 144 天里真的接成 0 次是正常的，不是坏了。这一档要抓的是「点名有没有照办」
 * 和「约定让位会不会推重」（2026-11-06 就是它抓到的），不是邀约。
 */
if (MODE === 'invite' || MODE === 'money') {
  ok(acceptOk > 0, '邀约真的接成过（否则这一档等于没测）',
    `接成 ${acceptOk} / 没接成 ${acceptFails} / 真的发出「接」${acceptTries}`);
  /*
   * 「先碰头再一起走」这条路必须真的被走过。
   *
   * 2026-11-07 这一版里，两段约定是最容易「看起来在做、其实没走到」的一处：
   * 协议字段加了、代码写了，但模拟器不给带见面城的邀约，长跑照样全绿。
   * 所以这里要求**至少有一份两段约定**。
   *
   * 只要求「出现过」，不要求「一起走成」：走成与否取决于「同城有没有见着人」，
   * 那是掷硬币，144 天里偶尔为 0 是正常的 —— 把它写成硬断言，等于给自己
   * 造一条会偶发失败的测试。
   */
  ok(meetPledges > 0, '两段约定（先碰头再一起走）真的出现过',
    `出现 ${meetPledges} 份 / 等待 ${meetWaits} 天 / 走成 ${meetTogether} 次`);
}

// 4. 三种阶段都出现过（说明状态机在转，没停在一个阶段）
ok(phaseCount.staying > 0 && phaseCount.traveling > 0, '状态机在动', JSON.stringify(phaseCount));

// 5. 事件里不许出现 undefined / NaN
const dirty = events.filter((e) => /undefined|NaN|\[object/.test(e.text));
ok(dirty.length === 0, '事件正文里没有 undefined/NaN', dirty.slice(0, 2).map((e) => e.text.slice(0, 60)).join(' | '));

// 6. 提到地名的事件里，地名必须是城市表里的（防「去了不存在的地方」）
const badCity = [];
for (const e of events) {
  if (e.type !== 'journey.arrive') continue;
  const m = /到了。(\S+?)，/.exec(e.text);
  if (m && !CITIES.some((c) => c.name === m[1])) badCity.push(m[1]);
}
ok(badCity.length === 0, '没有编出来的地名', [...new Set(badCity)].join(','));

/*
 * 5b. 每天的正文必须带时刻（2026-11-07）。
 *
 * `journey.day` 是在当地刚过零点推的。只写日期不写时间，用户那边还是 23:5x 的时候
 * 她会以为「日期跳了」——Mr.Q 当场就问「时区出问题了？」。
 * 宿主不给她当前时间，这条事件是她唯一的机会。
 */
const dayEvents = events.filter((e) => e.type === 'journey.day');
const noClock = dayEvents.filter((e) => !/刚过零点|[零一二三四五六七八九十]+点/.test(e.text));
ok(noClock.length === 0, '每天的正文都带了时刻',
  `${dayEvents.length} 条里 ${noClock.length} 条没有：${noClock[0]?.text.slice(0, 50) ?? ''}`);

// 6b. 不许再出现「448 小时」这种机器读数
const hugeHours = events.filter((e) => /(\d{3,}) 小时|(\d{3,}) 个多小时/.test(e.text));
ok(hugeHours.length === 0, '没把几百小时写在正文里', hugeHours.slice(0, 2).map((e) => e.text.slice(-40)).join(' | '));

// 7. 出发 / 到站配平（允许最后差 1，因为可能在路上）
const dep = byType.get('journey.depart') ?? 0;
const arr = byType.get('journey.arrive') ?? 0;
ok(dep - arr === 0 || dep - arr === 1, '出发和到站对得上', `depart ${dep} / arrive ${arr}`);

// 8. 每天事件量合理（不是简报轰炸机）
const perDay = events.length / WORLD_DAYS;
ok(perDay > 1 && perDay < 20, '每天事件量合理', `${perDay.toFixed(1)} 条/天`);

// 9. 回家的四种原因都在允许集合里
const homeTexts = events.filter((e) => e.type === 'journey.home').map((e) => e.text);
ok(homeTexts.every((t) => /待够|上限|短工|叫/.test(t)), '回家原因都能看懂', homeTexts.find((t) => !/待够|上限|短工|叫/.test(t)) ?? '');

// 10. 记账：花销与收入非负，且不是 0（钱真的在动）
if (MODE === 'money') {
  ok(st().spent >= 0 && st().earned >= 0, '账目非负', `spent ${st().spent} earned ${st().earned}`);
  ok(st().spent > 1000, '钱真的在流动', `spent ${st().spent}`);
}

// 11. 状态文件不膨胀
const size = statSync(join(dir, 'state.json')).size;
ok(size < 200_000, '状态文件没有膨胀', `${(size / 1024).toFixed(1)} KB`);

// 12. 点名去哪就去哪、点名怎么去就怎么去（goto 档）
if (MODE === 'goto') {
  ok(gotoBad.length === 0, '他说去哪/怎么去，都照办了', gotoBad.slice(0, 5).join(' | '));
  /*
   * **这条原来写成 `gotoOk > 3`，会偶发红。**（2026-11-07 修）
   *
   * 同一份代码连跑两次：成功 5 次那次全绿，成功 2 次那次红 —— 而「成功几次」
   * 不是代码行为，是**她当时兜里有没有钱**的随机结果：这一档点名的是全世界的城，
   * 一个 3421 公里的札幌要几千块，买不起就按规矩拒（「答应了买不起票，
   * 第二天就得反悔，比不接难看」）。144 天里攒够钱点名的次数本来就是 2–5 次。
   *
   * 所以守两件事就够了，都跟随机量无关：
   *   1. 这条路**真的被走过**（成功 ≥ 1）；
   *   2. 被拒的那条分支也**真的走过**（拒绝 > 0）—— 只有成功没有拒绝，
   *      说明模拟器根本没点过买不起的城，「拒绝时不乱动」那几条断言等于没跑。
   */
  ok(gotoOk >= 1, 'goto 真的走成过（否则这一档等于没测）', `成功 ${gotoOk} / 拒绝 ${gotoRej} / 尝试 ${gotoTries}`);
  ok(gotoRej > 0, 'goto 也真的被拒过（否则「拒了不乱动」没测到）', `成功 ${gotoOk} / 拒绝 ${gotoRej}`);
  /*
   * 租车：**付得起就该租得到**（行为断言），且这条路真的走过（路径断言）。
   *
   * 试租只在钱够的时候发生（见上面那段），所以这里的 `rentOk === rentTries`
   * 不再是随机量 —— 有失败就说明是代码问题，不是她穷。
   */
  ok(rentTries > 0, '租车这条路走过（钱够的时候）', `试了 ${rentTries} 次`);
  ok(rentTries === rentOk, '付得起就租得到',
    `${rentTries} 次里失败 ${rentTries - rentOk} 次：${rentFail.join(' | ')}`);
}

if (MODE === 'set') {
  ok(setTries > 0, '改作息这条路走过（否则这一档等于没测）', `试了 ${setTries} 次`);
  ok(setOk > 0, '真的改成过', `成功 ${setOk} / 被拒 ${setRej}`);
  ok(lockedTries > 0 && lockedRej === lockedTries, '景点格与住处格一律挡回去',
    `试了 ${lockedTries} 次，挡了 ${lockedRej} 次`);
  ok(setBad.length === 0, '改了就一定算数（重算后不变回去、被拒不动表）', setBad.slice(0, 4).join(' | '));
}

/* ---------------- 记忆对账：登记的人，每一个都得是「一个人」 ---------------- */

/*
 * 2026-11-11 加。守的是那个已经修掉的 bug：
 * `rememberPet(this.whoOfPledge(...))` 把「小满、阿澈」这种给句子用的拼接串
 * 当成人名写进记忆 —— 单人时凑巧等于人名，三个人一起走到站就写进一个假人，
 * 而真正的三个人一个都没记上。
 *
 * 判据两条，都不依赖具体实现：
 *   1. 键里不许出现 `、` 或 `和`（那两样只出现在拼接串里）；
 *   2. 每个登记过的人，`times` 至少是 1 —— 记了名却没走过，说明记账写歪了。
 *
 * 之前 `plain` 档不接约，`pets` 永远是空表，这条检查跑不到东西 ——
 * 所以只在 `MODE !== 'plain'` 里做。
 */
if (MODE !== 'plain') {
  const pets = st().pets ?? {};
  const keys = Object.keys(pets);
  for (const key of keys) {
    if (/[、和]/.test(key)) {
      fail.push(`记忆里出现了一个叫「${key}」的人 —— 多人同行的名字被拼成了一串`);
    }
    if (!(Number(pets[key]?.times) >= 1)) {
      fail.push(`「${key}」记了名但从没走过（times=${pets[key]?.times}）—— 记账写歪了`);
    }
  }
  console.log(`记忆里 ${keys.length} 个人：${keys.join('、') || '（无）'}`);
}

/* ---------------- 报告 ---------------- */
console.log(`==== ${MODE} · ${WORLD_DAYS} 个世界天 ====`);
console.log(`巡检 ${ticks} 次 / 倍速 ${SPEED}x / 真实约 ${(ticks * STEP_MS / 3_600_000).toFixed(1)} 小时`);
console.log('阶段占比', phaseCount);
console.log('事件', [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('  ') || '（无）');
console.log(`事件总量 ${events.length}（${perDay.toFixed(1)} 条/世界天）`);
if (MODE !== 'plain') {
  /*
   * 口径分开写：`acceptFails` 数的是「没接成」，包含前置拒绝（走不开、买不起、
   * 去不了），那些**根本没发出请求**。`acceptTries` 只数真正打出去的 `/accept`。
   * 原来写成「被拒 167 次（3 次尝试）」，读起来像数字对不上。
   */
  /*
   * 口径（2026-11-07 改）：`acceptFails` 现在数的是「**看过的邀约里没接成几条**」，
   * 因为驱动改成了一次把列表里三条都试一遍（只磕第一条会永远卡在同一条上）。
   * `acceptTries` 只数真的打出去的 `/accept` —— 前置就拒掉的（走不开、买不起、赶不到）不算。
   */
  console.log(`邀约：接成 ${acceptOk} 次 / 没接成 ${acceptFails} 条（真的发出「接」${acceptTries} 次）`);
  console.log(`两段约定：出现过 ${meetPledges} 份｜在会合点等待 ${meetWaits} 天｜从会合点一起走成 ${meetTogether} 次`);
  const inv = events.filter((e) => e.type === 'journey.invite');
  console.log(`journey.invite 事件 ${inv.length} 条`);
}
if (MODE === 'goto') {
  console.log(`点名去哪：走成 ${gotoOk} 次，被拒 ${gotoRej} 次（共 ${gotoTries} 次）｜租车 ${rentOk}/${rentTries} 次`);
  if (gotoBad.length) console.log('不合规样本', gotoBad.slice(0, 6));
}
if (MODE === 'set') {
  console.log(`改作息：成功 ${setOk} / 被拒 ${setRej}（共 ${setTries} 次）｜受保护格挡回 ${lockedRej}/${lockedTries}`);
  console.log(`改到过的格：${[...slotKinds].sort().join('、') || '（无）'}`);
  console.log(`补丁条数峰值 ${patchPeak}，覆盖 ${patchDays} 个日期`);
  if (setRejectWhy.size) {
    console.log('拒绝原因', [...setRejectWhy.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('  '));
  }
  if (setBad.length) console.log('不合规样本', setBad.slice(0, 6));
  if (setErrSample.length) console.log('被拒样本', setErrSample);
}
console.log(`去过 ${st().everVisited.length} 个地方｜花销 ${st().spent}｜挣了 ${st().earned}｜打工 ${st().workStints} 次`);
console.log(`当前 ${st().phase} ${st().hereId}｜pledge ${st().pledge ? st().pledge.cityId : 'none'}`);
console.log('告警', warns.length ? warns.slice(0, 5) : '无');
console.log('拒绝原因样本', refusals.length ? refusals : '无');
console.log('最后 5 条事件：');
for (const e of events.slice(-5)) console.log(' -', e.type, '|', e.text.split('\n')[0].slice(0, 90));
console.log(fail.length ? `\n❌ ${fail.length} 项不变量没过：\n - ${fail.join('\n - ')}` : '\n✅ 全部不变量通过');

world.stop();
if (fail.length) process.exitCode = 1;
