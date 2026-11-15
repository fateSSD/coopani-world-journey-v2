/**
 * 这个扩展里最该被测试盯住的四件事。
 *
 * 不是"代码跑得通"，是**算出来对不对**：
 *   距离 → 时长 → 作息表 → 概率分布。
 * 这四层任何一层歪了，表现都是"她说的话听着不太对"，而日志一片祥和。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';

import { CITIES, cityById, cityByName, isForeign, expandSlots, spotDays, spotName } from '../src/geo/cities.ts';
import { HOME_RADIUS_KM, JOURNEY_DESCRIBE, JourneyWorld, roadText, whoOf } from '../src/world.ts';
import { JOURNEY_DEFAULTS } from '../src/config.ts';
import { actionsPrompt } from '../src/pet-vocab.ts';
import { PILGRIMS, pilgrimAt, pilgrimsOf } from '../src/geo/pilgrim.ts';
import { distanceKm, waypoints, haulOf, bearingDeg, angleBetween } from '../src/geo/distance.ts';
import { MODES, modeById, hoursFor, reachable } from '../src/geo/modes.ts';
import { sunTimes } from '../src/geo/sky.ts';
import { localMoment, localHour, utcFromLocal, shiftDateKey, humanHours, tzOffsetLabel } from '../src/clock.ts';
import { planDay, fmtHour, spotText } from '../src/plan/dayplan.ts';
import { rollLodging } from '../src/plan/lodging.ts';
import { pickDestination, pickMode, buildJourney, progressOf, beatMarks, beatKey, sentProgress, beatGapText, landLinked, canTravel } from '../src/plan/journey.ts';
import { climateOf, affinity, bodyFeeling } from '../src/geo/climate.ts';
import { feelOf, isWet, isMurky, AmapWeather } from '../src/geo/amap.ts';
import { rollTrouble, TROUBLES } from '../src/easter.ts';
import { cityMentioned, readNowPlaying, snapshotPaths } from '../src/music-peer.ts';
import { photoPrompt, photoTitle, spotFromBeat, skyOf } from '../src/photo.ts';
import { makeSchedule, scheduleText } from '../src/plan/timetable.ts';
import { pickHotel, resolveTier, tierFromAmapType, tierFromName, tierFromOsm } from '../src/geo/hotels.ts';
import { lodgingLabel, withHotel } from '../src/plan/lodging.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LZ = cityById('lanzhou');
const XA = cityById('xian');
const HS = cityById('huangshan');
const PARIS = cityById('paris');

test('城市表：id 唯一，坐标在合法范围', () => {
  const ids = new Set();
  for (const c of CITIES) {
    assert.ok(!ids.has(c.id), `重复的城市 id: ${c.id}`);
    ids.add(c.id);
    assert.ok(Math.abs(c.lat) <= 90, `${c.name} 纬度越界`);
    assert.ok(Math.abs(c.lon) <= 180, `${c.name} 经度越界`);
    assert.ok(c.tz.includes('/'), `${c.name} 时区不是 IANA 格式：${c.tz}`);
  }
  assert.ok(CITIES.length >= 60, `城市太少：${CITIES.length}`);
});

test('城市表：港口标记必须是水边城市，不能出现内陆港口', () => {
  // 这一条盯的是「从兰州坐船出发」这类幻觉。兰州在黄河边但不是客运码头。
  for (const id of ['lanzhou', 'xian', 'beijing', 'chengdu', 'guiyang', 'kunming']) {
    const c = cityById(id);
    assert.equal(c.port, false, `${c.name} 不该有客运码头`);
  }
  for (const id of ['shanghai', 'qingdao', 'xiamen']) {
    assert.equal(cityById(id).port, true, `${cityById(id).name} 应该有码头`);
  }
});

test('城市表：按名字查，带「市」后缀也认', () => {
  assert.equal(cityByName('兰州')?.id, 'lanzhou');
  assert.equal(cityByName('兰州市')?.id, 'lanzhou');
  assert.equal(cityByName('lanzhou')?.id, 'lanzhou');
  assert.equal(cityByName('不存在的城市'), null);
});

test('距离：兰州→西安在 500-620 公里之间', () => {
  const km = distanceKm(LZ, XA);
  assert.ok(km > 500 && km < 620, `实际 ${km.toFixed(0)} km`);
});

test('距离：兰州→巴黎跨洲，量级要上万', () => {
  const km = distanceKm(LZ, PARIS);
  assert.ok(km > 7000 && km < 9000, `实际 ${km.toFixed(0)} km`);
  assert.equal(haulOf(km), 'intercontinental');
});

test('途经点：兰州→西安会经过宝鸡或天水一带', () => {
  const via = waypoints(LZ, XA, 90).map((c) => c.id);
  assert.ok(via.length > 0, '一个途经点都没有，走廊太窄');
  assert.ok(!via.includes('lanzhou') && !via.includes('xian'), '终点不该出现在途经里');
});

test('交通时长：同一段距离，步行与飞机差两个数量级', () => {
  const km = distanceKm(LZ, XA);
  const walk = hoursFor(modeById('walk'), km);
  const plane = hoursFor(modeById('plane'), km);
  assert.ok(walk > plane * 20, `步行 ${walk} 小时 vs 飞机 ${plane} 小时，差得不够`);
});

test('交通时长：短途飞机不见得比火车快（固定开销在起作用）', () => {
  const km = 500;
  const train = hoursFor(modeById('train'), km);
  const plane = hoursFor(modeById('plane'), km);
  // 500 km：火车约 5 小时，飞机约 3.9 小时 —— 快，但没有压倒性优势。
  assert.ok(plane < train, '这个距离飞机应该更快');
  assert.ok(train - plane < 1.5, `差 ${(train - plane).toFixed(1)} 小时，固定开销没起作用`);
});

test('交通上限：步行不能用于五百公里', () => {
  assert.equal(reachable(modeById('walk'), 500), false);
  assert.equal(reachable(modeById('plane'), 500), true);
  assert.equal(reachable(modeById('ship'), 500), true, '船没有距离上限，靠码头判断');
});

test('选交通：5000 公里绝不返回步行/自行车/电瓶车', () => {
  for (let i = 0; i < 300; i++) {
    const m = pickMode(LZ, PARIS, 7900);
    assert.ok(m, '跨洲应该有可选方式');
    assert.ok(!['walk', 'bike', 'scooter', 'motorcycle', 'bus', 'car'].includes(m.id),
      `跨洲选了 ${m.name}`);
  }
});

test('选交通：内陆城市之间不会选轮船', () => {
  const cd = cityById('chengdu');
  for (let i = 0; i < 300; i++) {
    const m = pickMode(LZ, cd, distanceKm(LZ, cd));
    assert.notEqual(m?.id, 'ship', '兰州到成都之间不该有船');
  }
});

test('选交通：有码头的水路城市之间，船是可能被选中的', () => {
  const sh = cityById('shanghai');
  const wh = cityById('wuhan');
  let ships = 0;
  for (let i = 0; i < 2000; i++) {
    if (pickMode(wh, sh, distanceKm(wh, sh))?.id === 'ship') ships++;
  }
  assert.ok(ships > 0, '武汉到上海两千年都没选到船，权重有问题');
});

test('日出日落：黄山十月末，日出在六点前后', () => {
  const s = sunTimes(HS.lat, HS.lon, new Date('2026-10-31T04:00:00Z'));
  assert.ok(s, '算不出日出');
  const h = localHour(s.sunriseUtc, HS.tz);
  assert.ok(h > 5.8 && h < 6.9, `当地日出 ${h.toFixed(2)} 点，偏离太多`);
});

test('日出日落：巴黎夏冬两季差三小时以上（夏令时/季节）', () => {
  const summer = sunTimes(PARIS.lat, PARIS.lon, new Date('2026-06-21T12:00:00Z'));
  const winter = sunTimes(PARIS.lat, PARIS.lon, new Date('2026-12-21T12:00:00Z'));
  const hs = localHour(summer.sunriseUtc, PARIS.tz);
  const hw = localHour(winter.sunriseUtc, PARIS.tz);
  assert.ok(hw - hs > 2.5, `夏令 ${hs.toFixed(1)} vs 冬至 ${hw.toFixed(1)}，差得不够`);
});

test('日出日落：极圈内返回 null，不是假时间', () => {
  // 斯瓦尔巴一带（78°N）六月是极昼、十二月是极夜。
  assert.equal(sunTimes(78, 15, new Date('2026-06-21T12:00:00Z')), null);
  assert.equal(sunTimes(78, 15, new Date('2026-12-21T12:00:00Z')), null);
});

test('时区：东京比兰州早一小时', () => {
  const at = new Date('2026-10-31T04:00:00Z');
  const lz = localHour(at, 'Asia/Shanghai');
  const tk = localHour(at, 'Asia/Tokyo');
  assert.ok(Math.abs(tk - lz - 1) < 0.01, `东京 ${tk}，兰州 ${lz}`);
});

test('时区：巴黎夏令时与兰州差六小时', () => {
  const at = new Date('2026-07-15T04:00:00Z');
  const lz = localHour(at, 'Asia/Shanghai');
  const pa = localHour(at, 'Europe/Paris');
  const diff = (lz - pa + 24) % 24;
  assert.ok(Math.abs(diff - 6) < 0.01, `差 ${diff} 小时，应该是 6`);
});

test('当地时间：dateKey 是当地日期，不是 UTC 日期', () => {
  // UTC 2026-10-31 20:00 = 东京 11-01 05:00
  const m = localMoment(new Date('2026-10-31T20:00:00Z'), 'Asia/Tokyo');
  assert.equal(m.dateKey, '2026-11-01');
  assert.equal(m.hour, 5);
});

test('utcFromLocal 与 localHour 互相还原', () => {
  const tz = 'Asia/Shanghai';
  const utc = utcFromLocal('2026-10-31', 7.5, tz);
  const back = localHour(utc, tz);
  assert.ok(Math.abs(back - 7.5) < 0.02, `还原成 ${back}`);
});

test('shiftDateKey 跨月正确', () => {
  assert.equal(shiftDateKey('2026-10-31', 1), '2026-11-01');
  assert.equal(shiftDateKey('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDateKey('2026-03-01', -1), '2026-02-28');
});

test('作息表：晚上九点到达，当天只剩进房间和睡', () => {
  const plan = planDay({
    city: HS, dateKey: '2026-10-31', shape: 'arrival', startHour: 21,
    lodging: rollLodging(() => 0.2),
  });
  assert.equal(plan.beats.length, 3, `实际 ${plan.beats.length} 个节点`);
  assert.equal(plan.beats[0].kind, 'arrive');
  assert.equal(plan.beats[1].kind, 'hotel');
  assert.equal(plan.beats[2].kind, 'sleep');
});

test('作息表：完整的一天里有早饭午饭晚饭三个饭点', () => {
  const plan = planDay({
    city: XA, dateKey: '2026-10-31', shape: 'full', lodging: rollLodging(() => 0.2),
  });
  const kinds = plan.beats.map((b) => b.kind);
  for (const k of ['breakfast', 'lunch', 'dinner']) {
    assert.ok(kinds.includes(k), `缺 ${k}`);
  }
});

test('作息表：饭点落在合理的钟点上', () => {
  const plan = planDay({
    city: XA, dateKey: '2026-10-31', shape: 'full', lodging: rollLodging(() => 0.2),
  });
  const at = (k) => plan.beats.find((b) => b.kind === k)?.at;
  assert.ok(at('breakfast') >= 7 && at('breakfast') <= 9, `早饭 ${at('breakfast')}`);
  assert.ok(at('lunch') >= 11.5 && at('lunch') <= 14, `午饭 ${at('lunch')}`);
  assert.ok(at('dinner') >= 17.5 && at('dinner') <= 19.5, `晚饭 ${at('dinner')}`);
});

test('作息表：没有夜间活动的地方，八点就回酒店', () => {
  /*
   * 2026-11-07 改：原来钉的是泰安（「泰山脚下的小城，晚上该回酒店」）。
   * 补数据时泰安真的有夜事了（夜里从红门上山等日出），这条前提就没了 ——
   * 写死一座城，等于把「这城晚上没东西」变成测试的隐藏前提，数据一补就红。
   *
   * 现在按**数据的形状**取：找第一座 `night === null` 的城。
   * 这样测的还是那条规矩（没有夜事就早回酒店），而且不会随城市数据漂。
   */
  const quiet = CITIES.find((c) => !c.night);
  assert.ok(quiet, '所有城市都有夜间去处了？那这条测试要换个写法');
  const plan = planDay({
    city: quiet, dateKey: '2026-10-31', shape: 'full', lodging: rollLodging(() => 0.2),
  });
  const hotel = plan.beats.find((b) => b.kind === 'hotel');
  assert.ok(hotel, `${quiet.name} 没有回酒店的节点`);
  assert.ok(hotel.at <= 20.5, `${quiet.name} 回酒店排在 ${fmtHour(hotel.at)}，太晚了`);
  assert.equal(plan.nightOption, null);
});

test('作息表：有日出条件的地方，日出排在六点前且早起', () => {
  const plan = planDay({
    city: HS, dateKey: '2026-10-31', shape: 'full', lodging: rollLodging(() => 0.2),
  });
  const sr = plan.beats.find((b) => b.kind === 'sunrise');
  assert.ok(sr, '黄山该有日出节点');
  assert.ok(sr.at < 7.5, `日出排在 ${fmtHour(sr.at)}`);
  const wake = plan.beats.find((b) => b.kind === 'wake');
  assert.ok(wake.at < sr.at, '起床必须早于日出');
  assert.ok(sr.at - wake.at > 1, '起得太晚，赶不上');
});

test('作息表：城市里不排日出（楼挡着）', () => {
  const plan = planDay({
    city: cityById('shanghai'), dateKey: '2026-10-31', shape: 'full', lodging: rollLodging(() => 0.2),
  });
  assert.equal(plan.beats.some((b) => b.kind === 'sunrise'), false, '上海不该排日出');
});

test('作息表：节点按时间递增，不会倒流', () => {
  for (const cityId of ['huangshan', 'xian', 'sanya', 'haerbin', 'lasa']) {
    const plan = planDay({
      city: cityById(cityId), dateKey: '2026-10-31', shape: 'full',
      lodging: rollLodging(() => 0.2),
    });
    for (let i = 1; i < plan.beats.length; i++) {
      assert.ok(plan.beats[i].at >= plan.beats[i - 1].at,
        `${cityId} 第 ${i} 个节点倒流：${plan.beats[i - 1].at} → ${plan.beats[i].at}`);
    }
  }
});

test('酒店概率：普通六成、景观三成半、高档零头、小破店不到百分之一', () => {
  /*
   * 2026-11-06 加了一档「高档」（luxury）：那 4% 是从景观房里匀出来的，
   * 普通房仍然六成 —— 一个半年都在外面的人，多数日子住得普通，偶尔住一次好的才像真的。
   */
  let budget = 0; let view = 0; let luxury = 0; let dingy = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const l = rollLodging();
    if (l.tier === 'budget') budget++;
    else if (l.tier === 'view') view++;
    else if (l.tier === 'luxury') luxury++;
    else dingy++;
  }
  const pb = budget / N; const pv = view / N; const pl = luxury / N; const pd = dingy / N;
  assert.ok(pb > 0.56 && pb < 0.64, `普通房 ${(pb * 100).toFixed(1)}%`);
  assert.ok(pv > 0.32 && pv < 0.40, `景观房 ${(pv * 100).toFixed(1)}%`);
  assert.ok(pl > 0.02 && pl < 0.07, `高档 ${(pl * 100).toFixed(1)}%，太少见不着、太多就不像过日子`);
  assert.ok(pd > 0 && pd < 0.01, `小破店 ${(pd * 100).toFixed(2)}%，要么没有要么超了 1%`);
});

test('手头宽的时候高档房明显变多 —— 这是「不用劝她自己就住好的」', () => {
  let luxury = 0;
  const N = 8000;
  for (let i = 0; i < N; i++) if (rollLodging(Math.random, false, 1, true).tier === 'luxury') luxury++;
  const p = luxury / N;
  assert.ok(p > 0.13 && p < 0.24, `宽裕时高档 ${(p * 100).toFixed(1)}%，应该在一成八上下`);
});

test('行程：到达时刻在世界时间轴上，同一起点同倍速无关', () => {
  // 2026-10-31 改：倍速不再除在路程时长里。
  // 旧做法是「到达 = 出发 + 时长/倍速」，结果 24x 下她十七分钟到站、
  // 然后在目的地按真实时间住两三天 —— 车跑快了，人没走快。
  const mode = modeById('train');
  const at = new Date('2026-10-31T02:00:00Z');
  const fast = buildJourney({ from: LZ, to: XA, mode, km: 560, at, speed: 1 });
  const quick = buildJourney({ from: LZ, to: XA, mode, km: 560, at, speed: 24 });
  assert.equal(fast.arriveAt, quick.arriveAt, '到达时刻不该随倍速变');
  assert.equal(fast.durationWorldHours, quick.durationWorldHours);
  const span = (Date.parse(fast.arriveAt) - Date.parse(fast.departedAt)) / 3_600_000;
  assert.ok(Math.abs(span - fast.durationWorldHours) < 0.01,
    `到达减出发应该正好等于时长：${span} vs ${fast.durationWorldHours}`);
});

test('世界时钟：倍速只让世界时间跑得快，不改刻度', () => {
  // 模拟世界的换算：world = worldEpoch + (real - realEpoch) * speed
  const realEpoch = Date.parse('2026-10-31T00:00:00Z');
  const world = (realMs, speed) => worldEpochBase + (realMs - realEpoch) * speed;
  const worldEpochBase = realEpoch;

  const oneHourReal = realEpoch + 3_600_000;
  assert.equal(world(oneHourReal, 1), worldEpochBase + 3_600_000, '1x 下真实一小时就是世界一小时');
  assert.equal(world(oneHourReal, 24), worldEpochBase + 86_400_000, '24x 下真实一小时是世界一天');
  assert.equal(world(oneHourReal, 4), worldEpochBase + 4 * 3_600_000, '4x 下真实一小时是世界四小时');
});

test('倍速切换时世界时间连续，不跳变', () => {
  // 切倍速必须先把走过的那段按旧倍速结算，再按新倍速继续。
  // 不结算就会：1x 跑了半天，切 24x 的一瞬间世界时间往前跳二十多天。
  const realEpoch = Date.parse('2026-10-31T00:00:00Z');
  const worldEpoch = realEpoch;
  const real1 = realEpoch + 3_600_000;          // 真实过 1 小时
  const worldBefore = worldEpoch + (real1 - realEpoch) * 1;  // 1x → 世界 +1h

  // 换挡：新基准以「此刻的世界时刻」为起点
  const newRealEpoch = real1;
  const newWorldEpoch = worldBefore;
  const real2 = real1 + 3_600_000;              // 真实再过 1 小时
  const worldAfter = newWorldEpoch + (real2 - newRealEpoch) * 24;

  assert.equal(worldAfter - newWorldEpoch, 24 * 3_600_000, '换挡后一小时应该是世界一天');
  assert.equal(newWorldEpoch, worldEpoch + 3_600_000, '换挡那一刻世界时间必须连续');
});

test('行程进度：出发前 0，到达后 1，中间在 0-1 之间', () => {
  const mode = modeById('train');
  const at = new Date('2026-10-31T02:00:00Z');
  const j = buildJourney({ from: LZ, to: XA, mode, km: 560, at, speed: 1 });
  assert.equal(progressOf(j, new Date(Date.parse(j.departedAt) - 1000)), 0);
  assert.equal(progressOf(j, new Date(Date.parse(j.arriveAt) + 1000)), 1);
  const mid = new Date((Date.parse(j.departedAt) + Date.parse(j.arriveAt)) / 2);
  const p = progressOf(j, mid);
  assert.ok(p > 0.3 && p < 0.7, `中点进度 ${p}`);
});

test('选目的地：不会选到自己，也不会选六十公里内的邻居', () => {
  for (let i = 0; i < 500; i++) {
    const r = pickDestination({ from: LZ });
    assert.ok(r, '没挑到地方');
    assert.notEqual(r.city.id, 'lanzhou');
    assert.ok(r.km >= 60, `选了 ${r.km} 公里外的地方，太近了`);
  }
});

test('选目的地：去过的城市权重更低，但仍有可能', () => {
  // 取城市时**要跨方向撒**。原来直接 `slice(0, 40)`，那 40 个恰好集中在兰州周边那一圈，
  // 于是「周边」档的候选全是老地方，降权在档内等于没降（全档一起降，相对关系不变）。
  // 那是测试构造的问题，不是逻辑的问题 —— 但它顺带暴露了档位本身要看新鲜度。
  const all0 = CITIES.filter((c) => c.id !== 'lanzhou').map((c) => c.id);
  const visited = [];
  let seed = 20261031;
  const rr = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pool0 = [...all0];
  while (visited.length < 45 && pool0.length) {
    visited.push(pool0.splice(Math.floor(rr() * pool0.length), 1)[0]);
  }
  let hits = 0;
  for (let i = 0; i < 800; i++) {
    const r = pickDestination({ from: LZ, visited });
    if (visited.includes(r.city.id)) hits++;
  }
  assert.ok(hits > 0, '去过的城市完全不会再去了，太绝对');
  assert.ok(hits < 800 * 0.5, `一半以上都去了老地方（${hits}/800），权重没起作用`);
});

test('humanHours 说人话', () => {
  assert.equal(humanHours(0.5), '30 分钟');
  assert.match(humanHours(5), /小时/);
  assert.match(humanHours(5.5), /个半小时/);
  /*
   * 两天以上按天说。
   * 2026-11-05 的 144 天模拟抓到：跨洋的船一趟 450 小时，
   * 事件里写着「这一趟要走 450 个多小时」「还有大约 448 小时」——
   * 数字没错，但没人这么说话，而且读者得自己换算成十九天。
   */
  assert.equal(humanHours(450), '19 天', `跨洋的船还在报小时：${humanHours(450)}`);
  assert.equal(humanHours(48), '2 天');
  assert.match(humanHours(47), /小时/, '不到两天还是说小时');
});

test('fmtHour 用中文钟点，不露机器读数', () => {
  assert.equal(fmtHour(7.5), '七点半');
  assert.equal(fmtHour(18), '十八点');
  assert.match(fmtHour(7.25), /七点十五分/);
});

test('isForeign：国外城市要能认出来', () => {
  assert.equal(isForeign(cityById('tokyo')), true);
  assert.equal(isForeign(cityById('beijing')), false);
  assert.equal(isForeign(cityById('xianggang')), false, '中国香港不是国外');
});

test('MODES：九种交通方式都在，参数合理', () => {
  assert.equal(MODES.length, 9);
  for (const m of MODES) {
    assert.ok(m.kmh > 0, `${m.name} 速度不为正`);
    assert.ok(m.overhead >= 0, `${m.name} 固定开销为负`);
    assert.ok(m.feel.length > 10, `${m.name} 缺体感描述`);
  }
  // 飞机固定开销最大，这是「短途不划算」的来源。
  const maxOverhead = Math.max(...MODES.map((m) => m.overhead));
  assert.equal(modeById('plane').overhead, maxOverhead);
});

test('巡检有并发闸：tick 重叠时第二条直接返回', async () => {
  // 2026-10-31 模拟里真实抓到：定时器与手动 tick 叠在一起，同一条「午饭」推了两遍。
  // 行为断言：ticking 锁住时调用 tick() 立即返回，且正常巡检结束后必须解锁。
  const dir = mkdtempSync(join(tmpdir(), 'jr-tick-gate-'));
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-08T04:00:00Z'),
  });
  w.host = {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => ({ ...e, blobs: [] }),
    pushDeferred() {},
    store: {},
    drainPendingEvents: async () => [],
  };
  w.ticking = true;
  await w.tick();
  assert.equal(w.st.clock, null, 'ticking=true 时 tick 应该直接返回，不建时钟基准');
  w.ticking = false;
  await w.tick();
  assert.ok(w.st.clock, '解锁后 tick 应该正常执行');
  assert.equal(w.ticking, false, 'tick 结束后必须解锁（否则会永久卡死）');
});

test('去重键落盘：lastBeatKey 在状态里，不是内存字段', () => {
  const src = readFileSync(new URL('../src/state.ts', import.meta.url), 'utf8');
  assert.match(src, /lastBeatKey: string \| null/, '最后推送节点没有落盘');
  assert.match(src, /lastBeatKey: typeof r\.lastBeatKey === 'string'/, '读盘时没有恢复去重键');
});

test('时钟只有一个入口：业务代码不许直接调 Date.now()', () => {
  const srcDir = new URL('../src/', import.meta.url);
  const files = readdirSync(srcDir).filter((f) => f.startsWith('world') && f.endsWith('.ts'));
  const hits = [];
  for (const f of files) {
    const src = readFileSync(new URL(f, srcDir), 'utf8');
    for (const l of src.split('\n')) {
      const t = l.trim();
      if (/Date\.now\(\)/.test(l) && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')) {
        hits.push(`${f}: ${t}`);
      }
    }
  }
  assert.equal(hits.length, 0, `world 模块里有 ${hits.length} 处 Date.now()：\n${hits.join('\n')}`);
});

test('时钟结算必须落盘：ensureClock 改完状态要 persist', () => {
  // 2026-10-31 真实踩到：日志打了「已连续结算」，但 state.json 里 speed 还是旧值。
  // 后果是每次重启都从同一个旧基准再结算一遍，世界时间被反复往前推。
  const dir = mkdtempSync(join(tmpdir(), 'jr-clock-persist-'));
  const cfg = { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', speed: 1 };
  const w = new JourneyWorld({
    cfg,
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-08T04:00:00Z'),
  });
  w.ensureClock();
  const disk1 = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(disk1.clock?.speed, 1, '建基准时没有写盘');
  cfg.speed = 24;
  w.ensureClock();
  const disk2 = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(disk2.clock?.speed, 24, '换挡结算后没有把新 speed 写进 state.json');
});

// ---- 天气约束 ----
const wetDay = { dateKey: '2026-10-31', dayWeather: '小雨', nightWeather: '小雨', dayTemp: 18, nightTemp: 9, dayWind: '东风', dayPower: '1-3' };
const clearDay = { dateKey: '2026-10-31', dayWeather: '晴', nightWeather: '晴', dayTemp: 20, nightTemp: 8, dayWind: '西风', dayPower: '1-3' };
const murkyDay = { dateKey: '2026-10-31', dayWeather: '浮尘', nightWeather: '浮尘', dayTemp: 15, nightTemp: 1, dayWind: '北风', dayPower: '3-4' };

test('天气：下雨天不排看日出', () => {
  const plan = planDay({
    city: HS, dateKey: '2026-10-31', shape: 'full', lodging: rollLodging(() => 0.2), weather: wetDay,
  });
  assert.equal(plan.beats.some((b) => b.kind === 'sunrise'), false, '小雨还排日出');
  assert.ok(plan.weather, '天气没带进计划');
});

test('天气：晴天该排的日出照排（对照组）', () => {
  const plan = planDay({
    city: HS, dateKey: '2026-10-31', shape: 'full', lodging: rollLodging(() => 0.2), weather: clearDay,
  });
  assert.equal(plan.beats.some((b) => b.kind === 'sunrise'), true, '晴天反而没排日出');
});

test('天气：浮尘天不排日出（看不见）', () => {
  const plan = planDay({
    city: HS, dateKey: '2026-10-31', shape: 'full', lodging: rollLodging(() => 0.2), weather: murkyDay,
  });
  assert.equal(plan.beats.some((b) => b.kind === 'sunrise'), false, '浮尘还排日出');
});

test('天气：下雨不出去看星星，改回酒店，并说明原因是雨', () => {
  // 九寨沟 tags 有「高原」，平时晚上是看星星。
  const plan = planDay({
    city: cityById('jiuzhaigou'), dateKey: '2026-10-31', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: wetDay,
  });
  assert.equal(plan.nightOption, null, '小雨还安排夜间外出');
  const hotel = plan.beats.find((b) => b.kind === 'hotel');
  assert.ok(hotel.what.includes('雨'), `回酒店没说明是下雨：${hotel.what}`);
});

test('天气：晴天照常出去（对照组）', () => {
  const plan = planDay({
    city: cityById('jiuzhaigou'), dateKey: '2026-10-31', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: clearDay,
  });
  // 2026-11-01 起夜间去处是查表（City.night），不再是按 tags 拼出来的那句话。
  // 所以断言改成「有夜间安排，而且确实是看星」，不再钉死文案。
  assert.ok(plan.nightOption, '晴天却没安排夜间活动');
  assert.match(plan.nightOption, /星/, '晴天该去看星，实际是「' + plan.nightOption + '」');
});

test('天气：查不到（null）时照排作息，不编天气', () => {
  const plan = planDay({
    city: HS, dateKey: '2026-10-31', shape: 'full', lodging: rollLodging(() => 0.2), weather: null,
  });
  assert.equal(plan.weather, null);
  assert.ok(plan.beats.length > 4, '没有天气也得出作息表');
  assert.equal(plan.beats.some((b) => b.kind === 'sunrise'), true, '未知天气不该禁止日出');
});

test('天气体感说人话，不是播报口径', () => {
  const cold = { ...clearDay, nightTemp: -3 };
  const hot = { ...clearDay, nightTemp: 28 };
  assert.match(feelOf(cold), /零下|冷/);
  assert.match(feelOf(hot), /热/);
  assert.match(feelOf(wetDay), /雨|伞/);
  assert.doesNotMatch(feelOf(clearDay), /\d+℃|~/, '体感里不该出现温度区间这种播报格式');
  assert.equal(feelOf(null), '');
});

test('天气：夜间活动看夜间天气，不是白天天气', () => {
  // 白天多云、夜间小雨 —— 那天晚上就该待在屋里。
  const cloudyDayWetNight = {
    dateKey: '2026-10-31', dayWeather: '多云', nightWeather: '小雨',
    dayTemp: 15, nightTemp: 8, dayWind: '西风', dayPower: '1-3',
  };
  const plan = planDay({
    city: cityById('jiuzhaigou'), dateKey: '2026-10-31', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: cloudyDayWetNight,
  });
  assert.equal(plan.nightOption, null, '夜里下雨还安排外出');
  const hotel = plan.beats.find((b) => b.kind === 'hotel');
  assert.ok(hotel.what.includes('雨'), '没说明是因为下雨');
});

// ---- 天气数据源路由 ----
const fakeMeteo = (url) => {
  if (url.includes('open-meteo')) {
    return new Response(JSON.stringify({
      daily: {
        time: ['2026-10-31', '2026-11-01'],
        weather_code: [61, 0],
        temperature_2m_max: [18, 22],
        temperature_2m_min: [9, 7],
        precipitation_probability_max: [80, 0],
        wind_speed_10m_max: [12, 8],
      },
    }), { status: 200 });
  }
  return new Response(JSON.stringify({
    status: '1',
    forecasts: [{ city: '兰州市', casts: [
      { date: '2026-10-31', dayweather: '小雨', nightweather: '小雨', daytemp: '18', nighttemp: '9', daywind: '东风', daypower: '1-3' },
    ] }],
  }), { status: 200 });
};

test('天气路由：没配 key 时走 Open-Meteo，不是干等着没天气', async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => { seen.push(String(u)); return fakeMeteo(String(u)); };
  try {
    const w = new AmapWeather('', join(tmpdir(), `j-${Date.now()}.json`));
    const f = await w.forecast(LZ, '2026-10-31');
    assert.ok(seen.some((u) => u.includes('open-meteo')), '没 key 竟然没走 Open-Meteo');
    assert.ok(f, '没拿到预报');
    assert.equal(f.dayWeather, '小雨', 'WMO 码 61 应该映射成小雨');
    assert.equal(f.nightTemp, 9);
  } finally { globalThis.fetch = orig; }
});

test('天气路由：国外城市一律走 Open-Meteo（高德不覆盖）', async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => { seen.push(String(u)); return fakeMeteo(String(u)); };
  try {
    const w = new AmapWeather('fake-key-123', join(tmpdir(), `j-${Date.now()}.json`));
    await w.forecast(cityById('tokyo'), '2026-10-31');
    assert.ok(seen.some((u) => u.includes('open-meteo')), '东京没走 Open-Meteo');
    assert.equal(seen.some((u) => u.includes('restapi.amap.com')), false, '不该拿高德查东京，白耗配额');
  } finally { globalThis.fetch = orig; }
});

test('天气路由：国内 + 有 key 时走高德', async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => { seen.push(String(u)); return fakeMeteo(String(u)); };
  try {
    const w = new AmapWeather('fake-key-123', join(tmpdir(), `j-${Date.now()}.json`));
    const f = await w.forecast(LZ, '2026-10-31');
    assert.ok(seen.some((u) => u.includes('restapi.amap.com')), '国内有 key 却没走高德');
    assert.equal(f.dayWeather, '小雨');
  } finally { globalThis.fetch = orig; }
});

test('天气路由：key 失效只降级到 Open-Meteo，不是没有天气', async () => {
  // 0.2.6 之前这里打的是「天气功能停止」—— 错的。key 坏了只是不再走高德，
  // 下一次查询就落到 Open-Meteo，天气照有。文案改了这一条就跟着钉住行为。
  const seen = [];
  const orig = globalThis.fetch;
  let amapCalls = 0;
  globalThis.fetch = async (u) => {
    const url = String(u);
    seen.push(url);
    if (url.includes('restapi.amap.com')) {
      amapCalls += 1;
      return new Response(JSON.stringify({ status: '0', info: 'INVALID_USER_KEY' }), { status: 200 });
    }
    return fakeMeteo(url);
  };
  try {
    const w = new AmapWeather('bad-key', join(tmpdir(), `j-${Date.now()}-bad.json`));
    assert.equal(await w.forecast(LZ, '2026-10-31'), null, '第一次就该是未知，不能拿假数据顶上');
    const second = await w.forecast(LZ, '2026-10-31');
    assert.ok(second, 'key 失效之后彻底没天气了');
    assert.equal(second.dayWeather, '小雨', '降级后拿到的不是 Open-Meteo 的数据');
    assert.equal(amapCalls, 1, `key 已判无效还在反复打高德（${amapCalls} 次）`);
  } finally { globalThis.fetch = orig; }
});

test('天气路由：WMO 码都要能翻成中文，否则雨天判不出来', async () => {
  const wetCodes = [51, 55, 61, 63, 65, 71, 73, 75, 80, 95];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => new Response(JSON.stringify({
    daily: {
      time: wetCodes.map((_, i) => `2026-11-0${i + 1}`.slice(0, 10)),
      weather_code: wetCodes,
      temperature_2m_max: wetCodes.map(() => 10),
      temperature_2m_min: wetCodes.map(() => 5),
      precipitation_probability_max: wetCodes.map(() => 90),
      wind_speed_10m_max: wetCodes.map(() => 10),
    },
  }), { status: 200 });
  try {
    const { fetchOpenMeteo } = await import('../src/geo/amap.ts');
    const casts = await fetchOpenMeteo(LZ);
    assert.ok(casts, '没拿到');
    for (const c of casts) {
      assert.ok(isWet(c.dayWeather), `天气码翻成「${c.dayWeather}」后 isWet 判不出来`);
    }
  } finally { globalThis.fetch = orig; }
});

test('天气：世界时间超出预报窗口时给 null，不拿别的日期顶替', async () => {
  // 曾经这里 `?? fresh[0]`：24x 下真实六小时等于世界六天，
  // 冲出预报窗口后「11 月 4 日」拿到的是「10 月 31 日」的天气，而且一声不响。
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => new Response(JSON.stringify({
    daily: {
      time: ['2026-10-31', '2026-11-01'],
      weather_code: [61, 0],
      temperature_2m_max: [18, 22],
      temperature_2m_min: [9, 7],
      precipitation_probability_max: [80, 0],
      wind_speed_10m_max: [12, 8],
    },
  }), { status: 200 });
  try {
    const w = new AmapWeather('', join(tmpdir(), `j-${Date.now()}.json`));
    const inside = await w.forecast(LZ, '2026-11-01');
    assert.ok(inside, '窗口内应该有天气');
    assert.equal(inside.dayWeather, '晴', '11-01 应该是晴（WMO 0）');

    const outside = await w.forecast(LZ, '2026-11-20');
    assert.equal(outside, null, '窗口外必须给 null，不能拿别的日期冒充');
  } finally { globalThis.fetch = orig; }
});

test('天气：未知天气不阻断作息表', () => {
  const plan = planDay({
    city: cityById('nanning'), dateKey: '2026-11-20', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: null,
  });
  assert.equal(plan.weather, null);
  assert.ok(plan.beats.length >= 6, '没有天气也得排出完整一天');
  // 南宁 tags 有「湿热」但没有夜间项，所以该回酒店；
  // 关键是「未知」不能把夜间活动也一并禁掉。
  assert.ok(plan.beats.some((b) => b.kind === 'dinner'), '连晚饭都没了');
});

// ---- 彩蛋 ----
test('彩蛋：概率不到千分之一，但确实会发生', () => {
  const tokyo = cityById('tokyo');
  let hits = 0;
  const N = 200000;
  // 显式传生产概率，不依赖源码里那个常量（验证链路时会临时调高它）。
  for (let i = 0; i < N; i++) if (rollTrouble(tokyo, Math.random, 0.0008)) hits++;
  const rate = hits / N;
  assert.ok(rate > 0, '两万次一次都没命中，概率算错了');
  assert.ok(rate < 0.001, `命中率 ${(rate * 100).toFixed(3)}%，超过千分之一`);
});

test('彩蛋：只在符合条件的地方出现', () => {
  // 东南亚才有丢证件那条；东京既不是东南亚也不是高原极北。
  const bangkok = cityById('bangkok');
  let t = null;
  for (let i = 0; i < 20000 && !t; i++) t = rollTrouble(bangkok, Math.random, 0.0008);
  assert.ok(t, '曼谷两万次都没掷出彩蛋');
  assert.equal(t.id, 'southeast-pickpocket', `曼谷掷出了 ${t.id}`);
});

test('彩蛋文案必须说清「需要你出手」，不能自己圆过去', () => {
  for (const t of TROUBLES) {
    const text = t.text(cityById('bangkok'));
    assert.ok(/你|有人|他/.test(text), `${t.id} 没把求助对象说出来`);
  }
});

// ---- 听歌 ----
test('歌名里的城市：字面命中，不瞎联想', () => {
  assert.equal(cityMentioned('成都')?.id, 'chengdu');
  assert.equal(cityMentioned('回到拉萨')?.id, 'lasa');
  assert.equal(cityMentioned('100もの扉'), null, '日文歌名不该命中山城');
  assert.equal(cityMentioned('小城故事'), null, '没有城市名就不该命中');
});

test('想去的地方：权重压过分档', () => {
  // 想让南宁出现，正常概率很低（远档 15%）；给了 wish 之后应该明显更容易。
  let withWish = 0;
  for (let i = 0; i < 400; i++) {
    const r = pickDestination({ from: LZ, wishes: ['nanning'] });
    if (r.city.id === 'nanning') withWish++;
  }
  assert.ok(withWish > 0, '给了 wish 一次都没去');
});

// ---- 景点素材 ----
test('景点：有地标的城市，作息表里必须出现真名', () => {
  const dunhuang = cityById('dunhuang');
  assert.ok(dunhuang.spots.length >= 2, '敦煌没填景点');
  const plan = planDay({
    city: dunhuang, dateKey: '2026-10-31', shape: 'full', lodging: rollLodging(() => 0.2),
  });
  const acts = plan.beats.filter((b) => b.kind === 'activity').map((b) => b.what);
  assert.ok(acts.length >= 2, '一天该有两个 activity');
  assert.ok(acts.some((a) => dunhuang.spots.some((s) => a.includes(s))),
    `activity 里没有真地标：${acts.join(' / ')}`);
});

test('景点：没有地标的城市用泛化说法，不编具体名字', () => {
  /*
   * 2026-11-01 之前这条是「挑一个 SPOTS 里没填的城市」——
   * 那天把 102 个城市全填满之后，前置条件就没了，测试当场红。
   * 现在改成**构造**一个空城市：泛化逻辑本身不能丢，她住到第 4 天还要走到这儿。
   */
  const blank = { ...cityById('lanzhou'), spots: [] };
  const t = spotText(blank, 0);
  assert.ok(t.length > 2, '泛化说法是空的');
  assert.doesNotMatch(t, /景区|寺|窟|宫|塔/, `没数据的城市编出了具体地标：${t}`);
});

test('景点：绝大多数城市都有真地标（覆盖度）', () => {
  const withSpots = CITIES.filter((c) => c.spots.length > 0).length;
  const rate = withSpots / CITIES.length;
  assert.ok(rate > 0.8, `只有 ${(rate * 100).toFixed(0)}% 的城市有地标，日记还是会塌成吃播`);
});

test('手头紧时飞机会变少（但不是禁掉）', () => {
  const km = 1600;   // 中长途，飞机本来是个正经选项
  let rich = 0; let poor = 0;
  const N = 3000;
  for (let i = 0; i < N; i++) {
    if (pickMode(LZ, cityById('sanya'), km)?.id === 'plane') rich++;
    if (pickMode(LZ, cityById('sanya'), km, Math.random, true)?.id === 'plane') poor++;
  }
  assert.ok(rich > 0, '本来就没选过飞机，这条测不到东西');
  assert.ok(poor < rich, `穷的时候飞机反而更多：${poor} vs ${rich}`);
  assert.ok(poor > 0, '穷的时候一次都不飞了 —— 跨洲还得飞，不能禁');
});

test('彩蛋事件正文必须自带「现在就说」的指令', () => {
  // 2026-10-31 实测：事件推到了、她读了、只写进日记，一个字没说。
  // 提示词里离得远的「必须开口」压不住正文的语气，指令得贴在正文上。
  // 上一版在这里翻车：`type: 'journey.trouble'` 是**描述表**里的那条，
  // 不是真正推送的地方（推送用的是字符串参数）。所以直接查那句短语，它只出现一次。
  const src = readFileSync(new URL('../src/world.ts', import.meta.url), 'utf8');
  assert.match(src, /现在就开口说，不能只写进日记/, '彩蛋推送正文里没有「现在就开口」的指令');
  assert.match(src, /这条是来找他帮忙的/, '没说明这条事件的意图');
});

// ================= 路线连贯性 =================

test('路线：给了方向，就基本不再往回走', () => {
  // 在南宁，上一段是从九寨沟往南来的。方向朝东南。
  const nanning = cityById('nanning');
  const heading = bearingDeg(cityById('jiuzhaigou'), nanning);
  let backward = 0;
  const N = 600;
  for (let i = 0; i < N; i++) {
    const r = pickDestination({ from: nanning, heading, lastKm: 1240 });
    // 判据用 140 度：120～140 是**侧后方**，从南宁往桂林（123°）、往昆明（136°）
    // 都是正常的走法，不该算成折返。真正的问题是 >140 的原路返回。
    if (angleBetween(bearingDeg(nanning, r.city), heading) > 140) backward++;
  }
  assert.ok(backward / N < 0.1,
    `${((backward / N) * 100).toFixed(0)}% 的目的地在原路折返，方向约束没生效`);
});

test('路线：不给方向时是自由的（第一段不该被约束）', () => {
  const nanning = cityById('nanning');
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(pickDestination({ from: nanning }).city.id);
  assert.ok(seen.size > 20, `第一段只去了 ${seen.size} 个地方，被莫名其妙约束住了`);
});

test('路线：上一段是长途，下一段明显变短', () => {
  const nanning = cityById('nanning');
  const heading = bearingDeg(cityById('jiuzhaigou'), nanning);
  const avg = (lastKm) => {
    let sum = 0;
    for (let i = 0; i < 400; i++) {
      sum += pickDestination({ from: nanning, heading, lastKm }).km;
    }
    return sum / 400;
  };
  const afterLong = avg(1800);
  const afterShort = avg(200);
  assert.ok(afterLong < afterShort * 0.8,
    `长途之后平均 ${Math.round(afterLong)}km，不比短途之后 ${Math.round(afterShort)}km 明显短`);
});

test('路线：连续 12 段不出现 Z 字折返跑', () => {
  // 这是最初的问题：九寨沟 → 南宁 → 银川，两段各 1800km+，方向完全相反。
  // 判据用「连续两段的夹角」，全是折返就说明方向约束没起作用。
  //
  // **用固定种子跑 30 轮**，不是靠一次运气：随机测试单跑一次会偶发抖动，
  // 要么偶尔红了误报，要么偶尔绿了掩盖问题。这里是「三十趟旅行里平均折返几次」。
  let seed = 20261031;
  const rr = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const home = cityById('lanzhou');
  let total = 0;
  let hard = 0;
  const worst = [];
  for (let trip = 0; trip < 30; trip++) {
    let cur = home;
    let heading = null;
    let lastKm = 0;
    const path = [cur.name];
    for (let i = 0; i < 12; i++) {
      const r = pickDestination({ from: cur, heading, lastKm, home, rnd: rr });
      const dir = bearingDeg(cur, r.city);
      if (heading !== null) {
        total++;
        if (angleBetween(dir, heading) > 140) { hard++; worst.push(`${path[path.length - 1]}→${r.city.name}`); }
      }
      path.push(r.city.name);
      heading = dir;
      lastKm = r.km;
      cur = r.city;
    }
  }
  assert.ok(total > 300, `样本太少：${total}`);
  const rate = hard / total;
  assert.ok(rate < 0.08, `30 趟 360 段里折返 ${hard} 次（${(rate * 100).toFixed(1)}%）：${worst.slice(0, 6).join(' ')}`);
});

test('路线：卡在角落也不会选不出地方', () => {
  // 漠河在东北角，方向指向更北时会剔空候选。不能因此返回 null。
  const mohe = cityById('mohe');
  assert.ok(mohe, '没有漠河');
  const r = pickDestination({ from: mohe, heading: 0, lastKm: 2000 });
  assert.ok(r && r.city, '在漠河往北走不出去，被方向约束卡死了');
});

// ================= 气候 =================

test('气候：兰州是干温，南宁是湿热，西宁是高原', () => {
  assert.equal(climateOf(cityById('lanzhou')), 'dry-mild');
  assert.equal(climateOf(cityById('nanning')), 'humid-hot');
  assert.equal(climateOf(cityById('lasa')), 'plateau');
  assert.equal(climateOf(cityById('haerbin')), 'cold');
  assert.equal(climateOf(cityById('sanya')), 'tropical');
});

test('气候：tags 优先于省份（格尔木在青海但是戈壁，不是高原）', () => {
  const geermu = cityById('geermu');
  assert.ok(geermu.tags.includes('戈壁'));
  assert.equal(climateOf(geermu), 'dry-mild', '格尔木被判成高原了');
});

test('气候：对兰州来的鱼，西北比湿热合胃口得多', () => {
  const dry = affinity('dry-mild', 'dry-mild');
  const hot = affinity('dry-mild', 'humid-hot');
  assert.ok(dry > hot * 1.8, `干温 ${dry} 和湿热 ${hot} 差得不够`);
  assert.ok(hot >= 0.4, `湿热被压到 ${hot}，等于把整个南方排除了`);
});

test('气候：湿热的地方去得少，但不是不去', () => {
  const lanzhou = cityById('lanzhou');
  const home = lanzhou;
  let hot = 0;
  let dry = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const r = pickDestination({ from: lanzhou, home });
    const c = climateOf(r.city);
    if (c === 'humid-hot' || c === 'tropical') hot++;
    if (c === 'dry-mild' || c === 'plateau') dry++;
  }
  assert.ok(hot > 0, '一次都没去南方 —— 那不叫习惯，叫没出过门');
  assert.ok(dry > hot, `西北 ${dry} 次、南方 ${hot} 次，气候偏好没生效`);
});

test('体感：兰州到南宁和到银川，说的不是同一句话', () => {
  const home = cityById('lanzhou');
  const nanning = bodyFeeling(cityById('nanning'), home);
  const yinchuan = bodyFeeling(cityById('yinchuan'), home);
  assert.ok(nanning.length > 5 && yinchuan.length > 5);
  assert.notEqual(nanning, yinchuan);
  assert.match(yinchuan, /干/, '回西北没提到「干」');
  assert.match(nanning, /潮|黏|贴/, '到南宁没提到潮');
});

test('体感：高原城市对兰州来说不是「缺氧」，是「比家还高」', () => {
  const t = bodyFeeling(cityById('lasa'), cityById('lanzhou'));
  assert.match(t, /比家里高|比家还高/, `拉萨的体感写成了：${t}`);
});

test('体感：同一个气候档不硬找话说', () => {
  const t = bodyFeeling(cityById('yinchuan'), cityById('lanzhou'));
  assert.ok(t.length <= 40, '同档气候说了一大段，会显得啰嗦');
});

test('journey_now 带「身体感觉」：她随时说得出受不受得了', () => {
  // 气候偏好如果只影响选点、不进入她能看到的信息，她就只能说「到了某地」，
  // 说不了「这地方我待不住」。那这一整层就白做了。
  const dir = mkdtempSync(join(tmpdir(), 'jr-body-feel-'));
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-08T04:00:00Z'),
  });
  assert.match(w.nowSummary(), /家里这样：/, '在家时 nowSummary 没有体感行');
  w.st = { ...w.st, phase: 'staying', hereId: 'nanning', stayStartedAt: '2026-11-07T04:00:00Z' };
  assert.match(w.nowSummary(), /身体感觉：/, '在目的地时 nowSummary 没有体感行');
});

test('体感以家为基准：换个家，同一座城的话就变了', () => {
  // 用户可以把出发地改成任何城市。所以「合不合胃口」不能写死兰州 ——
  // 同一个南宁，对兰州来的和对南宁本地来的，说的必须是两回事。
  const nanning = cityById('nanning');
  const fromLanzhou = bodyFeeling(nanning, cityById('lanzhou'));
  const fromNanning = bodyFeeling(nanning, nanning);
  assert.notEqual(fromLanzhou, fromNanning, '换了个家，体感一个字没变 —— 家没当基准用');
  assert.match(fromLanzhou, /家里的干|两回事/, `兰州→南宁：${fromLanzhou}`);
  // 南宁人在南宁：只能说本地气候，**不能拿「家里」当参照**（家就是这儿）。
  assert.match(fromNanning, /潮|热/, `南宁→南宁：${fromNanning}`);
  assert.equal(/跟家里/.test(fromNanning), false, `南宁→南宁 还在说「跟家里」：${fromNanning}`);
});

test('方向与段长会落盘（重启后路线不重来）', () => {
  const src = readFileSync(new URL('../src/state.ts', import.meta.url), 'utf8');
  assert.match(src, /heading: number \| null/, 'heading 没有声明');
  assert.match(src, /lastKm: number/, 'lastKm 没有声明');
  assert.match(src, /heading: typeof r\.heading === 'number'/, 'heading 读盘没有校验');
});

// ================= 回程 =================

test('回程：每一步都离家更近（不会原地打转）', () => {
  // Mr.Q 指出「其实也合理如果从银川回兰州的话」—— 对的，但那要求回程真的经过那些地方。
  // 原来是 hereId 直接改成家，两千里一步到位，中间的城市一个都不算去过。
  const home = cityById('lanzhou');
  let cur = cityById('nanning');
  let dist = distanceKm(cur, home);
  const hops = [];
  for (let i = 0; i < 12 && dist >= 500; i++) {
    const r = pickDestination({ from: cur, toward: home, home, lastKm: 1000 });
    assert.ok(r, `离家 ${Math.round(dist)} 公里时选不出回程的站`);
    const nd = distanceKm(r.city, home);
    assert.ok(nd < dist, `回程反而离家更远了：${cur.name}(${Math.round(dist)}) → ${r.city.name}(${Math.round(nd)})`);
    hops.push(`${cur.name}(${Math.round(dist)}km)`);
    cur = r.city;
    dist = nd;
  }
  assert.ok(hops.length > 0, '一步都没走');
  assert.ok(dist < 500, `走了 ${hops.length} 站还没进家门的圈（还差 ${Math.round(dist)} 公里）`);
});

test('回程：南宁回兰州，路上真的会经过西北', () => {
  // 「如果从银川回兰州」这个说法成立的前提是：回程路上出现的是**往西北方向**的城市。
  const home = cityById('lanzhou');
  let cur = cityById('nanning');
  const path = [];
  for (let i = 0; i < 10 && distanceKm(cur, home) >= 500; i++) {
    const r = pickDestination({ from: cur, toward: home, home, lastKm: 1200 });
    if (!r) break;
    path.push(r.city.name);
    cur = r.city;
  }
  assert.ok(path.length > 0, '没走出回程');
  // 最后一站必须已经离兰州够近，否则说明回程没有真的往西北收敛
  assert.ok(distanceKm(cur, home) < 500, `回程走成了：南宁 → ${path.join(' → ')}，还没到家`);
});

test('回程：家里就在旁边时不再绕路，隔着省则分段往回走', async () => {
  // 2026-11-15 HOME_RADIUS_KM 从 500 收到 60：
  // 1) 在天水（离兰州约 240km >= HOME_RADIUS_KM）决定回家，不能直接瞬移到家，要发车走回程；
  // 2) 已经在同城圈内（< HOME_RADIUS_KM）时直接收尾到家，不再挑中间站。
  const now = new Date('2026-11-08T04:00:00Z');
  const dir = mkdtempSync(join(tmpdir(), 'jr-gohome-'));
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => now,
  });
  w.st = {
    ...w.st,
    phase: 'staying',
    homeId: 'lanzhou',
    hereId: 'tianshui',
    tripStartedAt: '2026-11-01T00:00:00Z',
    stayStartedAt: '2026-11-06T00:00:00Z',
  };
  await w.goHome(now, cityById('tianshui'), 'done');
  assert.equal(w.st.returning, true, '三百公里外回家应该进入回程状态');
  assert.notEqual(w.st.phase, 'home', '三百公里外不该一步瞬移到家');

  w.st = { ...w.st, phase: 'staying', hereId: 'lanzhou', leg: null };
  await w.goHome(now, LZ, 'done');
  assert.equal(w.st.phase, 'home', '已经在同城圈内（< HOME_RADIUS_KM）应该直接到家收尾');
  assert.ok(Number.isFinite(HOME_RADIUS_KM) && HOME_RADIUS_KM > 0, '没有定义 HOME_RADIUS_KM');
});

test('回程：状态里存着 returning，重启不会把方向搞乱', () => {
  const src = readFileSync(new URL('../src/state.ts', import.meta.url), 'utf8');
  assert.match(src, /returning: boolean/, 'returning 没有声明');
  assert.match(src, /returning: r\.returning === true/, 'returning 读盘没有校验');
});

test('状态读盘：null 的方向不能被读成「正北」', () => {
  // `Number(null)` 是 0，`Number('')` 也是 0。用 Number.isFinite(Number(x)) 判，
  // 会把「没有方向」变成「方向 = 正北 0 度」—— 她从家出发第一段就只能往北挑。
  // 2026-10-31 真机撞到：磁盘上 heading 是 null，读回来是 0。
  const src = readFileSync(new URL('../src/state.ts', import.meta.url), 'utf8');
  assert.match(src, /typeof r\.heading === 'number' && Number\.isFinite\(r\.heading\)/,
    'heading 读盘还在用 Number() 判，null 会变成 0');
});

test('气候：国外城市按 ISO 国家码判，不是一律温带', () => {
  // `F()` 构造时把 country 塞进了 region（F('tokyo','东京','JP',...)），
  // 所以 region 是「JP」不是「日本」。2026-10-31 抽查发现曼谷、东京全被判成温带。
  assert.equal(climateOf(cityById('bangkok')), 'tropical', '曼谷被判成非热带');
  assert.equal(climateOf(cityById('tokyo')), 'humid-mild', '东京被判错');
  assert.equal(climateOf(cityById('moscow')), 'cold', '莫斯科被判错');
  assert.equal(climateOf(cityById('singapore')), 'tropical', '新加坡被判错');
});

test('体感：地形句和气候句不重复', () => {
  // 拉萨曾经被拼成「走两步就得停一下，脑袋有点空。比家里高出不少，走两步就得停一下，脑袋有点空。」
  const t = bodyFeeling(cityById('lasa'), cityById('lanzhou'));
  const first = t.slice(0, t.indexOf('。'));
  assert.equal(t.split(first).length - 1, 1, `同一句说了两遍：${t}`);
  assert.ok(t.length < 60, `拉萨的体感太长（${t.length} 字）：${t}`);
});

// ---- 路上节点 ----

test('路上节点：两三个小时的短途也要发一个中途节点', () => {
  // 原来的门槛是「四小时以内不发」。2026-10-31 实测：兰州→天水 2.8 小时，
  // 从出发到到站两个多小时**一条事件都没有**，她自己说出来的是
  // 「那头就不给我消息了，现在到哪儿我真不知道」——听着像失联。
  const marks = beatMarks(2.8, 2);
  assert.equal(marks.length, 1, `2.8 小时按 2 小时间隔该是一个节点，实际 ${marks.length}`);
  assert.equal(marks[0], 0.5, '唯一那个节点应该落在半路');
});

test('路上节点：间隔是用户设的，调小更密、调大更稀', () => {
  // 这一条是 0.2.5 的核心：密度交给用户，代码只负责别把行程挤爆。
  // 4.5 小时算短途（< 8），上限三条 —— 间隔调到 1 小时也还是三条，不然短途会变成刷屏。
  assert.equal(beatMarks(4.5, 1).length, 3, '4.5 小时按 1 小时间隔应该顶到短途上限三条');
  assert.equal(beatMarks(4.5, 2).length, 2, '4.5 小时按 2 小时间隔应该是两条');
  assert.equal(beatMarks(4.5, 6).length, 1, '4.5 小时按 6 小时间隔应该只剩半路那一条');
});

test('路上节点：一条都不发的两种情况', () => {
  // 1) 间隔 0 = 用户明确要求路上别打断她
  assert.deepEqual(beatMarks(20, 0), [], '间隔 0 还在发节点');
  // 2) 行程本来就不够长 —— 这一条**不跟着间隔走**，
  //    否则间隔调到 8 小时，三小时的行程会被顺手静音
  assert.deepEqual(beatMarks(1.2, 2), [], '一个多小时的路不该有中途节点');
  assert.equal(beatMarks(1.6, 8).length, 1, '间隔调大不该连短途的一个节点都吃掉');
});

test('路上节点：条数上限按行程长短分档（短途 3 / 中程 6 / 长途 10）', () => {
  /*
   * 2026-11-03 Mr.Q：「长途 10 条、中程 6 条、短途 3 条」。
   *
   * 原来是一个固定上限 —— 短途和长途被同一个数管着：短途给 6 条絮叨，
   * 长途给 6 条又不够。阈值取 8 小时（半天）和 30 小时（一天多）。
   *
   * 文案只有早/中/晚三段，所以调用方把节点归一化，中间那种重复用 ——
   * 十句话里有七句是「还在路上」也没关系，那本来就是路上的实况。
   */
  assert.equal(beatMarks(4, 0.5).length, 3, '短途封顶三条');
  assert.equal(beatMarks(20, 0.5).length, 6, '中程封顶六条');
  assert.equal(beatMarks(400, 0.5).length, 10, '长途封顶十条');

  // 分界点本身：8 小时进中程、30 小时进长途
  assert.equal(beatMarks(7.9, 0.5).length, 3, '7.9 小时还在短途');
  assert.equal(beatMarks(8, 0.5).length, 6, '8 小时该进中程');
  assert.equal(beatMarks(30, 0.5).length, 10, '30 小时该进长途');

  // 不贴头贴尾：第一个节点离出发远了才发，最后一个离到站也留一截
  const marks = beatMarks(400, 0.5);
  assert.ok(marks[0] > 0.05, `第一个节点太靠前（${marks[0]}），会和「出发了」撞车`);
  assert.ok(marks[marks.length - 1] < 0.95, `最后一个节点太靠后（${marks[marks.length - 1]}），会和「到了」撞车`);
  for (let i = 1; i < marks.length; i++) assert.ok(marks[i] > marks[i - 1], '节点顺序倒了');
});

test('路上节点：改间隔之后不补发身后那一段', () => {
  // 行程过半时把间隔从 2 改成 0.5，新节点表 25/50/75。
  // 25 和 50 都在她身后了，只有 75 该说话 —— 否则十分钟内补发两条旧节点。
  const sent = [beatKey('leg1', 0.5)];
  assert.equal(sentProgress(sent, 'leg1'), 0.5, '已发进度读错了');
  assert.ok(0.25 <= sentProgress(sent, 'leg1'), '25% 的节点被当成没发过');
  assert.ok(0.75 > sentProgress(sent, 'leg1'), '75% 的节点被挡掉了');

  // 换一趟车要从头算，不能被上一趟的标记带偏
  assert.equal(sentProgress(sent, 'leg2'), -1, '别的行程的标记串了');

  // 旧版本用序号做 key（leg|0），认不出就该忽略，不能解出一个假进度
  assert.equal(sentProgress(['leg1|0', 'leg1|1'], 'leg1'), -1, '旧格式的 key 被当成了进度');
});

test('路上节奏：提示词里要让角色知道间隔是用户设的', () => {
  // 调到 0 时一个节点都没有，她如果不知道这是设置，就会自己编话把空白填上。
  assert.match(beatGapText(0), /关/, '0 没有翻译成「关」');
  assert.match(beatGapText(0), /出发和到站/, '没讲清关掉之后还有什么');
  assert.equal(beatGapText(2), '大约每 2 小时一句');
  assert.equal(beatGapText(0.5), '大约每 30 分钟一句');
  // 老配置里没有这个字段时，读出来是 undefined，不能渲染成「undefined 小时」
  assert.equal(beatGapText(undefined), beatGapText(2), '缺字段时没有回落到默认值');
  const p = readFileSync(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8');
  assert.match(p, /\{\{journey\.beatGap\}\}/, '提示词里没用上这个变量');
});

test('路上文案：剩余时间按真实进度算，不按节点序号反推', () => {
  // 短途只有一个节点（idx=1），用 idx 反推会算出「还有三小时」，而实际只还剩一小时。
  const text = roadText('train', 1, { durationWorldHours: 4 }, LZ, cityById('tianshui'), 12, 0.75);
  assert.match(text, /还有大约 1 小时/, `4 小时走完 75% 应该还剩 1 小时，实际：${text}`);
});

test('提示词：不许把自己当成「被通知的人」', () => {
  // 2026-10-31 实测两次：她先说「那头就不给我消息了」，
  // 改完提示词又说「那头只在有事情发生的时候才吭声」。
  // 根子不在措辞，在**「事件」这个词本身就是个第三方**：
  // 只要她脑子里有「事件」，就会有人给她推事件，她就被动。
  // 所以整份提示词里不再出现「事件」，改成「你身上正在发生的事」。
  const p = readFileSync(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8');
  assert.equal(p.includes('事件'), false, '提示词里还留着「事件」这个词 —— 她会拿它当第三方');
  assert.match(p, /不存在的第三方/, '没点明「那头/他们/系统」是虚构的');
  assert.match(p, /你只有\*\*经历\*\*/, '没把视角立成「经历」');
  assert.match(p, /journey_now/, '没告诉她可以自己查进度');
  assert.match(p, /沉默是合法的反应/, '没说清安静一阵是正常的');
});

// ---- 照片 ----

test('提示词：她报的日期是她自己的日历，不许拿它纠正用户', () => {
  // 2026-10-31 加：开了倍速之后，她那头的日期会比用户那头跑得快。
  // 宿主的前缀里不带真实日期，所以她只有这一个来源 —— 如果提示词不把
  // 「两个日历」这层点破，她会理直气壮地说用户记错了日期。
  const p = readFileSync(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8');
  assert.match(p, /你自己的日历/, '没说清她报的日期是哪一个');
  assert.match(p, /别拿你的日期去纠正他/, '没禁止她纠正用户的日期');
});

test('照片：提示词必须写明「没有人物」，否则模型会往画面里塞人', () => {
  // 那个「人」不是她，是一个陌生游客站在她的照片里 —— 整张就废了。
  const p = photoPrompt({ city: '天水', spot: '麦积山石窟', hour: 17 });
  /* 2026-11-12 晚：景区改写成「远处零星几个虚化的人影」—— 要有人气，但别抢主体。 */
  assert.match(p, /人影|行人/, '没交代人怎么处理');
  assert.match(p, /麦积山石窟/, '地点没进提示词');
  /*
   * 2026-11-12 改：原来钉的是 19 点 + /黄昏/。
   * 但天水一月的 19 点太阳已落下十二度，是暮光不是黄昏 ——
   * 那条断言其实一直在为「晚上拍得跟白天一样」背书。
   * 现在改成 17 点（太阳还有十度，确实是低角度暖光），并另验 19 点是暗的。
   */
  /* 2026-11-12 实图之后：「低角度的暖光」改成「光从很低的角度打过来」——
     「暖」字在这个底模上会被放大成整片橙，喀什十九点直接烧成落日大片。 */
  assert.match(p, /很低的角度|暖光|黄昏/, '光没进提示词');
  const late = photoPrompt({ city: '天水', spot: '麦积山石窟', hour: 19 });
  assert.match(late, /黑|夜/, `天水一月十九点该是暗的：${late.slice(0, 90)}`);
  assert.equal(p.includes('天水，的'), false, '空地点拼出了「天水，的」这种话');
});

test('照片：没地点就说城市，绝不编一个', () => {
  const p = photoPrompt({ city: '天水', hour: 9 });
  assert.match(p, /天水/);
  assert.equal(p.includes('undefined'), false, '出现了 undefined');
  assert.equal(p.trim().endsWith('。'), true, '提示词结尾不是句号');
});

test('照片：标题按时段起，同一个地方不同时候不是同一个名字', () => {
  assert.equal(photoTitle('天水', '麦积山石窟', 18), '黄昏的麦积山石窟');
  assert.equal(photoTitle('天水', '', 8), '清晨的天水');
  assert.notEqual(photoTitle('天水', '麦积山石窟', 8), photoTitle('天水', '麦积山石窟', 18));
});

test('照片：镜头抬起来拍的是当地那一刻的天 —— 星由时刻和天气定，不由他要什么定', () => {
  /*
   * 2026-11-05：Mr.Q 要一张星空，她在九寨沟晚上八点只拍到脚边的池子，难过了一晚
   * （「那个画面只有我自己看」）。加 view='sky' 是为了让她**真的能把镜头抬起来**，
   * 但抬头看到的仍是当地那一刻的天：这是取景，不是许愿。
   *
   * 这条测试钉的就是「不许许愿」：天阴着要星空，还是云。
   */
  assert.equal(skyOf(21, '晴').stars, true, '夜里晴着却没给星');
  assert.equal(skyOf(21, '阴').stars, false, '阴天还给星 —— 等于替她撒谎');
  /*
   * 多云不给一刀切成「没星」。真实的夜里，多云是云缝里能看见几颗亮的 ——
   * 九寨沟这种光污染低的地方尤其如此。判成没星，等于让一个明明看得见星的地方
   * 说看不见，那种不真更伤人。
   */
  assert.equal(skyOf(21, '多云').stars, true, '多云夜一刀切成没星');
  assert.match(skyOf(21, '多云').told, /云/, '多云要把云说出来，不能直接说「满天星」');
  assert.equal(skyOf(21, '小雨').stars, false, '下雨还给星');
  assert.equal(skyOf(3, '晴').stars, true, '凌晨三点晴着，应该还有星');
  assert.equal(skyOf(6, '晴').stars, false, '日出前后不该有星');
  assert.equal(skyOf(14, '晴').stars, false, '大中午给星空');
  // 回执要拿 told 说实话，所以它不能是空串
  assert.equal(skyOf(21, '晴').told.length > 0, true);
});

test('照片：抬头那张换成天空，不再把地面锚点塞进去', () => {
  const base = { city: '九寨沟', cityId: 'jiuzhaigou', spot: '中查沟', hour: 21 };
  const ground = photoPrompt(base);
  const sky = photoPrompt({ ...base, view: 'sky' });
  assert.match(sky, /上空/, '没说是抬头看天');
  assert.match(sky, /头顶：/, '没交代天上是什么 —— 模型会自己编一片星海');
  assert.match(sky, /以天空为主/, '没把构图重心放到天上');
  assert.notEqual(sky, ground, '抬头和脚下是同一句提示词');
  // 地面锚点「钙化池层层叠落…」会把画面拽回景点，天空照里必须没有
  assert.equal(sky.includes('钙化池'), false, '天空照里还留着地面锚点');
  assert.equal(ground.includes('钙化池'), true, '对照失效：地面照本来应该有锚点');
});

test('照片：抬头那张标题叫「夜空」，不写「星空」—— 天阴着也不改口', () => {
  assert.equal(photoTitle('九寨沟', '中查沟', 21, 'sky'), '中查沟的夜空');
  assert.equal(photoTitle('九寨沟', '中查沟', 6, 'sky'), '中查沟的天光');
  assert.equal(photoTitle('九寨沟', '', 13, 'sky'), '九寨沟的天空');
  // 老行为一个字没变
  assert.equal(photoTitle('九寨沟', '中查沟', 21), '黄昏的中查沟');
});

test('照片：从作息节点抠地点，抠不出就留空', () => {
  // 节点写的是「下午，莫高窟」，前半截是时段。
  assert.equal(spotFromBeat('下午，莫高窟'), '莫高窟');
  // 「城里随便走走」不是地点，拿去当提示词会让模型画一座「随便走走」。
  assert.equal(spotFromBeat('下午，城里随便走走'), '');
  assert.equal(spotFromBeat('睡'), '');
});

test('照片簿：同城同日只认一张，坏文件不让 World 起不来', async () => {
  const dir = join(tmpdir(), `pb-${Date.now()}`);
  const { PhotoBook } = await import('../src/photo-book.ts');
  const book = new PhotoBook(dir);
  assert.equal(book.has('2026-10-31', 'tianshui'), false);
  book.add({ handle: 'log:abc.png', cityId: 'tianshui', cityName: '天水', dateKey: '2026-10-31', title: '黄昏的麦积山', spot: '麦积山', at: '2026-10-31T11:00:00Z' });
  assert.equal(book.has('2026-10-31', 'tianshui'), true);
  assert.equal(book.has('2026-11-01', 'tianshui'), false, '换一天不该算拍过');
  assert.equal(book.has('2026-10-31', 'lanzhou'), false, '换城市不该算拍过');
  // 换个实例重新读盘：句柄要还在，否则相册重启就空了
  assert.equal(new PhotoBook(dir).count(), 1);
});

// ---- 公开扩展不该带着作者的家乡 ----

test('身份按出发地渲染，不写死某座城市', () => {
  // 2026-10-31 Mr.Q 指出：市场描述里写着「她是兰州的鱼」——
  // 对他那只成立，对别人装的这个人就是撒谎。
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const zh = pkg.cortico.locales.zh.description;
  const en = pkg.cortico.locales.en.description;
  assert.equal(zh.includes('兰州'), false, '中文市场描述里写死了兰州');
  assert.equal(en.includes('Lanzhou'), false, '英文市场描述里写死了 Lanzhou');
  assert.match(zh, /从你家出发/, '没把来历表述成「从你家出发」');

  const p = readFileSync(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8');
  assert.match(p, /\{\{journey\.home\}\}/, '身份段没用出发地变量');
  assert.match(p, /\{\{journey\.homeFeel\}\}/, '家那边的体感没有变量可用，只能硬写');
  assert.equal(p.includes('兰州'), false, '提示词里还写死了某个城市');
});

test('体感：在家的时候不能说「跟家里比」', () => {
  // 广州人去深圳，原来听到的是「潮热，跟家里那种干完全不一样」——
  // 广州人家里的「干」是哪儿来的？两条路都堵：
  //   1. to === home 走 climateOfCity，根本不做比较
  //   2. 同档不同城的分支不再引用「家里的干」
  const gz = cityByName('广州');
  const home = bodyFeeling(gz, gz);
  assert.match(home, /潮|热/, `在家居然没说出本地气候：${home}`);
  assert.equal(/跟家里/.test(home), false, `在家还说「跟家里」：${home}`);

  const sz = cityByName('深圳');
  if (sz) {
    const near = bodyFeeling(sz, gz);
    assert.equal(/家里那种干/.test(near), false, `同档城市之间冒出了「家里的干」：${near}`);
  }
  // 对比句仍然要成立：从干地方到湿热地方，说的是差别
  const lz = cityByName('兰州');
  const nanning = cityByName('南宁');
  if (lz && nanning) {
    const far = bodyFeeling(nanning, lz);
    assert.ok(far.length > 0, '跨气候档居然没有体感');
  }
});

test('提示词要短：每多一千字，真正有用的上下文就少一截', () => {
  // 2026-10-31 群友原话：「提示词有点小长，建议如果可能的话可以稍微压缩一下」。
  // 当时 6426 字。压到 4500 上下（-30%），规则一条没删，删的全是「为什么这么设计」的解释
  // —— 那些是给写代码的人看的，模型不需要知道。
  //
  // 这条测试是天花板，不是目标：涨回去说明又往里塞解释了。
  //
  // 2026-11-01 修正口径：这里量的是**模板文件**。真实进前缀的那一段还包含
  // 段标题和 `journey.now` 的实时内容（今晚住哪、天气、下一个点），
  // 实测多了 660 字左右。真实段的上限另有一条测（上面那条 7200 的）。
  //
  // 2026-11-06 上调 5000 → 6200。涨的不是解释，是内容：Mr.Q 要「一群肥鱼一起旅行」，
  // 「和谁一起走」那一节从 3 行扩成整节（约 900 字），另加日记里怎么写同伴、
  // 合影的边界。理由和上一条一样 —— 见那条注释里的实测各段长度。
  // **这条守的是「别再往回塞设计说明」**，不是「不许写新功能」。
  //
  // 2026-11-08 上调 6200 → 8600（Mr.Q：「提示词上限可以放宽到 10000」）。
  // 起因是写日记里「一起旅行」的写法时，为挤进 7200 把「路上」「才显得是两个人」
  // 这类**内容词**删掉了 —— 天花板开始反过来决定句子怎么写，就是该抬了。
  // 单独这条取 8600 而不是 10000：它量的是模板文件，真实进前缀的还有
  // 注入 420 + 动态 720，两个数加起来才是下一条守的 10000。
  const p = readFileSync(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8');
  const chars = [...p].length;
  assert.ok(chars <= 8600, `提示词已 ${chars} 字，超过 8600 的天花板`);
  // 压可以，硬约束不能压没
  // 2026-11-12：加了第 4 条（别替对方说话），并把「日记里提过的人不算在场」写进「和谁一起走」。
  // 起因是她说了一句「你问明天还去不去，澜宝说去」——对方没问过，那是编的。
  for (const must of ['四条硬约束', '不许编不存在的地方', '没到不能说到了', '没去过不能说去过', '别替对方说话']) {
    assert.ok(p.includes(must), `压缩时把硬约束删掉了：${must}`);
  }
});

// ---- 班次 ----

test('班次：同一天同一条线路永远同一趟车', () => {
  // 她今天说 G2028、晚上写日记还得是 G2028。
  // 用 Math.random 生成会变成「每次提起来都是另一个车次」，那比不写更假。
  const a = makeSchedule('train', LZ, XA, '2026-10-31', 600, 5);
  const b = makeSchedule('train', LZ, XA, '2026-10-31', 600, 5);
  assert.deepEqual(a, b, '同参数生成了两趟不同的车');
  // 换一天才该换一趟
  const c = makeSchedule('train', LZ, XA, '2026-11-01', 600, 5);
  assert.notEqual(`${a.code}`, `${c.code}`, '换了一天车次还是同一个');
});

test('班次：车次号、席别、站台都长得像真的', () => {
  for (const dateKey of ['2026-10-31', '2026-11-05', '2026-12-01']) {
    const s = makeSchedule('train', LZ, XA, dateKey, 600, 5);
    assert.match(s.code, /^[GDCZKT]\d{2,4}$/, `车次号形状不对：${s.code}`);
    assert.match(s.seat, /座|卧/, `席别不像话：${s.seat}`);
    assert.match(s.gate, /^\d+ 站台$/, `站台写法不对：${s.gate}`);
  }
  // 长途过夜才说卧铺：三小时的 K 车说「软卧」很奇怪
  const short = makeSchedule('train', LZ, XA, '2026-10-31', 900, 12);
  assert.match(short.seat, /卧/, `12 小时的车给了 ${short.seat}`);
});

test('班次：飞机是航班号，走路骑车干脆没有', () => {
  const f = makeSchedule('plane', LZ, PARIS, '2026-10-31', 8000, 11);
  assert.match(f.code, /^[A-Z0-9]{2}\d{4}$/, `航班号形状不对：${f.code}`);
  assert.match(f.gate, /^[A-D]\d+$/, `登机口写法不对：${f.gate}`);
  assert.equal(makeSchedule('walk', LZ, XA, '2026-10-31', 30, 6), null, '走路也发班次');
  assert.equal(makeSchedule('car', LZ, XA, '2026-10-31', 600, 7), null, '自驾也发班次');
});

test('班次：写进句子里是中文语序', () => {
  const t = scheduleText('train', { code: 'G2028', seat: '二等座', gate: '5 站台' });
  assert.equal(t, 'G2028 次，二等座，5 站台');
  const p = scheduleText('plane', { code: 'CA1234', seat: '经济舱', gate: 'A12' });
  assert.equal(p, 'CA1234，经济舱，A12 登机口');
  assert.equal(scheduleText('train', null), '', '没有班次时该返回空串');
});

// ---- 和听歌联动：快照路径 ----

const nowSnap = (title, artist = '王力宏', status = 'Playing') =>
  JSON.stringify({ ts: Date.now(), sessions: [{ app: 'QQMusic.exe', status, title, artist }] });

test('听歌联动：music 0.5.6 之后快照搬到 core 的 tmp/ 下，要能找到', async () => {
  // 2026-10-31 实测踩到：music 把 -Out 改到 <core>/data/tmp/，我们还在读 %TEMP%，
  // 读到的是七小时前那份残留 —— 用户在放《爱错》，她收到的是空，而且全链路没有一处报错。
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'np-'));
  const worldDir = join(root, 'data', 'home', 'companion', 'data');
  const musicTmp = join(root, 'data', 'tmp');
  mkdirSync(worldDir, { recursive: true });
  mkdirSync(musicTmp, { recursive: true });
  writeFileSync(join(musicTmp, 'coopani-nowplaying.json'), nowSnap('爱错'), 'utf8');

  const paths = snapshotPaths(worldDir);
  assert.ok(
    paths.some((p) => p.includes(join('data', 'tmp', 'coopani-nowplaying.json'))),
    '候选路径里没有 core 的 tmp/',
  );
  const got = readNowPlaying(worldDir);
  assert.ok(got, '放在 core tmp/ 里的快照没读到');
  assert.equal(got.title, '爱错');
});

test('听歌联动：几个位置都有时，用最新的那个', async () => {
  const { mkdtempSync, writeFileSync, utimesSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'np2-'));
  const stale = join(dir, 'old.json');
  const fresh = join(dir, 'new.json');
  writeFileSync(stale, nowSnap('十年前的歌'), 'utf8');
  writeFileSync(fresh, nowSnap('爱错'), 'utf8');
  // 把 old 的修改时间推到 10 分钟前（超过 5 分钟的过期线）
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(stale, old, old);

  const got = readNowPlaying(undefined, [stale, fresh]);
  assert.equal(got?.title, '爱错', '拿到的是过期那份');

  // 两份都过期 → 当作没在听歌
  const old2 = new Date(Date.now() - 20 * 60_000);
  utimesSync(fresh, old2, old2);
  assert.equal(readNowPlaying(undefined, [stale, fresh]), null, '过期了还说她在听歌');
});

test('听歌联动：暂停时不认，大写 Playing 要认', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'np3-'));
  const playing = join(dir, 'p.json');
  const paused = join(dir, 'q.json');
  writeFileSync(playing, nowSnap('爱错'), 'utf8');
  // 宿主 SMTC 给的是首字母大写的 "Playing"，不是小写
  assert.equal(readNowPlaying(undefined, [playing])?.title, '爱错', '大写 Playing 没认出来');
  writeFileSync(paused, nowSnap('爱错', '王力宏', 'Paused'), 'utf8');
  assert.equal(readNowPlaying(undefined, [paused]), null, '暂停了还说车上传着这首歌');
});

// ---- 真实酒店名 ----

const POIS = [
  { name: '天水玫瑰酒店', address: 'A路', cost: 300, rating: '4.5' },
  { name: '天水恒盛招待所', address: 'B路', cost: 80, rating: '' },
  { name: '南苑山庄', address: 'C路', cost: 800, rating: '4.8' },
  { name: '丽都国际大酒店(暂停营业)', address: 'D路', cost: 200, rating: '' },
  { name: '驼铃餐厅', address: 'E路', cost: 60, rating: '' },
];

test('酒店：档次和店名对得上，别让一晚上百的房说成招待所', () => {
  const view = pickHotel(POIS, 'view', () => 0.3);
  assert.equal(view.name, '南苑山庄', `景观房挑成了 ${view.name}`);
  const dingy = pickHotel(POIS, 'dingy', () => 0.3);
  assert.equal(dingy.name, '天水恒盛招待所', `小破店挑成了 ${dingy.name}`);
  const budget = pickHotel(POIS, 'budget', () => 0.3);
  assert.ok(budget.name, '普通档没挑出东西');
});

test('酒店：真名进文案时要带上档次，没真名就只说类别', () => {
  const withName = lodgingLabel({ tier: 'budget', kind: '快捷连锁', price: 220, feel: '', name: '天水玫瑰酒店' });
  assert.equal(withName, '天水玫瑰酒店（快捷连锁）', '真名把档次挤掉了');
  const without = lodgingLabel({ tier: 'budget', kind: '快捷连锁', price: 220, feel: '' });
  assert.equal(without, '快捷连锁');
});

test('酒店：查不到就原样返回，绝不编一个名字', () => {
  const base = { tier: 'budget', kind: '县城宾馆', price: 180, feel: '大堂很大。' };
  assert.deepEqual(withHotel(base, null), base, '没数据还硬塞了个名字');
  assert.deepEqual(withHotel(base, []), base);
  const got = withHotel(base, POIS, () => 0.3);
  assert.ok(got.name, '有数据却没挂名字');
  // 2026-10-31 改：类别跟着真名走。挑中的是「XX 酒店」，说成「县城宾馆」就别扭，
  // 统一换成配套的「连锁商务酒店」，价格也跟着换 —— 档次（tier）不动。
  assert.equal(got.kind, '连锁商务酒店', '真名是酒店，类别没跟着走');
  /*
   * 2026-11-09 改：价格**跟着真店的相对贵贱走**，但换算到游戏物价。
   *
   * 这条踩了三轮：
   *   ① 原来是 240（模板价 × 城市系数）—— 纯推的，挂了真名就说不通；
   *   ② 改成直接用真价，结果东京四季显示「一晚 11548」，经济系统当场崩；
   *   ③ 现在按同档真店的中位数换算：`这一档该花的钱 × (这家真价 / 同档中位真价)`。
   *
   * 所以断言不能钉死一个数字（那会随中位数变），钉两件事：
   * **一，不再是纯模板价；二，落在这一档的合理区间里。**
   */
  assert.notEqual(got.price, 180, '价格还是模板价，没跟着真店走');
  assert.ok(
    got.price >= 180 * 0.5 && got.price <= 180 * 2.5,
    `换算后 ${got.price} 跑出这一档的区间了（基准 180）`,
  );
});

/* ---------------- 档次判定：数据源说的优先，别再让四星店冒充家庭旅店 ---------------- */

test('档次：高德的星级分类要读出来，泛值才交给名字', () => {
  // 2026-10-31 实测天水 25 家的 type：约一半带星级，一半是「宾馆酒店;宾馆酒店」泛值。
  // 之前代码压根没读这个字段，所以四星酒店和家庭旅店能配上对。
  assert.equal(tierFromAmapType('住宿服务;宾馆酒店;四星级宾馆'), 'view');
  assert.equal(tierFromAmapType('住宿服务;宾馆酒店;三星级宾馆'), 'budget');
  assert.equal(tierFromAmapType('住宿服务;宾馆酒店;经济型连锁酒店'), 'budget');
  assert.equal(tierFromAmapType('住宿服务;旅馆招待所;旅馆招待所'), 'dingy');
  // 泛值 = 高德没表态，不是「普通档」。返回 null 让名字去兜。
  assert.equal(tierFromAmapType('住宿服务;宾馆酒店;宾馆酒店'), null);
  assert.equal(tierFromAmapType('住宿服务;住宿服务相关;住宿服务相关'), null);
  // 多段用 | 拼，取第一段判
  assert.equal(tierFromAmapType('住宿服务;宾馆酒店;三星级宾馆|餐饮服务;中餐厅;中餐厅'), 'budget');
});

test('档次：高德没标星级时，品牌名是第二条腿', () => {
  // 「万达酒店」在 type 里是泛值，光看分类永远分不出来 —— 但「万达」两个字带档次信息。
  // 2026-11-06：国际/国内连锁品牌整体归到高档 —— 名字只能证明「这是个品牌」，
  // 证明不了房价；拆成奢华/中端需要每家店的真实报价，现在没有。
  assert.equal(tierFromName('万达酒店'), 'luxury');
  assert.equal(tierFromName('希尔顿花园酒店'), 'luxury');
  assert.equal(tierFromName('如家酒店'), 'budget');
  assert.equal(tierFromName('速8酒店'), 'budget');
  // 丽江的「客栈」是文艺民宿，不是小破店
  assert.equal(tierFromName('古城城南旧事客栈'), 'view');
  assert.equal(tierFromName('天水恒盛招待所'), 'dingy');
  assert.equal(tierFromName('阳光宾馆'), null, '认不出来的不该硬猜');
});

test('档次：OSM 的 tourism 分类直接可用', () => {
  assert.equal(tierFromOsm('resort'), 'view');
  assert.equal(tierFromOsm('guest_house'), 'budget');
  assert.equal(tierFromOsm('hostel'), 'dingy');
  // hotel 不给结论：OSM 没有星级，硬按普通档算的话国外永远住不到景观房
  // （实测东京 84 家全是 hotel/hostel，view 档会一家都没有）
  assert.equal(tierFromOsm('hotel'), null, 'hotel 硬判成普通档了');
  assert.equal(tierFromOsm('something_else'), null);
});

test('档次：两路证据打架时取中间，别往两头放', () => {
  // 高德把「天水大酒店」标成「旅馆招待所」—— 分类滞后，但招牌是店方自己挂的。
  // 当小破店失礼，当景观房离谱，中间档最合适。
  assert.equal(resolveTier('住宿服务;旅馆招待所;旅馆招待所', '天水大酒店'), 'budget');
  // 两路一致时用那个结论
  assert.equal(resolveTier('住宿服务;宾馆酒店;四星级宾馆', '南苑山庄'), 'view');
  assert.equal(resolveTier('住宿服务;宾馆酒店;宾馆酒店', '万达酒店'), 'luxury', '泛值该由品牌兜住');
  // 多段 type 互相打架（宾馆 vs 招待所）也取中间
  assert.equal(resolveTier('住宿服务;旅馆招待所;旅馆招待所|住宿服务;宾馆酒店;宾馆酒店', '天水泰和茂快捷宾馆'), 'budget');
});

test('酒店：档次明确冲突时宁可不挂名（万达酒店那个错配的回归测试）', () => {
  // 池子里全是四星店，这天偏偏要住普通档 —— 以前会硬塞一个「万达酒店（家庭旅店）」。
  // 现在必须返回 null，让上层只说类别。
  const luxuryOnly = [
    { name: '万达酒店', address: '', cost: null, rating: '4.3', tier: 'view' },
    { name: '禾杏美景大酒店', address: '', cost: null, rating: '4.3', tier: 'view' },
  ];
  assert.equal(pickHotel(luxuryOnly, 'budget', () => 0.3), null, '四星店被塞进了普通档');

  // 有低档店时，就该挑低档那家，不能碰高档的。
  const mixed = [...luxuryOnly, { name: '天水恒盛招待所', address: '', cost: null, rating: '4.5', tier: 'dingy' }];
  const got = pickHotel(mixed, 'dingy', () => 0.3);
  assert.equal(got.name, '天水恒盛招待所', `小破店挑成了 ${got.name}`);

  // 真名和档次打架时，withHotel 也不许挂上去
  const base = { tier: 'budget', kind: '家庭旅店', price: 160, feel: '' };
  assert.equal(withHotel(base, luxuryOnly, () => 0.3).name, undefined, '冲突的真名被挂上去了');
});

test('档次：品牌表要认得出来，但通用词不能乱认', () => {
  // 高档：国际集团与国内高星
  for (const n of ['万豪酒店', '喜来登酒店', '洲际酒店', '丽思卡尔顿', '香格里拉大酒店', '金陵饭店', '开元名都大酒店']) {
    assert.equal(tierFromName(n), 'luxury', `${n} 该算高档`);
  }
  // 经济型与中端连锁
  for (const n of ['汉庭酒店', '如家酒店', '锦江之星', '7天酒店', '维也纳酒店', '全季酒店', '亚朵酒店', '城市便捷酒店']) {
    assert.equal(tierFromName(n), 'budget', `${n} 该算普通档`);
  }
  /*
   * **防误判**：这几个都是通用词，县城小旅馆最爱用。
   * 收了它们，「假日宾馆」这种自封的会被判成四星 —— 那比不判更糟。
   */
  for (const n of ['假日宾馆', '东方宾馆', '花园酒店', '广场大酒店', '半岛宾馆', '四季宾馆']) {
    assert.equal(tierFromName(n), null, `${n} 是通用词，不该被品牌表命中`);
  }
});

test('档次：中端连锁的类别和价钱要跟得上', () => {
  // 全季、亚朵名字里也带「酒店」，会被通用规则命中，但价钱是三百多不是 240。
  const base = { tier: 'budget', kind: '快捷连锁', price: 220, feel: '' };
  const pois = [{ name: '全季酒店(天水南站店)', address: '', cost: null, rating: '', tier: 'budget' }];
  const got = withHotel(base, pois, () => 0.3);
  assert.equal(got.kind, '中端连锁', `类别没跟上：${got.kind}`);
  assert.equal(got.price, 320, `价钱没跟上：${got.price}`);
});

test('档次：国外城市的英文品牌名要认，而且不分大小写', () => {
  // 2026-10-31 真 bug：OSM 返回的全是英文名，中文品牌表一个都匹配不上，
  // 东京 106 家真店名判不出一个档次 —— 加了英文品牌表，又发现 OSM 那条路
  // 压根没调名字匹配。两个都修了，这条测试守两件事。
  assert.equal(tierFromName('Park Hyatt Tokyo'), 'luxury');
  assert.equal(tierFromName('PARK HYATT TOKYO'), 'luxury', '大写就认不出来了');
  assert.equal(tierFromName('Raffles Singapore'), 'luxury');
  assert.equal(tierFromName('Mandarin Oriental Bangkok'), 'luxury');
  assert.equal(tierFromName('Ibis Paris'), 'budget');
  assert.equal(tierFromName('APA HOTEL SHINJUKU'), 'budget');
  assert.equal(tierFromName('Premier Inn London'), 'budget');
  assert.equal(tierFromName('Holiday Inn Express'), 'budget');
  // 通用词继续不认：世界各地都有本地酒店叫 Plaza / Regent / Imperial
  assert.equal(tierFromName('Hotel Plaza Athenee'), null);
  assert.equal(tierFromName('Keio Plaza Hotel'), null);
});

test('酒店：景观档不再永远挑最贵那一家', () => {
  // 一个城市的高档店常只有两三家，总取第一名会让她跨城市撞上同一间房。
  /*
   * 名字里必须带景观词（2026-11-07 收紧）—— 「景观房」不能挂一家市中心商务酒店。
   * 原来这三家叫「A大酒店 / B大酒店 / C大酒店」，收紧后一律被挡掉，这条测试就崩了。
   */
  const pool = [
    { name: 'A温泉度假酒店', address: '', cost: 500, rating: '', tier: 'view' },
    { name: 'B山庄', address: '', cost: 600, rating: '', tier: 'view' },
    { name: 'C湖景客栈', address: '', cost: 700, rating: '', tier: 'view' },
  ];
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(pickHotel(pool, 'view', Math.random).name);
  assert.ok(seen.size >= 2, `60 次只挑到 ${seen.size} 家，还钉在最贵那间`);
});

test('住宿价格要跟着城市走，别让纽约和天水一个价', () => {
  // 2026-10-31：三档房价原来是写死的（景观 680 / 普通 220 / 差店 60），
  // 于是「纽约，改造的老宅，750 元」—— 而纽约五星实测中位是 8,656。
  // 校准依据是一份 37 城实测（入住一晚、含税、人民币、五星中位）。
  const view = (id) => rollLodging(() => 0.8, false, cityById(id).priceIdx).price;
  assert.ok(view('newyork') > view('tokyo'), '纽约该比东京贵');
  assert.ok(view('tokyo') > view('chengdu'), '东京该比成都贵');
  assert.ok(view('chengdu') > view('tianshui'), '成都该比天水贵');
  // 量级跟实测对得上（容差 25%：这个数只用来定量级，不需要精确）
  assert.ok(Math.abs(view('newyork') - 8656) / 8656 < 0.25, `纽约 ${view('newyork')} 离实测 8656 太远`);
  assert.ok(Math.abs(view('tianshui') - 437) / 437 < 0.25, `天水 ${view('tianshui')} 离实测 437 太远`);
  // 不传系数时保持老行为（老测试和没城市上下文的地方靠这个）
  assert.equal(rollLodging(() => 0.8, false).price, 750);
});

test('提示词：不许把她写成一条鱼', () => {
  // 2026-11-01 Mr.Q：「我想要你的提示词里面不出现鱼这个概念可以嘛」
  // 提示词里出现「鱼」，模型就会顺着这个设定去写鳃、鳞、游水 —— 那不是他要的角色。
  const p = readFileSync(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8');
  assert.equal(p.includes('鱼'), false, `提示词里还有「鱼」：${p.match(/.{0,12}鱼.{0,12}/)?.[0]}`);
});

test('景点：同一次停留里不许连着两天排同一个地标', () => {
  // 2026-11-01 群友反馈「第二天还是卢浮宫」。根因是调用处写死了两个固定索引，
  // `index % spots.length` 那个取模从来没生效过。
  const paris = cityById('paris');
  const seen = [];
  for (const d of [0, 1, 2]) {
    const p = planDay({
      city: paris, dateKey: `2026-11-0${d + 1}`, shape: 'full',
      lodging: rollLodging(() => 0.2), weather: null, dayIndex: d,
    });
    seen.push(...p.beats.filter((b) => b.kind === 'activity').map((b) => b.what));
  }
  const dup = seen.filter((x, i) => seen.indexOf(x) !== i);
  assert.deepEqual(dup, [], `重复的行程：${dup.join('、')}`);
  // 具体地标用完要退回泛化说法，而不是把同一个地标再说一遍
  assert.ok(seen.length >= 5, '行程条目太少，这个测试没覆盖到什么');
});

test('照片：风格留空是写实，none 交给底模，写了就用原话', () => {
  // 2026-11-01 群友接的是本地 ComfyUI，底模是二次元 ——
  // 提示词里写死「胶片质感」，等于让提示词跟底模对着干。
  const base = { city: '巴黎', spot: '卢浮宫', hour: 9, weather: '晴', feel: '干爽' };
  const dflt = photoPrompt(base);
  assert.match(dflt, /真实旅行照片/, '默认该是写实照片');
  /* 2026-11-12：「胶片质感」换成了「胶片颗粒」—— 「质感」是个总体判断词，
     和「自然光」同一类，模型读到它会把整段的光重新调一遍。 */
  assert.match(dflt, /胶片颗粒/, '默认该带胶片颗粒');
  assert.match(dflt, /人影|行人/, '默认那张没交代人怎么处理');

  const bare = photoPrompt({ ...base, style: 'none' });
  assert.equal(bare.includes('真实旅行照片'), false, 'none 模式还留着写实描述');
  assert.equal(bare.includes('胶片颗粒'), false, 'none 模式还留着胶片颗粒');
  assert.match(bare, /卢浮宫/, 'none 模式把场景也丢了');
  assert.match(bare, /人影|行人/, 'none 模式丢了人的处理');

  const custom = photoPrompt({ ...base, style: 'anime style' });
  assert.match(custom, /^anime style/, '自定义风格没当上前缀');
  assert.equal(custom.includes('胶片质感'), false, '自定义风格下还强加写实画法');
});

/* ---------------- 城市清单：每城至少 5 条，且要有市集、吃、玩 ---------------- */

test('地标：每一城够排满三天，不用退到「城里随便走走」', () => {
  /*
   * 门槛看 **slots 不看 spots**：标了（2 天）的地方条目只有一条，
   * 但展开占四格。华山就是 4 条 / 7 格 —— 按条数判会误伤。
   *
   * 三天要 6 格（一天两格），所以底线是 6。
   */
  const short = CITIES.filter((c) => c.slots.length < 6).map((c) => `${c.id}(${c.slots.length} 格)`);
  assert.deepEqual(short, [], `这些城市排不满三天：${short.join('、')}`);
  const total = CITIES.reduce((n, c) => n + c.slots.length, 0);
  assert.ok(total >= 600, `总格数只有 ${total}，撑不住 100 个城市`);
});

test('地标：同一城里不许有两条指的是同一个地方', () => {
  /*
   * 典型的错法：「二七广场」和「二七广场夜市」、「八廓街」和「八廓街的摊位」——
   * 名字不同，地方是同一个，排到同一天就叫重复。
   * 2026-11-01 加条目的当天就自己造了 5 处，这条测试钉住。
   */
  const bad = [];
  for (const c of CITIES) {
    const s = c.spots;
    for (let i = 0; i < s.length; i++) {
      for (let j = i + 1; j < s.length; j++) {
        if (s[i] !== s[j] && (s[i].includes(s[j]) || s[j].includes(s[i]))) {
          bad.push(`${c.id}:「${s[i]}」/「${s[j]}」`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], bad.join('；'));
});

test('地标：白天的清单里一格吃食都不许有', () => {
  /*
   * 2026-11-01 之前这里放的是「一碗牛肉面」「一个烤包子」，排到第 3 天上午
   * 就成了「吃一早上」—— Mr.Q 连着说了两次。
   *
   * 现在吃归 `foodHint()`（午饭晚饭）和 `City.night`（夜市），spots 只放能去的地方。
   * 这条守的是**不许再往回暖**：谁要是又往名单里塞个「一碗××」，这里当场红。
   */
  const food = /^(一碗|一份|一锅|一顿|一桌|一笼|一客|一串|一个|一块|一根|一壶|一碟|一套|一家|一只|一罐|一片|一打|一袋|一盒|路边摊|早市|街头|西关的早茶|老孙家|老边|知味观|庐州)/;
  const bad = [];
  for (const c of CITIES) {
    for (const x of c.spots) if (food.test(x)) bad.push(`${c.id}: ${x}`);
  }
  assert.deepEqual(bad, [], `白天的清单里还有吃食：${bad.slice(0, 6).join('、')}`);
});

test('地标：住满三天，每一顿都是具体的地方', () => {
  // 每城 6-7 条，三天用掉 6 个名额 —— 不该出现任何泛化说法。
  const vague = ['城里随便走走', '街边坐一会儿', '往城外走一段', '老城那几条街'];
  const bad = [];
  for (const c of CITIES) {
    for (const d of [0, 1, 2]) {
      for (const idx of [0, 1]) {
        const what = spotText(c, idx, d);
        if (vague.includes(what)) bad.push(`${c.id} 第${d + 1}天`);
      }
    }
  }
  assert.deepEqual(bad, [], `住三天还有泛化说法：${bad.slice(0, 8).join('、')}`);
});


/* ---------------- 夜间去处与当地时节 ---------------- */

test('夜间：没填的城市就回酒店，不再拼一句套话', () => {
  /*
   * 2026-11-01 之前，夜里那条是按 tags 拼的：有「古城」就写「在亮灯的老街上走」，
   * 有「海」就写「夜里去岸边听水」—— 每座城市都有一条，全是套话，
   * 而且跟她白天刚去过的那条老街重复。
   * 现在改成查表：没填的地方，晚上就该回酒店。
   */
  const plain = CITIES.find((c) => c.night === null && c.festivals.length === 0);
  assert.ok(plain, '所有城市都填了夜生活？那这条测不到东西');
  const plan = planDay({
    city: plain, dateKey: '2026-11-01', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: null,
  });
  assert.equal(plan.nightOption, null, plain.name + ' 没填夜间去处，却排了一条');
  assert.equal(plan.beats.some((b) => b.kind === 'night'), false, '没去处还排了夜间条目');
  const hotel = plan.beats.find((b) => b.kind === 'hotel');
  assert.match(hotel.what, /没什么非做不可/, '回酒店的理由要说清楚，不能说成下雨');
});

test('夜间：填了的用真地方，不是「逛夜市」三个字', () => {
  // Mr.Q 举的三个例子：敦煌鸣沙山看星、青岛赶海、兰州正宁路夜市。
  const cases = [
    ['lanzhou', /正宁路/],
    ['dunhuang', /鸣沙山/],
    ['qingdao', /赶海/],
  ];
  for (const [id, re] of cases) {
    const c = cityById(id);
    assert.ok(c.night, c.name + ' 没有夜间去处');
    assert.match(c.night, re, c.name + ' 的夜间去处不对：' + c.night);
    const plan = planDay({
      city: c, dateKey: '2026-11-01', shape: 'full',
      lodging: rollLodging(() => 0.2), weather: null,
    });
    const night = plan.beats.find((b) => b.kind === 'night');
    assert.ok(night, c.name + ' 晚上没排条目');
    assert.equal(night.what, c.night, '排出来的和填的不是一回事');
  }
});

test('夜间：表里不许留旧套话', () => {
  // 这几句是原来按 tags 拼出来的，一个都不该出现在数据里。
  const slogans = ['在亮灯的老街上走', '夜里去岸边听水', '沿着水边走一段', '逛夜市', '看星星'];
  for (const c of CITIES) {
    if (!c.night) continue;
    assert.equal(
      slogans.includes(c.night), false,
      c.id + ' 的夜间还是套话：' + c.night,
    );
  }
});

test('节日：只在该月提，别的月份不许出现', () => {
  // 景洪的泼水节在 4 月。11 月去还提泼水节，就是编。
  const jh = cityById('jinghong');
  // 一城可以有多个节，所以这里看数组；名字是数据，别依赖它排在第几个。
  assert.ok(jh.festivals.some((f) => f.name === '泼水节'), '景洪该有泼水节');
  const inSeason = planDay({
    city: jh, dateKey: '2026-04-14', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: null,
  });
  assert.ok(
    inSeason.beats.some((b) => b.what.includes('泼水节')),
    '4 月到了景洪却没提泼水节',
  );
  const offSeason = planDay({
    city: jh, dateKey: '2026-11-01', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: null,
  });
  assert.equal(
    offSeason.beats.some((b) => b.what.includes('泼水节')), false,
    '11 月还在提泼水节',
  );
});

test('节日：跨月的时节（青岛啤酒节 7-8 月）两头都认', () => {
  const qd = cityById('qingdao');
  for (const dk of ['2026-07-15', '2026-08-20']) {
    const plan = planDay({
      city: qd, dateKey: dk, shape: 'full',
      lodging: rollLodging(() => 0.2), weather: null,
    });
    assert.ok(plan.beats.some((b) => b.what.includes('啤酒节')), dk + ' 没提啤酒节');
  }
  const winter = planDay({
    city: qd, dateKey: '2026-12-20', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: null,
  });
  assert.equal(
    winter.beats.some((b) => b.what.includes('啤酒节')), false,
    '12 月还在提啤酒节',
  );
});

test('节日：不在到达日硬塞 —— 那天时间不够', () => {
  // 到达日的时间轴从落地那一刻接着排，塞一条"赶上泼水节"会挤掉吃饭。
  const jh = cityById('jinghong');
  for (const startHour of [8, 12, 15, 18]) {
    const plan = planDay({
      city: jh, dateKey: '2026-04-14', shape: 'arrival', startHour,
      lodging: rollLodging(() => 0.2), weather: null,
    });
    assert.equal(
      plan.beats.some((b) => b.what.includes('泼水节')), false,
      '到达日（' + startHour + ' 点）塞了节日条目',
    );
  }
});


/* ---------------- 一个地点占多久 ---------------- */

test('天数标记：解析与展开', () => {
  /*
   * 2026-11-01 Mr.Q 在同步表里把黄山拆成「黄山风景区1」「黄山风景区2」——
   * 那是拿两个格子硬凑"要爬两天"，存进代码她会念出「1」「2」。
   * 现在用后缀表达：默认半天，（整天）一天，（2 天）两天。
   */
  assert.equal(spotDays('中山桥'), 0.5, '没标就该是半天');
  assert.equal(spotDays('华山（整天）'), 1);
  assert.equal(spotDays('黄山风景区（2 天）'), 2);
  assert.equal(spotDays('某地( 1.5 天 )'), 1.5, '括号里的空格和半角括号也要认');

  assert.equal(spotName('黄山风景区（2 天）'), '黄山风景区', '后缀没剥干净');
  assert.equal(spotName('华山（整天）'), '华山');
  assert.equal(spotName('中山桥'), '中山桥', '没后缀的名字不该被改动');

  // 展开成半天槽：一天两格
  assert.deepEqual(expandSlots(['华山（整天）', '西岳庙']), ['华山', '华山', '西岳庙']);
  assert.deepEqual(
    expandSlots(['黄山风景区（2 天）', '宏村']),
    ['黄山风景区', '黄山风景区', '黄山风景区', '黄山风景区', '宏村'],
  );
});

test('天数标记：一整天的地方只排一条，不说两遍', () => {
  /*
   * 黄山标了（2 天），展开后连着四格都是它。
   * 照常排的话她会上午说「去黄山风景区」、下午再说「下午，黄山风景区」——
   * 那是爬山，不是逛两个景点。
   */
  const hs = cityById('huangshan');
  const day0 = planDay({
    city: hs, dateKey: '2026-11-02', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: null, dayIndex: 0,
  });
  /*
   * 2026-11-01 之后：景点是一段时间，一整天的地方会多一条「还在」的中段话。
   * 所以这里数的是**不同地点数**，不是节点数 —— 原意是「同一个地方不说两遍」。
   */
  const acts = day0.beats.filter((b) => b.kind === 'activity');
  assert.equal(new Set(acts.map((b) => b.spot)).size, 1, `一整天的地方排出了 ${new Set(acts.map((b) => b.spot)).size} 个地点`);
  assert.match(acts[0].what, /一整天都在黄山/, '没说清是一整天：' + acts[0].what);
  assert.ok(acts[0].until, '一整天的地方没有结束时刻，她会在山上待到不知道几点');

  // 第二天还在同一个地方，说法要换，不能连着两天说同一句
  const day1 = planDay({
    city: hs, dateKey: '2026-11-03', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: null, dayIndex: 1,
  });
  const acts1 = day1.beats.filter((b) => b.kind === 'activity');
  assert.equal(new Set(acts1.map((b) => b.spot)).size, 1, '第二天排出了不止一个地点');
  assert.match(acts1[0].what, /还在黄山/, '第二天没换说法：' + acts1[0].what);
});

test('天数标记：普通城市照旧一天两格', () => {
  // 不能因为加了这个机制，把没标天数的城市也合并了。
  const lz = cityById('lanzhou');
  const plan = planDay({
    city: lz, dateKey: '2026-11-02', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: null, dayIndex: 0,
  });
  const acts = plan.beats.filter((b) => b.kind === 'activity');
  assert.equal(new Set(acts.map((b) => b.spot)).size, 2, '普通城市该有两个不同地点');
  assert.notEqual(acts[0].what, acts[1].what, '两条活动不该是同一个地方');
});

test('天数标记：华山排得下两天，第三天还能去别处', () => {
  const hs = cityById('huashan');
  assert.ok(hs.slots.length >= 6, '华山展开后不足 6 格');
  for (const d of [0, 1]) {
    const plan = planDay({
      city: hs, dateKey: '2026-11-0' + (d + 2), shape: 'full',
      lodging: rollLodging(() => 0.2), weather: null, dayIndex: d,
    });
    const acts = plan.beats.filter((b) => b.kind === 'activity');
    assert.match(acts[0].what, /华山/, `第 ${d + 1} 天该在华山：` + acts[0].what);
  }
  const day3 = planDay({
    city: hs, dateKey: '2026-11-04', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: null, dayIndex: 2,
  });
  const acts3 = day3.beats.filter((b) => b.kind === 'activity').map((b) => b.what);
  assert.equal(acts3.some((x) => x.includes('华山')), false, '第三天还赖在华山');
});

// ---- 2026-11-01 加的：札幌 / 京都 / 里约，以及圣地巡礼 ----

test('新城：三座都进了表，交通属性对得上', () => {
  const sap = cityById('sapporo');
  const kyo = cityById('kyoto');
  const rio = cityById('rio');
  assert.ok(sap && kyo && rio, '三座新城有一座位没进表');
  assert.equal(sap.name, '札幌');
  assert.equal(kyo.name, '京都');
  assert.equal(rio.name, '里约热内卢');
  assert.equal(rio.country, 'BR', '里约的国家代码不对');
  /*
   * 这几条都是**事实**，不是配置偏好：
   * 巴西没有长途客运铁路、札幌市区不临海、京都没有机场（关西国际在大阪）。
   * 错了的后果是她「在巴西坐火车去里约」「从上海直飞京都」——
   * 一句就能让人出戏的那种错。
   */
  assert.equal(kyo.air, false, '京都没有机场');
  assert.equal(rio.rail, false, '里约居然能坐火车');
  assert.equal(sap.port, false, '札幌居然有客运码头');
  for (const c of [sap, kyo, rio]) {
    assert.ok(c.spots.length >= 5, `${c.name} 只有 ${c.spots.length} 条景点`);
    assert.ok(c.slots.length >= c.spots.length, `${c.name} 的半天槽没展开`);
    assert.ok(c.night, `${c.name} 没有夜里能去的地方`);
  }
});

test('新城：京都排得出三天，六格不重样', () => {
  const kyo = cityById('kyoto');
  const seen = [];
  for (let d = 0; d < 3; d++) {
    // 用 6 月：11 月会撞上红叶季，那会多一条 activity，跟这条测的东西无关
    const plan = planDay({
      city: kyo, dateKey: '2026-06-0' + (d + 2), shape: 'full',
      lodging: rollLodging(() => 0.2), weather: null, dayIndex: d,
    });
    // 数地点不数节点：每个景点现在还会多一条「还在那儿」的中段话
    const spots = [...new Set(plan.beats.filter((b) => b.kind === 'activity').map((b) => b.spot))];
    assert.equal(spots.length, 2, `第 ${d + 1} 天排了 ${spots.length} 个地点`);
    seen.push(...spots);
  }
  assert.equal(new Set(seen).size, 6, `三天里有重复：${seen.join(' / ')}`);
  assert.ok(seen.some((x) => x.includes('清水寺')), '三天都没排到清水寺');
});

test('巡礼：清单里每一处都真的在那座城的景点里', () => {
  /*
   * 这条守的是**静默失效**：景点名改一个字节，巡礼就再也不触发，
   * 而代码不报错、界面不提示 —— 只有到了现场发现她没提，才知道坏了。
   */
  for (const p of PILGRIMS) {
    const c = cityById(p.cityId);
    assert.ok(c, `巡礼挂在不存在的城市上：${p.cityId}`);
    assert.ok(c.spots.includes(p.spot),
      `${c.name} 的景点里没有「${p.spot}」—— 改景点名时忘了同步 pilgrim.ts`);
    assert.ok(p.works.length >= 1, `${p.spot} 一条作品都没有`);
    for (const w of p.works) {
      assert.ok(w.title.trim(), `${p.spot} 的作品没写名字`);
      assert.ok(w.scene.trim().length > 6, `${p.spot} 的场景描述太短，等于没说`);
    }
  }
});

test('巡礼：排到那处景点时，节点上挂着作品', () => {
  const kyo = cityById('kyoto');
  // 清水寺是第 0 格，第一天上午必然排到
  const plan = planDay({
    city: kyo, dateKey: '2026-06-02', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: null, dayIndex: 0,
  });
  const act = plan.beats.find((b) => b.kind === 'activity' && b.what.includes('清水寺'));
  assert.ok(act, '第一天上午没排到清水寺');
  assert.ok(act.pilgrim, '清水寺没挂上巡礼');
  assert.equal(act.pilgrim.spot, '清水寺');
  assert.ok(act.pilgrim.works.some((w) => w.title.includes('迷宫')), '作品挂错了');
});

test('巡礼：没有作品的地方不许凭空多出一条', () => {
  const tsu = cityById('tianshui');
  const plan = planDay({
    city: tsu, dateKey: '2026-06-02', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: null, dayIndex: 0,
  });
  assert.equal(plan.beats.some((b) => b.pilgrim), false, '天水凭空挂出了巡礼');
  assert.equal(pilgrimAt('tianshui', '麦积山石窟'), null);
  assert.equal(pilgrimsOf('tianshui').length, 0);
});

test('巡礼：一个地点可以挂多部，但每条都得说清是哪个场景', () => {
  const kyo = cityById('kyoto');
  const plan = planDay({
    city: kyo, dateKey: '2026-06-03', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: null, dayIndex: 1,
  });
  const act = plan.beats.find((b) => b.kind === 'activity' && b.pilgrim && b.pilgrim.works.length > 1);
  assert.ok(act, '鸭川那天该挂着两部作品的');
  const scenes = new Set(act.pilgrim.works.map((w) => w.scene));
  assert.equal(scenes.size, act.pilgrim.works.length, '两部作品用了同一句描述');
});

test('反馈邮箱：默认指向作者，清空则不显示', async () => {
  const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
  // 默认是作者本人 —— 装了就能报，不用先去设置里翻。清空则不显示那一栏。
  assert.equal(JOURNEY_DEFAULTS().feedbackEmail, '623263325@qq.com');
});


test('跨海：地面交通不出海，飞机和船留着', () => {
  /*
   * 2026-11-01 修的硬伤：pickMode 原来只按「距离上限 + 两端枢纽」筛，
   * 不看国界也不看海。实测 300 次上海 → 京都：192 次火车、85 次自驾、
   * 23 次长途汽车，一次飞机都没有 —— 她会开着车穿过东海。
   */
  const sh = cityById('shanghai');
  const kyo = cityById('kyoto');
  const tokyo = cityById('tokyo');
  const ground = new Set(['walk', 'bike', 'scooter', 'motorcycle', 'car', 'bus', 'train']);

  /*
   * 上海到京都**没有直达** —— 京都无机场，跨海又只能飞或坐船，两头都堵着。
   * 这不是缺陷，是她必须先落到东京或大阪的原因。真有直达才是错的。
   */
  assert.equal(pickMode(sh, kyo, distanceKm(sh, kyo)), null, '上海到京都居然有直达方式');
  for (let i = 0; i < 200; i++) {
    const m = pickMode(sh, tokyo, distanceKm(sh, tokyo));
    assert.equal(ground.has(m.id), false, `上海到东京选了${m.name}`);
  }
  // 反过来：陆路相连的地方地面交通必须还在，不能一刀切禁掉
  assert.equal(landLinked('CN', 'VN'), true, '中越接壤');
  assert.equal(landLinked('CN', 'JP'), false, '中日不接壤');
  assert.equal(landLinked('GB', 'FR'), true, '英法海底隧道');
  const parisC = cityById('paris');
  const londonC = cityById('london');
  let train = 0;
  for (let i = 0; i < 300; i++) {
    if (pickMode(londonC, parisC, distanceKm(londonC, parisC))?.id === 'train') train++;
  }
  assert.ok(train > 0, '伦敦到巴黎连火车都没了，英法隧道被一起禁掉了');
});

test('气候：三座新城的档不能是兜底的温带', () => {
  /*
   * 巴西不在 COUNTRY_CLIMATE 表里，里约一路兜底成「温带」；
   * 札幌带「雪」这个 tag 但没有对应规则，被判成「湿温」。
   * 两处都会让到达时第一句体感说错。
   */
  assert.equal(climateOf(cityById('rio')), 'humid-hot', '里约该是湿热');
  assert.equal(climateOf(cityById('sapporo')), 'cold', '札幌该是冷');
  assert.equal(climateOf(cityById('kyoto')), 'humid-mild', '京都湿温，别跟着改坏');
  // 加「雪」规则不能把别的城市带偏
  assert.equal(climateOf(cityById('changchun')), 'cold');
  assert.equal(climateOf(cityById('moscow')), 'cold');
});


test('中转：没有机场的城市，得先落到能飞的地方再过去', () => {
  /*
   * 2026-11-01 Mr.Q 问「落地东京然后开车坐JR去大阪过京都，是否可行」——
   * 可行，而且本来就该这么走。这条守的是**她真的会这么走**：
   *
   *   1. 从上海选目的地，选不到京都（到不了的地方不进候选）；
   *   2. 从东京选，选得到（JR 三百六十公里）；
   *   3. 在京都想回兰州，第一站是东京（新干线过去，再从成田走），不是札幌。
   *
   * 第三条是最容易错的一步：日本境内没有哪座城比京都离兰州更近，
   * 原来那套「一路逼近」的收敛会整个落空，然后退回随机。
   */
  const sh = cityById('shanghai');
  const kyo = cityById('kyoto');
  const tokyo = cityById('tokyo');
  const lz = cityById('lanzhou');

  assert.equal(canTravel(sh, kyo), false, '上海居然能直达京都');
  assert.equal(canTravel(tokyo, kyo), true, '东京坐 JR 到不了京都？');
  assert.equal(canTravel(kyo, lz), false, '京都能直接飞兰州？');

  // 从上海选八百次，一次都不该选中京都
  let pickedKyoto = 0;
  for (let i = 0; i < 800; i++) {
    if (pickDestination({ from: sh, home: lz })?.city.id === 'kyoto') pickedKyoto++;
  }
  assert.equal(pickedKyoto, 0, `从上海选中了 ${pickedKyoto} 次京都 —— 到不了的地方进了候选`);

  // 从东京选，选得到
  let fromTokyo = 0;
  for (let i = 0; i < 800; i++) {
    if (pickDestination({ from: tokyo, home: lz })?.city.id === 'kyoto') fromTokyo++;
  }
  assert.ok(fromTokyo > 20, `从东京八百年都没选中京都（${fromTokyo} 次），JR 白修了`);

  // 在京都往回走：第一站必须是能飞的（东京），不能是札幌
  const back = new Map();
  for (let i = 0; i < 300; i++) {
    const r = pickDestination({ from: kyo, toward: lz, home: lz });
    back.set(r?.city.id ?? 'null', (back.get(r?.city.id ?? 'null') ?? 0) + 1);
  }
  assert.equal(back.get('tokyo'), 300, `京都回兰州的第一站该全是东京，实际：${[...back.entries()].map(([k, v]) => k + ':' + v).join(' ')}`);
});

test('可达性：每座城都至少有一条进得去、出得来的路', () => {
  /*
   * 加了「到不了的地方不进候选」之后，最怕的是**某座城变成孤岛** ——
   * 从哪儿都选不中它，或者进去了出不来，而代码一声不响。
   */
  const lz = cityById('lanzhou');
  for (const c of CITIES) {
    const inFrom = CITIES.filter((x) => x.id !== c.id && canTravel(x, c));
    assert.ok(inFrom.length > 0, `${c.name} 从任何地方都到不了`);
    const outTo = CITIES.filter((x) => x.id !== c.id && canTravel(c, x));
    assert.ok(outTo.length > 0, `${c.name} 进去了出不来`);
    /*
     * 家在兰州，所以也得能回家 —— **允许经一跳**。
     * 京都就属于这种：它自己飞不了，但新干线到东京就能飞。
     * 判「能不能回家」时要求直达，等于要求每座城都有机场。
     */
    const direct = c.id === 'lanzhou' || canTravel(c, lz);
    const viaHub = !direct && CITIES.some((x) => x.id !== c.id && canTravel(c, x) && canTravel(x, lz));
    assert.ok(direct || viaHub, `${c.name} 回不了家`);
  }
});

test('事件声明：describe.json 和运行时的表必须一致', () => {
  /*
   * 2026-11-01 的真实故障：`journey.photo` 和 `journey.mishap` 在 describe.json 里有，
   * 在运行时的 JOURNEY_DESCRIBE.events 里没有 —— 每次拍照宿主都警告
   * 「事件 type 不在 describe.events 里，照常推送」。
   *
   * 「照常推送」听起来无害，问题在于它说明**这张表不是唯一来源**：
   * 手改 describe.json 那一刻起，两边就开始各走各的。
   */
  const onDisk = JSON.parse(readFileSync(new URL('../describe.json', import.meta.url), 'utf8'));
  const declared = onDisk.events.map((e) => e.type).sort();
  const runtime = JOURNEY_DESCRIBE.events.map((e) => e.type).sort();
  assert.deepEqual(runtime, declared, '运行时的事件表和 describe.json 对不上 —— 改一边忘了另一边');

  for (const e of JOURNEY_DESCRIBE.events) {
    const mirror = onDisk.events.find((x) => x.type === e.type);
    assert.equal(e.trigger, mirror.trigger, `${e.type} 的 trigger 两边不一致`);
    assert.ok(e.description.zh.trim() && e.description.en.trim(), `${e.type} 少了说明`);
  }
});

test('拍照：她人在哪一处，相册里就该是哪一处', () => {
  /*
   * 用户的原话：「她去的伏羲庙啊」。
   * 手动补拍那条路传的是空 spot，于是照片叫「下午的天水」，提示词里也没有具体地点。
   * 这里守的是 spotFromBeat 能从天水那天的活动节点里取出真实地名。
   */
  const kyo = cityById('kyoto');
  const plan = planDay({
    city: kyo, dateKey: '2026-06-02', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: null, dayIndex: 0,
  });
  const acts = plan.beats.filter((b) => b.kind === 'activity');
  assert.ok(acts.length >= 1, '没排出活动节点');
  /*
   * 地名由排程直接带在 beat 上，不再从文字里反解 ——
   * `清水寺` 这种没有逗号的写法，反解出来是空串，照片就会被拍成「下午的京都」。
   */
  for (const b of acts) {
    assert.ok(b.spot && kyo.spots.includes(b.spot), `「${b.what}」没带上地名（spot=${b.spot}）`);
  }
  // 反解兜底那条也留着：老状态里没有 spot 字段时还得能取出来
  assert.equal(spotFromBeat('下午，伏羲庙'), '伏羲庙');
});

test('景点是一段时间：14:30 进伏羲庙，不是一秒钟就逛完', () => {
  /*
   * 2026-11-01 Mr.Q 的原话：「14:30 逛伏羲庙是个时间段，不是 14:30 到了 1 秒钟就参观完了。」
   *
   * 原来 activity 只是时间轴上的一个点，于是 14:30 到 18:30 四小时里一条节拍都没有，
   * 她 15:30 被问「你在干嘛」只能答「等晚饭」。
   */
  const c = cityById('tianshui');
  const plan = planDay({
    city: c, dateKey: '2026-11-01', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: null, dayIndex: 0,
  });
  const acts = plan.beats.filter((b) => b.kind === 'activity');
  const main = acts.find((b) => b.spot === '伏羲庙' && b.until !== undefined);
  assert.ok(main, '伏羲庙那条没有结束时刻');
  assert.ok((main.until ?? 0) - main.at >= 1.5, `只给了 ${((main.until ?? 0) - main.at).toFixed(2)} 小时`);

  // 中间得有一句「还在」，而且落在这段区间里
  const mid = acts.find((b) => b.spot === '伏羲庙' && b.at > main.at && b.at < (main.until ?? 0));
  assert.ok(mid, '下午那四个小时里没有一句话');
  assert.ok(mid.at >= main.at + 0.5, '中段话贴得太近，像刚进门就又说一遍');

  // 中段和开头不能是同一句
  assert.notEqual(mid.what, main.what, '中段和开头说了同一句话');

  // 中段不能和已有的节点撞（午饭、晚饭各占一点）
  for (const b of plan.beats) {
    if (b === mid) continue;
    assert.ok(Math.abs(b.at - mid.at) >= 0.5, `中段那句和 ${b.kind} 撞在 ${b.at} 上`);
  }
});

test('景点是时间段：一整天的地方要撑到下午，不能中午就结束', () => {
  const hs = cityById('huangshan');
  const plan = planDay({
    city: hs, dateKey: '2026-11-02', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: null, dayIndex: 0,
  });
  const main = plan.beats.find((b) => b.kind === 'activity' && b.until !== undefined);
  assert.ok(main, '没有带结束时刻的活动');
  assert.ok((main.until ?? 0) >= 17, `一整天的地方只到 ${main.until} 点`);
  // 中段不能在午饭之前就跑完了
  const mid = plan.beats.filter((b) => b.kind === 'activity' && b.until === undefined)[0];
  assert.ok(mid && mid.at > 12.5, '中段那句压在午饭前，像是上午就散了');
});

// ---- 2026-11-14：动作段只讲用法，不再读宿主目录 ----

test('动作段：不列词表，指向她手上那份', () => {
  /*
   * 2026-11-14 按市集作者要求撤掉了「现读 figure.json」那段（读宿主安装目录 = 越界）。
   * 词表由桌宠 World 的 {{pet.vocab}} 提供，这一段只管「怎么用」。
   * 所以这里钉住两件事：**不许再出现具体动作清单**，且**必须指向她手上那份**。
   */
  const text = actionsPrompt();
  assert.match(text, /【平静, 坐下】/, '没给可直接照抄的格式示例');
  assert.match(text, /词表/, '没提「以你手上的词表为准」');
  assert.equal(text.includes('{{pet.vocab}}') || text.includes('当前形象的词表'), true, '没指向宿主给的词表');
  assert.equal(text.includes('也可以写'), true, '没说「词表外的也能写，会被记下来」');
  // 老版本会把整份词表铺进来；现在不该再有那种成串的清单
  assert.equal(/其余可用的/.test(text), false, '还在列「其余可用的」词表');
});

test('动作段：不再读文件（这条是防回归的）', () => {
  /*
   * 光删函数不够 —— 哪天有人为了「让动作更准」又把 readFileSync 加回来，
   * 行为上完全看不出区别，直到宿主换目录布局。直接在源码上钉。
   */
  const src = readFileSync(new URL('../src/pet-vocab.ts', import.meta.url), 'utf8');
  assert.equal(/from 'node:fs'/.test(src), false, 'pet-vocab.ts 又引入了 node:fs');
  assert.equal(/readFileSync|existsSync/.test(src), false, 'pet-vocab.ts 又去读文件了');
  // 不钉 `figure.json` 这个词 —— 注释里要解释「为什么撤掉」，提到它是应该的。
  // 真正会伤人手脚的是这两样：引入 fs、调读文件。上面两条已经够了。
});

test('提示词天花板：静态正文 + 注入的动作段都要算进去', () => {
  /*
   * 动作段现在是 `{{journey.actions}}`，静态文件里只有 20 个字符。
   * 只量静态文件会得出「才 4400 多字，很宽裕」这种错觉 —— 实际渲染出来是 4805。
   * 所以这里按「静态正文 + 注入预算」一起算。
   */
  const tpl = readFileSync(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8');
  // 实测（2026-11-01，whale）：注入 392 字、动态 660 字。各留一点余量，别卡死。
  const injectedBudget = 420;
  /*
   * 动态部分不是常数：今晚住哪那句话能差出两三百字（快捷连锁 vs 高档商务酒店），
   * 在路上的时候还有进度条那几句。实测一次 660 字，按 800 留余量。
   */
  const dynamicBudget = 720;
  const total = tpl.length - 20 + injectedBudget + dynamicBudget;
  /*
   * 上限 **7200**（2026-11-06 从 5600 上调）。
   *
   * 为什么该上调 —— 当日在本机 `/api/prompts/prefix` 拉了一次实测（0.8.6）：
   *
   *   ORIENTATION 848 · CONSTITUTION 833 · PARTNER 401 · console 1118
   *   desktop-pet 5781 · hearthstone 15080 · **journey 5179** · music 12931
   *   MEMORY 735 · WORKSPACE 473        合计 43379
   *
   * 三个世界段早就 12000–15000 了，journey 是最短的那个。5600 是 2026-11-01
   * 只有它一个世界时按「实测 5112」定的自我约束，**不是系统限制**——
   * 当时写的理由是「拦的是继续涨」，现在拦的是一个本来就偏矮的天花板。
   *
   * 7200 之后 journey 仍是四个世界里最短的（约 music 的 56%、hearthstone 的 48%），
   * 校验的不是「够不够长」，是「还会不会失控地涨」。
   *
   * 上一次踩这里：2026-11-06 加「同行」一节直接把 4480 顶到 5378，
   * 撞上 5600 才发现天花板需要重定 —— 定完再写内容，顺序反了。
   */
  /*
   * 2026-11-08 上调 7200 → 10000（Mr.Q：「提示词上限可以放宽到 10000」）。
   *
   * 这次不是「写不下新功能」，是**天花板在改句子**：改「一起旅行」的写法时，
   * 为了不超 7200 把「路上」「才显得是两个人」这种带信息量的词压掉了。
   * 一个数字开始决定文案怎么断句，说明这个数字定得太死。
   *
   * 抬到 10000 之后仍低于桌面宠物段（5781）和炉石（15080）之和的一半 ——
   * 它守的从来不是「够不够用」，是「会不会失控地涨」。
   */
  const ceiling = 10000;
  assert.ok(total <= ceiling, `模板 ${tpl.length} + 注入 ${injectedBudget} + 动态 ${dynamicBudget} = ${total}，超了 ${ceiling}`);
  assert.match(tpl, /\{\{journey\.actions\}\}/, '动作段不再是占位符了？那这份词表又变回手抄了');
});

/* ============================================================
 * 日记：一个月一个文件（2026-11-02 由 Mr.Q 改）
 *
 * 原来一天一篇，同步盘里一年能攒三百多个文件，翻起来全靠找日期。
 * 改成月文件之后要守住三件事，这三件是"改了格式"最容易悄悄坏掉的：
 *   ① 同一个月写两天 → 只多一个文件，内容都在；
 *   ② 旧的一天一篇照样读得出来，迁移完挪进 `_bak/legacy/` 而不是删掉；
 *   ③ 两台机器的冲突副本（`2026-11-电脑名.md`）里的天不能看不见。
 * ============================================================ */

import { DiaryStore, parseDiaryFile } from '../src/diary.ts';
import {
  TravelMemoryStore, mergeMemory, metPet, mergePets, setPetImpression,
  setTaste, mergeTaste, normalizeTaste, tasteSummary, emptyTaste,
} from '../src/travel-memory.ts';

const entryOf = (dateKey, city, body, extra = {}) => ({
  dateKey,
  cityId: city,
  cityName: city,
  body,
  ...extra,
});

test('日记：一个月只开一个文件，两天都在里面，新的在顶上', async () => {
  const { mkdtempSync, readdirSync, readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'diary-'));
  const store = new DiaryStore(dir);
  store.configure('');

  store.write(entryOf('2026-11-01', '东京', '第一天，下小雨。'));
  store.write(entryOf('2026-11-02', '大阪', '第二天，新干线。'));

  const files = readdirSync(join(dir, 'diary')).filter((n) => n.endsWith('.md'));
  assert.deepEqual(files, ['2026-11.md'], '两天必须落在同一个文件里');

  const text = readFileSync(join(dir, 'diary', '2026-11.md'), 'utf8');
  assert.match(text, /^# 2026 年 11 月 · 旅行日记/, '月文件要有个能一眼看懂的标题');
  assert.ok(text.indexOf('date: 2026-11-02') < text.indexOf('date: 2026-11-01'), '新的在上面');

  assert.equal(store.count(), 2);
  assert.equal(store.read('2026-11-01').body, '第一天，下小雨。');
  assert.deepEqual(store.recent(2).map((e) => e.dateKey), ['2026-11-01', '2026-11-02'], 'recent 仍旧旧的在前');
});

test('日记：同一天改写会覆盖，但旧内容先留一份进 _bak', async () => {
  const { mkdtempSync, readdirSync, readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'diary-bak-'));
  const store = new DiaryStore(dir);
  store.configure('');

  store.write(entryOf('2026-11-05', '京都', '原来的版本。'));
  store.write(entryOf('2026-11-05', '京都', '改口之后的版本。'));

  assert.equal(store.read('2026-11-05').body, '改口之后的版本。');
  const baks = readdirSync(join(dir, 'diary', '_bak')).filter((n) => n.startsWith('2026-11-05-'));
  assert.equal(baks.length, 1, '旧版本要留一份，世界时间回退时它可能是另一座城市的记录');
  assert.match(readFileSync(join(dir, 'diary', '_bak', baks[0]), 'utf8'), /原来的版本/);
});

test('日记：旧的一天一篇能读，迁移后并进月文件、旧文件进 _bak/legacy', async () => {
  const { mkdtempSync, readdirSync, writeFileSync, existsSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'diary-legacy-'));
  const legacy = join(dir, 'diary');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, '2026-10-31.md'), [
    '---',
    'date: 2026-10-31',
    'city: 京都',
    'cityId: kyoto',
    '---',
    '',
    '老格式写的那一天。',
    '',
  ].join('\n'), 'utf8');

  const store = new DiaryStore(dir);
  store.configure('');

  assert.equal(store.count(), 1, '迁移前也得读得出来');
  assert.equal(store.read('2026-10-31').body, '老格式写的那一天。');
  assert.ok(existsSync(join(legacy, '2026-10.md')), '要并进 2026-10.md');
  assert.ok(existsSync(join(legacy, '_bak', 'legacy', '2026-10-31.md')), '旧文件挪走，不删');
  assert.ok(!existsSync(join(legacy, '2026-10-31.md')), '原来那个位置不再留着');
  assert.equal(store.read('2026-10-31').body, '老格式写的那一天。', '迁移之后还读得回来');
});

test('日记：同步盘的冲突副本里那几天也要能读到', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'diary-conflict-'));
  const store = new DiaryStore(dir);
  store.configure('');
  store.write(entryOf('2026-11-01', '东京', '这台机器写的。'));

  // 另一台机器写出的冲突副本：OneDrive 会给它加后缀
  const copy = join(dir, 'diary', '2026-11-笔记本.md');
  writeFileSync(copy, [
    '# 2026 年 11 月 · 旅行日记',
    '',
    '---',
    'date: 2026-11-01',
    'city: 京都',
    'cityId: kyoto',
    '---',
    '',
    '那台机器写的。',
    '',
    '---',
    'date: 2026-11-03',
    'city: 奈良',
    'cityId: nara',
    '---',
    '',
    '只在副本里出现过的一天。',
    '',
  ].join('\n'), 'utf8');

  const all = store.recent(10).map((e) => e.dateKey);
  assert.deepEqual(all, ['2026-11-01', '2026-11-03'], '副本里独有的那天不能消失');
  assert.equal(store.read('2026-11-03').cityName, '奈良');
});

test('日记：正文里出现分隔线，不许被当成下一天的元信息', () => {
  const text = [
    '# 2026 年 11 月 · 旅行日记',
    '',
    '---',
    'date: 2026-11-01',
    'city: 京都',
    'cityId: kyoto',
    '---',
    '',
    '上半段。',
    '',
    '---',
    '',
    '下半段。',
    '',
    '---',
    'date: 2026-10-31',
    'city: 大阪',
    'cityId: osaka',
    '---',
    '',
    '前一天。',
    '',
  ].join('\n');
  const days = parseDiaryFile(text);
  assert.equal(days.length, 2);
  assert.match(days[0].body, /上半段/);
  assert.match(days[0].body, /下半段/, '分隔线要留在正文里，不能被当成分段点吃掉后半段');
  assert.equal(days[1].dateKey, '2026-10-31');
});

test('时区标签：UTC+9 / UTC-3 / 半小时的 +5:30，都按 Intl 算，不写死', () => {
  // 2026-11-02 面板上「比你快 1 天 21 小时」换成时区，靠的就是这个。
  const at = new Date('2026-11-02T04:00:00Z');
  assert.equal(tzOffsetLabel('Asia/Tokyo', at), 'UTC+9');
  assert.equal(tzOffsetLabel('Asia/Shanghai', at), 'UTC+8');
  assert.equal(tzOffsetLabel('America/Sao_Paulo', at), 'UTC-3');
  assert.equal(tzOffsetLabel('Asia/Kolkata', at), 'UTC+5:30', '半小时时区不能吞掉那 30 分钟');
  // 夏令时：同一个时区冬天和夏天不是一个偏移，写死加一小时的那种必须错
  assert.equal(tzOffsetLabel('Europe/London', new Date('2026-01-15T12:00:00Z')), 'UTC+0');
  assert.equal(tzOffsetLabel('Europe/London', new Date('2026-07-15T12:00:00Z')), 'UTC+1');
});

/* ============================================================
 * 旅行记忆：去过哪、还想去哪、花了多少 —— 跟着人走
 *
 * state.json 里的位置永远只在本机（两台共写就是幻觉），
 * 但「攒下来的东西」换台机器归零，那不叫换设备，叫失忆。
 * ============================================================ */

test('旅行记忆：两份合起来取并集，花销取大的那个', () => {
  const mk = (everVisited, wishes, spent) => ({ version: 1, everVisited, wishes, spent, updatedAt: '' });
  const merged = mergeMemory(
    mk(['lanzhou', 'xian'], ['kyoto'], 800),
    mk(['xian', 'tianshui'], ['kyoto', 'lijiang'], 1200),
  );
  assert.deepEqual(merged.everVisited, ['lanzhou', 'xian', 'tianshui'], '去过的地方不能因为换机器就没了');
  assert.deepEqual(merged.wishes, ['kyoto', 'lijiang'], '想去的地方宁可多一条也不能丢');
  assert.equal(merged.spent, 1200, '累计花销只会变大，小的那份是旧机器上的截断');
  assert.equal(merged.earned, 0, '打工收入也要跟着走，不然换机器净值会算错');
});

test('旅行记忆：同步盘写一份，本机也留一份，谁都能读回来', async () => {
  const { mkdtempSync } = await import('node:fs');
  const data = mkdtempSync(join(tmpdir(), 'jrm-data-'));
  const sync = mkdtempSync(join(tmpdir(), 'jrm-sync-'));

  const store = new TravelMemoryStore(data);
  store.configure(sync);
  assert.equal(store.save({ everVisited: ['lanzhou'], wishes: ['osaka'], spent: 320 }), null);

  // 换一台机器：新的 store，只看得见同步盘
  const other = new TravelMemoryStore(mkdtempSync(join(tmpdir(), 'jrm-data2-')));
  other.configure(sync);
  const back = other.read();
  assert.deepEqual(back.everVisited, ['lanzhou']);
  assert.deepEqual(back.wishes, ['osaka']);
  assert.equal(back.spent, 320);
});

test('旅行记忆：并进状态时只动那三项，位置和路线一个字不碰', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const data = mkdtempSync(join(tmpdir(), 'jrm-merge-'));
  const sync = join(data, 'sync');
  mkdirSync(sync, { recursive: true });
  writeFileSync(join(sync, 'travel-memory.json'), JSON.stringify({
    version: 1,
    everVisited: ['tokyo', 'kyoto'],
    wishes: ['sapporo'],
    spent: 500,
    updatedAt: '2026-11-01T00:00:00Z',
  }), 'utf8');

  const store = new TravelMemoryStore(data);
  store.configure(sync);
  const state = {
    hereId: 'tianshui', phase: 'staying', leg: null, heading: 1.2,
    everVisited: ['lanzhou'], wishes: [], spent: 0,
  };
  const { state: out, grew } = store.merge(state);
  assert.equal(grew, true);
  assert.deepEqual(out.everVisited, ['lanzhou', 'tokyo', 'kyoto']);
  assert.deepEqual(out.wishes, ['sapporo']);
  assert.equal(out.spent, 500);
  assert.equal(out.hereId, 'tianshui', '她现在在哪绝不能被另一台机器覆盖');
  assert.equal(out.heading, 1.2, '行进方向属于这一趟，不能跟着记忆走');
});

test('旅行记忆：本机旧副本不许把已经划掉的「想去」加回来', async () => {
  /*
   * 2026-11-02 自查抓到的真 bug。
   *
   * 第一版 read() 是「同步盘 + 本机副本取并集」，看起来更保险，实际让**删除永远无效**：
   * A 机器上她把京都从「想去」里划掉、两边都写干净了；换 B 机器启动，
   * B 的旧副本里还有京都，一并又回来了 —— 用户看到的是「这个地方怎么删不掉」。
   *
   * 判据：save() 每次都同时写两边，本机的永远不会比同步盘新，合并只会把删掉的加回来。
   */
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const dataB = mkdtempSync(join(tmpdir(), 'jrm-b-'));
  const sync = mkdtempSync(join(tmpdir(), 'jrm-sync2-'));

  // A 机器划掉京都之后，同步盘上是干净的
  writeFileSync(join(sync, 'travel-memory.json'), JSON.stringify({
    version: 1, everVisited: ['tianshui'], wishes: ['chengdu'], spent: 0,
    updatedAt: '2026-11-02T12:00:00Z',
  }), 'utf8');
  // B 机器的本机副本还停在划掉之前
  mkdirSync(dataB, { recursive: true });
  writeFileSync(join(dataB, 'travel-memory.json'), JSON.stringify({
    version: 1, everVisited: ['tianshui'], wishes: ['kyoto', 'chengdu'], spent: 0,
    updatedAt: '2026-11-01T12:00:00Z',
  }), 'utf8');

  const store = new TravelMemoryStore(dataB);
  store.configure(sync);
  assert.deepEqual(store.read().wishes, ['chengdu'], '划掉的京都又回来了 —— 删除无效');
});

test('旅行记忆：同步盘读不到时才回落本机那份', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const data = mkdtempSync(join(tmpdir(), 'jrm-fallback-'));
  const sync = join(data, 'offline-sync');   // 有配、但盘没连上
  writeFileSync(join(data, 'travel-memory.json'), JSON.stringify({
    version: 1, everVisited: ['lanzhou'], wishes: [], spent: 80,
    updatedAt: '2026-11-01T00:00:00Z',
  }), 'utf8');

  const store = new TravelMemoryStore(data);
  store.configure(sync);
  assert.deepEqual(store.read().everVisited, ['lanzhou'], '同步盘不在就把本机那份当不存在了');
});

test('日记：这个月的文件读不出来时，宁可这次不写，也不许拿今天一条盖掉整月', async () => {
  /*
   * 2026-11-02 自查抓到的洞（比"格式变了"严重得多）。
   *
   * 原来 readMonthFile 的 catch 直接返回空 Map，调用方分不清
   * 「这个月还没写」和「这个月读不出来」—— 后者会被当成空文件整份重写，
   * 结果是**整月日记被今天的几百字覆盖**。日记在同步盘上是唯一副本。
   *
   * 这里用「同名目录冒充文件」制造 EISDIR，是最可靠的读失败姿势。
   */
  const { mkdtempSync, mkdirSync, readdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'diary-eisdir-'));
  mkdirSync(join(dir, 'diary', '2026-11.md'), { recursive: true });

  const store = new DiaryStore(dir);
  store.configure('');
  const r = store.write(entryOf('2026-11-05', '京都', '今天写不进去。'));

  assert.ok(r.problem, '读不出来还报成功 —— 那就是静默丢数据');
  // 原来那个"文件"必须原样还在，不能被写穿
  assert.ok(readdirSync(join(dir, 'diary')).includes('2026-11.md'));
});

test('日记：月文件有内容却一条都解析不出来，覆盖前先整份留底', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'diary-garbled-'));
  mkdirSync(join(dir, 'diary'), { recursive: true });
  const junk = '这是我手写的一段话，没有 --- 元信息，解析不出来的那种。\n';
  writeFileSync(join(dir, 'diary', '2026-11.md'), junk, 'utf8');

  const store = new DiaryStore(dir);
  store.configure('');
  const r = store.write(entryOf('2026-11-05', '京都', '今天照常写。'));
  assert.equal(r.problem, null);

  const baks = readdirSync(join(dir, 'diary', '_bak')).filter((n) => n.startsWith('2026-11-unreadable-'));
  assert.equal(baks.length, 1, '覆盖之前没留底 —— 那段手写的话就没了');
  assert.match(readFileSync(join(dir, 'diary', '_bak', baks[0]), 'utf8'), /手写的一段话/);

  // 新的一天要正常写进去
  assert.equal(store.read('2026-11-05').body, '今天照常写。');
});

test('旅行记忆：目标文件坏掉时先改名留底，别直接覆盖', async () => {
  /*
   * 一份坏掉的 JSON 如果被这台机器的状态直接盖掉，丢的正好是**另一台机器攒的那部分**，
   * 而且事后无从查起 —— 同步盘上只剩一份好的，看着一切正常。
   */
  const { mkdtempSync, writeFileSync, readdirSync } = await import('node:fs');
  const data = mkdtempSync(join(tmpdir(), 'jrm-bad-'));
  const sync = mkdtempSync(join(tmpdir(), 'jrm-bad-sync-'));
  writeFileSync(join(sync, 'travel-memory.json'), '{ 这不是 JSON', 'utf8');

  const store = new TravelMemoryStore(data);
  store.configure(sync);
  const bad = store.save({ everVisited: ['xian'], wishes: [], spent: 0 });
  assert.equal(bad, null, '写回失败应该报出来');

  const kept = readdirSync(sync).filter((n) => n.endsWith('.bad.json'));
  assert.equal(kept.length, 1, '坏掉的那份没留底，直接被覆盖了');
});

test('日记：一次迁一堆旧文件（换机器拷回来的那种），不漏天也不重复', async () => {
  /*
   * 真实场景：另一台机器还是旧版，把整个日记目录拷过来就是几百个日文件。
   * 要保证三件事：每个月合成一个文件、一天不少、连跑两遍不会把同一天塞进去两次。
   */
  const { mkdtempSync, mkdirSync, writeFileSync, readdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'diary-bulk-'));
  const leg = join(dir, 'diary');
  mkdirSync(leg, { recursive: true });

  const day = (d) => `${d}\n`;
  const files = [];
  for (let m = 8; m <= 9; m += 1) {
    for (let d = 1; d <= 30; d += 1) {
      const key = `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const body = `那天在城 ${d} 号的地方走了走。`;
      writeFileSync(join(leg, `${key}.md`), `---\ndate: ${key}\ncity: 天水\ncityId: tianshui\n---\n\n${body}\n`, 'utf8');
    }
  }

  const store = new DiaryStore(dir);
  store.configure('');
  assert.equal(store.count(), 60, '迁完应该正好 60 天');

  const months = readdirSync(leg).filter((n) => /^2026-\d{2}\.md$/.test(n)).sort();
  assert.deepEqual(months, ['2026-08.md', '2026-09.md'], '两个月的文件应该各一个');

  // 再 configure 一遍：迁移是幂等的，不能把同一天又塞一次
  store.configure('');
  assert.equal(store.count(), 60, '重复迁移把天数弄多了');
  assert.equal(readdirSync(leg).filter((n) => /^2026-\d{2}-\d{2}\.md$/.test(n)).length, 0, '旧日文件还留在原地');
});

test('旅行记忆：网盘冲突副本里那份也要读得到，取最新的', async () => {
  /*
   * 和日记里踩过的是同一个坑：只认固定文件名，冲突副本里独有的
   * 「去过」「想去」就永远读不到，还不报错。
   * 区别是日记按天合并、记忆取 mtime 最新那份（并集会让划掉的地方复活）。
   */
  const { mkdtempSync, writeFileSync, utimesSync } = await import('node:fs');
  const data = mkdtempSync(join(tmpdir(), 'jrm-conflict-'));
  const sync = mkdtempSync(join(tmpdir(), 'jrm-conflict-sync-'));

  const main = join(sync, 'travel-memory.json');
  writeFileSync(main, JSON.stringify({
    version: 1, everVisited: ['tianshui'], wishes: [], spent: 0, updatedAt: '2026-11-01T00:00:00Z',
  }), 'utf8');
  const copy = join(sync, 'travel-memory-笔记本.json');
  writeFileSync(copy, JSON.stringify({
    version: 1, everVisited: ['tianshui', 'xian'], wishes: ['sapporo'], spent: 300, updatedAt: '2026-11-02T00:00:00Z',
  }), 'utf8');
  // 让副本明确更新
  const newer = new Date(Date.now() + 60_000);
  utimesSync(copy, newer, newer);
  const older = new Date(Date.now() - 60_000);
  utimesSync(main, older, older);

  const store = new TravelMemoryStore(data);
  store.configure(sync);
  const got = store.read();
  assert.deepEqual(got.wishes, ['sapporo'], '冲突副本里那台机器的记忆没读到');
  assert.equal(got.spent, 300);
});

test('景点：第 1 天和第 2 天给的不是同一个地方', () => {
  // 直接量 spotText 的推进，免得只有 dayIndex 对了、下游又没接上。
  const bad = [];
  for (const c of CITIES) {
    // 名额太少、或者有「（2 天）」那种重复占格的城市跳过 —— 那是设计，不是重复。
    if (c.slots.length < 3 || new Set(c.slots).size !== c.slots.length) continue;
    const d0 = [spotText(c, 0, 0), spotText(c, 1, 0)];
    const d1 = [spotText(c, 0, 1), spotText(c, 1, 1)];
    if (d0[0] === d1[0]) bad.push(`${c.id}: 上午都是「${d0[0]}」`);
  }
  assert.deepEqual(bad, [], `连着两天上午排同一个地方：${bad.slice(0, 6).join('、')}`);
});

test('日记：按月取，旧的在前，跨月的不会串', async () => {
  /*
   * 2026-11-02 用模拟跑 144 天时发现的：`journey_diary_read` 只有「最近 N 天」，
   * 上限 60 —— 她攒到 141 天之后，最早那天和跨年那天都读不回来（文件里明明有）。
   * `month()` 就是补这个口子：先列目录，再按天取全文。
   */
  const { mkdtempSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'diary-month-'));
  const store = new DiaryStore(dir);
  store.configure('');

  store.write(entryOf('2026-11-01', '京都', '第一天。'));
  store.write(entryOf('2026-11-15', '大阪', '月中。'));
  store.write(entryOf('2026-12-02', '东京', '下个月了。'));

  const nov = store.month('2026-11');
  assert.deepEqual(nov.map((e) => e.dateKey), ['2026-11-01', '2026-11-15'], '按月取要旧在前，且不能混进 12 月');
  assert.deepEqual(store.month('2026-12').map((e) => e.dateKey), ['2026-12-02']);
  assert.deepEqual(store.month('2025-01'), [], '没有的月份给空数组，不是报错');
  assert.deepEqual(store.month('2026-1'), [], '月份格式不对就不认，别去猜');
});

/* ============================================================
 * 钱袋子：预算从「软约束」变成「四档硬约束」（2026-11-02）
 *
 * 起因：模拟跑 144 个世界天，预算 3000 花掉 16.9 万。
 * 旧逻辑里预算只影响「住哪家、坐什么」，不影响总量 —— 钱见底了照样坐跨洲航班。
 * ============================================================ */

test('不走远：钱只够走近处时，候选里不该出现远处的城市', () => {
  const from = cityById('lanzhou');
  const near = pickDestination({ from, maxKm: 600, rnd: () => 0.5 });
  assert.ok(near, '六百公里内一个候选都没有？那这条约束等于把人困住');
  assert.ok(near.km <= 600, `候选超了：${near.city.name} ${Math.round(near.km)} 公里`);

  // 不给上限的时候应该有更远的选择空间（不然这条测不出东西）
  const any = pickDestination({ from, rnd: () => 0.5 });
  assert.ok(any && any.km >= 0);
});

test('不坐飞机：禁了之后只剩机票的航线直接给 null，不许退回去', () => {
  const lz = cityById('lanzhou');
  const tk = cityById('tokyo');
  const km = distanceKm(lz, tk);
  // 兰州到东京：陆路和海运都不通，只有飞机
  const allowed = pickMode(lz, tk, km, () => 0.5, false, true);
  assert.equal(allowed, null, '禁飞机之后还给出了一种方式 —— 那说明过滤没生效');
  const normal = pickMode(lz, tk, km, () => 0.5, false, false);
  assert.ok(normal, '不禁的时候连一种方式都给不出来，这条航线本身有问题');
});

/* ============================================================
 * 全国性节日（2026-11-02 Mr.Q 指出：春节这类国内节日没算进去）
 *
 * 之前只有「地方节庆」（泼水节、雪顿节），是按城市按月份粗判的。
 * 春节、中秋这些是全国同一天，而且日期确定 —— 用 ICU 的 chinese 历法算，不写死。
 * ============================================================ */

import { cnHolidayOn } from '../src/plan/holidays.ts';

test('节日：国内的那几个日子她都认得', () => {
  const lz = cityById('lanzhou');
  const on = (d) => cnHolidayOn(lz, d)?.name ?? null;
  // 这些日期是拿 ICU 的 chinese 历法核过的，不是背下来的
  assert.equal(on('2026-02-17'), '春节');
  assert.equal(on('2026-03-03'), '元宵');
  assert.equal(on('2026-04-05'), '清明');
  assert.equal(on('2026-05-01'), '劳动节');
  assert.equal(on('2026-06-19'), '端午');
  assert.equal(on('2026-09-25'), '中秋');
  assert.equal(on('2026-10-01'), '国庆');
  assert.equal(on('2026-10-18'), '重阳');
  assert.equal(on('2026-11-15'), null, '平常日子不该有节日');
});

test('节日：除夕靠「明天是不是初一」认，腊月有没有三十都对', () => {
  /*
   * 2027 年春节是 2 月 7 日 —— 我一开始凭记忆写的是 2 月 6 日，查证之后发现
   * 2 月 6 日其实是除夕。写死日期就是这么错一天的。
   * 这里不写「腊月三十」，是因为腊月有时只有二十九天。
   */
  const lz = cityById('lanzhou');
  assert.equal(cnHolidayOn(lz, '2026-02-16')?.name, '除夕');
  assert.equal(cnHolidayOn(lz, '2027-02-06')?.name, '除夕');
  assert.equal(cnHolidayOn(lz, '2027-02-07')?.name, '春节');
});

test('节日：国外城市不过中国节', () => {
  const tokyo = cityById('tokyo');
  assert.equal(cnHolidayOn(tokyo, '2026-02-17'), null, '东京在春节那天不该说自己在过年');
});

test('节日：地方节庆优先于全国节日', () => {
  /*
   * 西双版纳整个四月是泼水节，4 月 5 日同时是清明。
   * 她人在那儿，撞上的是泼水节，不是「这几天上坟」。
   */
  const jinghong = cityById('jinghong');
  const plan = planDay({
    city: jinghong, dateKey: '2026-04-05', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: null, dayIndex: 0,
  });
  const fest = plan.beats.find((b) => b.what.includes('赶上'));
  assert.ok(fest, '西双版纳四月没有节日那一条');
  assert.match(fest.what, /泼水节/, `说了别的节：${fest.what}`);
});

test('节日：春节那天排得进一天的作息表', () => {
  const lz = cityById('lanzhou');
  const plan = planDay({
    city: lz, dateKey: '2026-02-17', shape: 'full',
    lodging: rollLodging(() => 0.2), weather: null, dayIndex: 0,
  });
  const fest = plan.beats.find((b) => b.what.includes('赶上'));
  assert.ok(fest, '春节那天作息表里没有节日那一条');
  assert.match(fest.what, /春节/);
  assert.ok(fest.at >= 15 && fest.at <= 18, `节日排在了 ${fest.at} 点，不在下午`);
});

/* ---------------- 伙伴记忆（2026-11-05） ---------------- */

test('伙伴记忆：一起走过一次记一次；两台机器的记录合并取大不取和', () => {
  let a = {};
  a = metPet(a, '小银鱼', '2026-11-01');
  a = metPet(a, '小银鱼', '2026-11-03');
  assert.equal(a['小银鱼'].times, 2);
  assert.equal(a['小银鱼'].last, '2026-11-03');

  // 另一台机器也见过两次，日子更早 —— 合并之后是 2，不是 4
  let b = {};
  b = metPet(b, '小银鱼', '2026-10-01');
  b = metPet(b, '小银鱼', '2026-10-02');
  const m = mergePets(a, b);
  assert.equal(m['小银鱼'].times, 2, '次数被相加了 —— 同一次旅行会算两遍');
  assert.equal(m['小银鱼'].last, '2026-11-03', '上次见面的日子没取较新的那个');
});

test('伙伴记忆：印象取较新那句，没写字的盖不掉写过的', () => {
  const withNote = setPetImpression({ x: { times: 1, last: '2026-11-01', impression: '' } }, 'x', '话不多，但路上很稳');
  assert.equal(withNote.x.impression, '话不多，但路上很稳');

  const newer = mergePets(withNote, { x: { times: 1, last: '2026-11-05', impression: '' } });
  assert.equal(newer.x.impression, '话不多，但路上很稳', '较新那份没写印象，就把旧的那句冲掉了');
  assert.equal(newer.x.last, '2026-11-05');

  const replaced = mergePets(withNote, { x: { times: 1, last: '2026-11-06', impression: '后来不太想再一起走' } });
  assert.equal(replaced.x.impression, '后来不太想再一起走', '她自己改了口，旧印象压住了新的');
});

test('伙伴记忆：空名字不记；抹掉印象用空串', () => {
  assert.deepEqual(metPet({}, '', '2026-11-05'), {}, '空名字被记成了一条');
  const cleared = setPetImpression({ x: { times: 1, last: '', impression: '还行' } }, 'x', '');
  assert.equal(cleared.x.impression, '');
});

test('伙伴记忆：老文件里没有 pets 段，读出来是空表而不是崩', async () => {
  // 这个文件顶部没引这两个 —— 就地取，免得为一个用例动全局 import。
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'pets-mem-'));
  writeFileSync(join(dir, 'travel-memory.json'), JSON.stringify({
    version: 1, everVisited: ['xian'], wishes: [], spent: 0, earned: 0, updatedAt: '',
  }));
  const store = new TravelMemoryStore(dir);
  const m = store.read();
  assert.ok(m, '老格式读不出来');
  assert.deepEqual(m.pets, {}, '没有 pets 段时应该给空表');
  assert.deepEqual(m.everVisited, ['xian'], '老字段被带着一起丢了');
});

/* ---------------- 再来一次：节日与没逛完（2026-11-05） ---------------- */

test('节日数据：武汉樱花在三月，东京花见在三四月', () => {
  const wuhan = cityById('wuhan');
  assert.ok(wuhan, '武汉不在城市表里');
  const sakura = wuhan.festivals.find((f) => f.name === '樱花');
  assert.ok(sakura, '武汉没有樱花 —— Mr.Q 点名要的那条没落进去');
  assert.deepEqual([...sakura.months], [3], '樱花给了两个月，会摊薄成「春天」');
  assert.ok(sakura.what.length > 0, '只写了节名，没写那时候街上什么样');
  /*
   * 加樱花不能把渡江节挤掉。这条是今天踩到的：一个对象字面量里两个同名 key，
   * 后写的静默覆盖前写的，TypeScript 的类型剥离不报错 —— 加进去的那条根本没生效。
   * 所以现在 `festivals` 是数组，一城可以有几个节。
   */
  assert.ok(wuhan.festivals.some((f) => f.name === '武汉渡江节'), '加樱花把渡江节挤掉了');

  const tokyo = cityById('tokyo');
  assert.ok(tokyo, '东京不在城市表里');
  const hanami = tokyo.festivals.find((f) => f.name === '花见');
  assert.ok(hanami, '东京花见没了');
  assert.deepEqual([...hanami.months], [3, 4]);
});

test('节日和「没逛完」都让她更愿意再来一次，而且节日压过没逛完', () => {
  /*
   * 这两条是权重，不是硬规则，所以只能比频率。
   * 随机源固定成一个可重复的序列 —— 换台机器跑出来的数要一样。
   */
  const from = cityById('xian');
  const home = cityById('lanzhou');
  const visited = ['chengdu', 'chongqing', 'wuhan', 'xian', 'zhengzhou', 'lanzhou'];

  const hits = (extra, n = 400) => {
    let hit = 0;
    for (let i = 0; i < n; i++) {
      let s = i * 7919 + 13;
      const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
      const p = pickDestination({ from, home, visited, lastKm: 500, rnd, ...extra });
      if (p && p.city.id === 'wuhan') hit++;
    }
    return hit;
  };

  const plain = hits({});
  const fest = hits({ festivalIds: ['wuhan'] });
  const unfinished = hits({ unfinishedIds: ['wuhan'] });

  assert.ok(fest > plain, `樱花月没让武汉更容易被选中：${plain} → ${fest}`);
  assert.ok(unfinished > plain, `「没逛完」没让武汉更容易被选中：${plain} → ${unfinished}`);
  /*
   * 节日压过没逛完：节只有这一个月，没逛完的部分明年还在。
   * 相等也不算过 —— 相等说明两条被写成了同一个优先级。
   */
  assert.ok(fest >= unfinished, `节日该比「没逛完」更值钱：节 ${fest} vs 没逛完 ${unfinished}`);
});

test('节日权重不该压过「因为一首歌想去」', () => {
  /*
   * wishes 是 30 分那个档，是全表最高的一条。节日乘 4 之后，
   * 新城市 3×4=12，仍然输给它 —— 这条钉住这个次序。
   */
  assert.ok(30 > 3 * 4, '节日加成被调到了会压过「想去」的程度');
});

test('节日数据：桂花在江南的九月，红叶在北方的十月', () => {
  /*
   * 2026-11-05 按搜证补的，来源写在 `cities.ts` 的 FESTIVALS 注释里。
   * 这里只钉住「补进去了、月份对」，不重复记来源 —— 数据改了要能立刻红。
   */
  const hz = cityById('hangzhou');
  assert.ok(hz, '杭州不在城市表里');
  const gui = hz.festivals.find((f) => f.name === '桂花');
  assert.ok(gui, '杭州桂花没落进表 —— 满觉陇那条线是浙江在线 10-14 还在报盛花的');
  assert.deepEqual([...gui.months], [9, 10], '杭州桂花给了别的月份');

  const gl = cityById('guilin');
  /* 2026-11-07 核实后改名：桂林的「桂花」是花期不是节庆，且能开到 11 月上旬。 */
  assert.ok(gl && gl.festivals.some((f) => f.name.startsWith('桂花')), '桂林桂花没了');

  /*
   * 2026-11-07：补数据时把「红叶」写成了正式活动名（香山红叶节 / 红叶谷红叶节）。
   * 名字怎么写都可以，**窗口 10–11 不能变** —— 所以这里按名字包含「红叶」找，
   * 不再钉死两个字。钉死名字会让换一个更准的写法就红，而那条约束不是我们要守的。
   */
  const bj = cityById('beijing');
  assert.ok(bj, '北京不在城市表里');
  const leaf = bj.festivals.find((f) => f.name.includes('红叶'));
  assert.ok(leaf, '北京红叶没落进表 —— 林草局的赏红叶地图点名了香山');
  assert.deepEqual([...leaf.months], [10, 11], '北方红叶的窗口给错了');

  const jn = cityById('jinan');
  assert.ok(jn && jn.festivals.some((f) => f.name.includes('红叶')), '济南红叶谷没了');
});

/* ---------------- 口味：地方 / 吃食 / 景色（2026-11-05） ---------------- */

test('口味：三类各记一条，同名再记就是改写，不会长出两条', () => {
  let t = emptyTaste();
  t = setTaste(t, 'place', '玉泉观', '黄昏最好看', true, '2026-11-02');
  t = setTaste(t, 'food', '牦牛肉汤', '热的，从嗓子烫到胃里', true, '2026-11-05');
  t = setTaste(t, 'scenery', '雪山', '冬天来才对', true, '2026-11-03');
  assert.equal(t.place.length, 1);
  assert.equal(t.food.length, 1);
  assert.equal(t.scenery.length, 1);

  t = setTaste(t, 'food', '牦牛肉汤', '今天那碗咸了', true, '2026-11-06');
  assert.equal(t.food.length, 1, '同一个名字长出了第二条 —— 口味会自相矛盾');
  assert.equal(t.food[0].note, '今天那碗咸了', '再记一次没改写备注');
  assert.equal(t.food[0].at, '2026-11-06', '日期没更新');
});

test('口味：不喜欢的也要记下来（like:false）', () => {
  const t = setTaste(emptyTaste(), 'food', '酥油茶', '', false, '2026-11-04');
  assert.equal(t.food[0].like, false, '不喜欢被记成了喜欢 —— 下次还会被推荐');
  // 再记一次喜欢，就翻过来
  const back = setTaste(t, 'food', '酥油茶', '又喝了一次，居然上瘾', true, '2026-11-07');
  assert.equal(back.food[0].like, true, '她改主意了，记录没跟上');
  assert.equal(back.food[0].note, '又喝了一次，居然上瘾');
});

test('口味：空名字不记，超长名字截断，别把文件写坏', () => {
  const t = setTaste(emptyTaste(), 'place', '   ', 'x', true, '2026-11-05');
  assert.equal(t.place.length, 0, '空名字被记成了一条');
  const long = setTaste(emptyTaste(), 'place', '一'.repeat(80), '', true, '2026-11-05');
  assert.ok(long.place[0].name.length <= 24, '名字没截断，同步盘会被撑长');
});

test('口味：两份合并，按日子新的那份说话', () => {
  const a = setTaste(emptyTaste(), 'food', '牦牛肉汤', '好喝', true, '2026-11-05');
  const b = setTaste(emptyTaste(), 'food', '牦牛肉汤', '太油了，不想再喝', false, '2026-11-08');
  const m = mergeTaste(a, b);
  assert.equal(m.food.length, 1);
  assert.equal(m.food[0].like, false, '旧的「喜欢」压住了新的「不喜欢」—— 她改了主意也白改');
  assert.equal(m.food[0].note, '太油了，不想再喝');

  // 反过来：本地是新的，同步盘是旧的
  const m2 = mergeTaste(b, a);
  assert.equal(m2.food[0].like, false, '合并方向反过来就出错了 —— 说明比的是先后而不是谁在参数里');
});

test('口味：同一天两份，留有备注的那条', () => {
  const a = setTaste(emptyTaste(), 'place', '黄龙', '', true, '2026-11-03');
  const b = setTaste(emptyTaste(), 'place', '黄龙', '水是另一种蓝', true, '2026-11-03');
  const m = mergeTaste(a, b);
  assert.equal(m.place[0].note, '水是另一种蓝', '同一天合并时把备注丢了');
});

test('口味：老文件里没有这一段，读出来是空表而不是崩', () => {
  assert.deepEqual(normalizeTaste(undefined), { place: [], food: [], scenery: [] });
  assert.deepEqual(normalizeTaste({ place: '不是数组' }).place, []);
  // 混进来一条没有名字的，跳过就好
  const dirty = normalizeTaste({ food: [{ note: '没有名字' }, { name: '面' }] });
  assert.equal(dirty.food.length, 1);
  assert.equal(dirty.food[0].name, '面');
});

test('口味：存进 travel-memory.json，换台机器也读得回来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'taste-'));
  const store = new TravelMemoryStore(dir);
  const taste = setTaste(emptyTaste(), 'scenery', '红叶', '十一月的山', true, '2026-11-05');
  const bad = store.save({ everVisited: [], wishes: [], spent: 0, earned: 0, taste });
  assert.equal(bad, null, `写盘失败：${bad}`);

  const back = new TravelMemoryStore(dir).read();
  assert.ok(back, '读不回来');
  assert.equal(back.taste.scenery[0].name, '红叶');
  assert.equal(back.taste.scenery[0].note, '十一月的山');

  // 再存一次但**不带** taste：不能把已有的口味清空
  store.save({ everVisited: ['xian'], wishes: [], spent: 0, earned: 0 });
  const again = new TravelMemoryStore(dir).read();
  assert.equal(again.taste.scenery.length, 1, '少传 taste 就把口味清空了');
});

test('口味摘要：喜欢和不喜欢的分开说，没记的那类不占行', () => {
  let t = emptyTaste();
  t = setTaste(t, 'food', '牦牛肉汤', '热', true, '2026-11-05');
  t = setTaste(t, 'food', '酥油茶', '', false, '2026-11-05');
  const said = tasteSummary(t);
  assert.match(said, /喜欢：牦牛肉汤（热）/);
  assert.match(said, /不喜欢：酥油茶/);
  assert.equal(said.includes('景色'), false, '没记景色却写了一行空的');
  assert.equal(tasteSummary(emptyTaste()), '', '空表还说了话');
});

test('工具表：journey_taste 只收三类，且标成写操作', () => {
  const t = JOURNEY_DESCRIBE.tools.find((x) => x.name === 'journey_taste');
  assert.ok(t, '工具表里没有 journey_taste —— 她记不了自己的口味');
  assert.deepEqual([...t.parameters.properties.kind.enum], ['place', 'food', 'scenery'],
    '类别和记忆里那三类对不上');
  assert.ok(t.tags.includes('write'), '它写文件、写状态，不该标成只读');
  assert.match(t.description, /like:false|does not want/i,
    '描述里没提「不喜欢也要记」—— 那条比喜欢更重要');
});

/* ---------------- 一起走的人不止一个（2026-11-05） ---------------- */

test('约定里的「跟谁」：一个、两个、三个各说各的说法，老数据退回单人', () => {
  /*
   * 一条邀约现在最多三只鱼接（加上发起者一共四只）。
   * 老数据没有 withPets —— 必须退回 withPet，不能被空数组盖成「一只鱼」。
   */
  assert.equal(whoOf({ withPet: '小满' }), '小满', '老数据（没有 withPets）没退回单人');
  assert.equal(whoOf({ withPet: '小满', withPets: ['小满'] }), '小满');
  assert.equal(whoOf({ withPet: '小满', withPets: ['小满', '小汐'] }), '小满和小汐');
  assert.equal(whoOf({ withPet: '小满', withPets: ['小满', '小汐', '阿澈'] }), '小满、小汐、阿澈');
  // 空数组当没有
  assert.equal(whoOf({ withPet: '小满', withPets: [] }), '小满');
  // 缺名字的兜底
  assert.equal(whoOf({ withPet: '' }), '一只鱼');
});
