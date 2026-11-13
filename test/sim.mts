/**
 * 端到端模拟：把一个月的旅行压缩到几秒跑完。
 *
 * 为什么要它：状态机（出发 → 在路上 → 到达 → 过日子 → 换地方 → 回家）的每个分支
 * 都只在**特定时间点**才走到。靠真实等待验证半年，等于不验证。
 *
 * 这个脚本不追求断言精确值（里面有随机），它只回答四个问题：
 *   1. 会不会卡在某个阶段再也不动？
 *   2. 同一条事件会不会被推两遍？
 *   3. 事件总量合不合理（一天六七条，而不是一分钟七条）？
 *   4. 日记写得进去吗？
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JourneyWorld } from '../src/world.ts';
import { JOURNEY_DEFAULTS, type JourneyConfigSection } from '../src/config.ts';
import { CITIES, cityById } from '../src/geo/cities.ts';
import { bearingDeg, angleBetween, distanceKm } from '../src/geo/distance.ts';

/** 第一个参数是**真实**天数，不是世界天数。
 *  24x 下真实 1 天 = 世界 24 天，所以别拿「跑 180 天」当参数 —— 那是半年真实时间。 */
const DAYS = Number(process.argv[2] ?? 1);
const SPEED = Number(process.argv[3] ?? 24);

const dir = mkdtempSync(join(tmpdir(), 'journey-sim-'));
let clock = new Date('2026-10-31T00:00:00Z');
const pushClock = (): Date => clock;

const HOME_ID = 'lanzhou';
const events: { type: string; key: string; text: string; at: string }[] = [];
const logs: string[] = [];

const host = {
  log: {
    info: (m: string): void => { logs.push(`INFO ${m}`); },
    warn: (m: string): void => { logs.push(`WARN ${m}`); },
    debug: (): void => {},
    error: (m: string): void => { logs.push(`ERR  ${m}`); },
  },
  pushEvent: async (e: Record<string, unknown>, opts: { trigger?: string }): Promise<void> => {
    events.push({
      type: String(e.type),
      key: String(e.senderKey),
      text: String(e.text),
      at: String(e.ts),
    });
    void opts;
  },
} as unknown as Parameters<JourneyWorld['start']>[0];

/*
 * 配置**要按 `JOURNEY_DEFAULTS()` 补齐**，别只写用得上的几个。
 *
 * 2026-11-05 长跑模拟抓到：这份对象少了 `meetUrl`，而 `meetOptions()` 里
 * 一个 `.trim()` 就把它撞成了「Cannot read properties of undefined」——
 * 每 60 秒一条，整趟旅行停摆。硬造一个残缺配置来测，测出来的全是假问题。
 */
const cfg: JourneyConfigSection = {
  ...JOURNEY_DEFAULTS(),
  enabled: true,
  homeCity: '兰州',
  speed: SPEED,
  memoryDir: '',
  restDays: 1,
  maxTripWeeks: 26,
  withUser: false,
  amapKey: '',
  imageApi: '',
  imageKey: '',
};

const world = new JourneyWorld({ cfg, dataDir: dir, botName: 'test', now: pushClock });
await world.start(host);

// 每 1 分钟醒一次 —— 与生产的 TICK_MS 一致。
// 步长别贪大：24x 下 10 分钟步长 = 4 小时世界时间，一次巡逻会跨过好几个作息节点，
// 测出来的「中间有 4 个点已经过去了」全是步长造成的假象。
const STEP_MS = 60_000;
const ticks = Math.ceil((DAYS * 86_400_000) / STEP_MS);
for (let i = 0; i < ticks; i++) {
  clock = new Date(clock.getTime() + STEP_MS);
  await (world as unknown as { tick: () => Promise<void> }).tick();
}

await world.stop();

// ---- 报告 ----
const byType = new Map<string, number>();
for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);

const keys = events.map((e) => e.key);
const dupKeys = keys.filter((k, i) => keys.indexOf(k) !== i);

// 出发时刻分布：验证「不再半夜零点走」。中文钟点解析回小数小时。
const CN = ['零','一','二','三','四','五','六','七','八','九','十','十一','十二','十三','十四','十五','十六','十七','十八','十九','二十','二十一','二十二','二十三','二十四'];
const cnHour = (t) => {
  const m = /当地\s*([^，]+)，/.exec(t);
  if (!m) return null;
  // 必须 trim：文案里是「当地 八点一分」，捕获出来带前导空格，不去掉正则的 ^ 就匹配不上。
  const hh = /^([一二三四五六七八九十]+|\d+)点/.exec(m[1].trim());
  if (!hh) return null;
  const h = CN.indexOf(hh[1]);
  return h >= 0 && h <= 24 ? h : null;
};
const departHours = events.filter((e) => e.type === 'journey.depart').map((e) => cnHour(e.text)).filter((h) => h !== null);
const nightDepart = departHours.filter((h) => h < 6 || h >= 22);

// ---- 路线连贯性 ----
// **按「趟」切分**。`everVisited` 是这辈子去过的地方，跨趟累积；
// 而回家 = 这一趟结束，方向会重置，所以「回家再出发」那个断点不算折返。
// 用 arrive / home 事件流切趟，每趟是 [家, 到达1, 到达2, ...]。
const trips: string[][] = [[HOME_ID]];
for (const e of events) {
  if (e.type === 'journey.arrive') {
    const m = /到了。(\S+?)，/.exec(e.text);
    if (m) {
      const c = CITIES.find((x) => x.name === m[1]);
      if (c) trips[trips.length - 1].push(c.id);
    }
  } else if (e.type === 'journey.home') {
    trips.push([HOME_ID]);
  }
}

// 哪些段是**回程**：回程本来就是往回走，把它算进「折返率」等于自己骂自己。
// 回程的 depart 文案是「往X的方向走」，普通换城市是「在这儿待够了，动身」。
const returnLegs = new Set<string>();
for (const e of events) {
  if (e.type !== 'journey.depart') continue;
  if (!/往\S+的方向走/.test(e.text)) continue;
  const m = /下一站(\S+?)，/.exec(e.text);
  if (m) returnLegs.add(m[1]);
}

let hardTurns = 0;
let totalTurns = 0;
let returnHops = 0;
const tripLines: string[] = [];
for (const t of trips) {
  if (t.length < 2) continue;
  const names = t.map((id) => cityById(id)?.name ?? id);
  const degs: (number | null)[] = [];
  for (let i = 2; i < t.length; i++) {
    const a = cityById(t[i - 2]); const b = cityById(t[i - 1]); const c = cityById(t[i]);
    if (!a || !b || !c) continue;
    if (returnLegs.has(c.name)) { degs.push(null); returnHops++; continue; }
    const d = Math.round(angleBetween(bearingDeg(a, b), bearingDeg(b, c)));
    degs.push(d);
    totalTurns++;
    if (d > 140) hardTurns++;
  }
  tripLines.push(`  ${names.join(' → ')}${degs.length ? `  [${degs.map((d) => d === null ? '回' : d + '°').join(' ')}]` : ''}`);
}

const nowInfo = world.envPromptVars()['journey.now'] ?? '';
const stats = await (world.tools().find((t) => t.name === 'journey_stats')?.handler({}) as Promise<{ text: string }>);

console.log('==== 模拟结果 ====');
const st = (world as unknown as { st: { clock?: { speed: number } } }).st;
console.log(`真实 ${DAYS} 天 × 倍速 ${SPEED} = 世界约 ${DAYS * SPEED} 天，巡检 ${ticks} 次，时钟 ${st.clock?.speed ?? '?'}x`);
console.log(`事件总数 ${events.length}`);
console.log('按类型：', JSON.stringify(Object.fromEntries(byType), null, 0));
console.log(`重复 senderKey：${dupKeys.length}${dupKeys.length ? ' → ' + [...new Set(dupKeys)].slice(0, 5).join(', ') : ''}`);
// 密度按**世界天数**算 —— 她要过的是一天一天的日子，不是真实秒数。
console.log(`事件密度：${(events.length / (DAYS * SPEED)).toFixed(1)} 条/世界天`);
console.log(`出发时刻（当地小时）：${departHours.join(', ') || '(无)'}`);
console.log(`半夜出发（<6 或 >=22 点）：${nightDepart.length} 次${nightDepart.length ? ' -> ' + nightDepart.join(',') : ''}`);
console.log(`路线（按趟，方括号是每次转向的夹角）：\n${tripLines.join('\n') || '  (没出门)'}`);
console.log(`趟数：${trips.filter((t) => t.length > 1).length}，最长一趟 ${Math.max(...trips.map((t) => t.length))} 站`);
// 每站待了多久（世界小时）：arrive 事件的真实时间戳差 × 倍速
const arr = events.filter((e) => e.type === 'journey.arrive');
const gaps = arr.slice(1).map((e, i) => (Date.parse(e.at) - Date.parse(arr[i].at)) / 3_600_000 * SPEED);
if (gaps.length) {
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  console.log(`相邻两站的平均间隔（世界小时）：${avg.toFixed(1)}，最短 ${Math.min(...gaps).toFixed(1)}，最长 ${Math.max(...gaps).toFixed(1)}`);
}
console.log(`折返（>140°，不含回程）：${hardTurns} / ${totalTurns}${totalTurns ? ` = ${((hardTurns / totalTurns) * 100).toFixed(0)}%` : ''}`);
console.log(`回程段：${returnHops} 段（标「回」，不算折返）`);
console.log('');
console.log('---- 前 6 条 ----');
for (const e of events.slice(0, 6)) console.log(`[${e.type}] ${e.text.split('\n')[0]}`);
console.log('');
console.log('---- 最后 3 条 ----');
for (const e of events.slice(-3)) console.log(`[${e.type}] ${e.text.split('\n')[0]}`);
console.log('');
console.log('---- 当前状态 ----');
console.log(nowInfo);
console.log('');
console.log('---- stats ----');
console.log(stats?.text ?? '(无)');
console.log('');
const warnings = logs.filter((l) => l.startsWith('WARN') || l.startsWith('ERR'));
console.log(`---- 告警 ${warnings.length} 条 ----`);
for (const w of warnings.slice(0, 10)) console.log(w);

rmSync(dir, { recursive: true, force: true });

// 退出码：只有明确的坏情况才非零，方便当冒烟测试用
const bad = dupKeys.length > 0 || events.length === 0 || warnings.some((w) => w.includes('出错'));
if (bad) { console.error('\n❌ 有明确问题，见上'); process.exit(1); }
console.log('\n✅ 状态机跑通了');
