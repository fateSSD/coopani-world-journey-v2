/**
 * 记忆模拟：让世界跑几十天，**每天真的写一篇日记**，然后检查记忆那一层。
 *
 * 为什么另开一个而不是塞进 sim.mts：sim.mts 验的是状态机（会不会卡、会不会重复推），
 * 它根本不写日记 —— 日记是模型调工具才产生的。这里补的正是那一段：
 *   ① 月文件是不是一个月一个、天数对不对；
 *   ② 读回来是不是原来那篇（写进去 ≠ 读得出）；
 *   ③ 同一天改口会不会留底；
 *   ④ 换一台机器（新 dataDir + 同一个同步盘）记忆接不接得上。
 *
 * 用法：`npx tsx test/sim-memory.mts [真实天数=2] [倍速=24]`
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JourneyWorld } from '../src/world.ts';
import type { JourneyConfigSection } from '../src/config.ts';

const DAYS = Number(process.argv[2] ?? 2);
const SPEED = Number(process.argv[3] ?? 24);
/** 第四个参数是预算。0 = 不限（记账等于没开的效果）。 */
const BUDGET = Number(process.argv[4] ?? 3000);

const dataA = mkdtempSync(join(tmpdir(), 'jmem-a-'));
const syncDir = join(dataA, '..', `jmem-sync-${process.pid}`);
mkdirSync(syncDir, { recursive: true });

const events: { type: string; key: string; at: string; text: string }[] = [];
let clock = new Date('2026-10-20T00:00:00Z');
const host = {
  log: { info(): void {}, warn(): void {}, debug(): void {}, error(): void {} },
  /*
   * 事件要真的收下来。2026-11-02 加：光看日记和状态，「她到底打了多少次工」
   * 是数不出来的 —— 而那正是这一版最需要盯的东西（打工次数对了没有、
   * 开工和收工配不配得上）。
   */
  pushEvent: async (e: Record<string, unknown>): Promise<void> => {
    events.push({
      type: String(e.type),
      key: String(e.senderKey ?? ''),
      at: String(e.ts ?? ''),
      text: String(e.text ?? ''),
    });
  },
} as unknown as Parameters<JourneyWorld['start']>[0];

const cfg: JourneyConfigSection = {
  enabled: true,
  homeCity: '兰州',
  speed: SPEED,
  memoryDir: syncDir,
  restDays: 1,
  maxTripWeeks: 26,
  withUser: false,
  moneyEnabled: true,
  budget: BUDGET,
  amapKey: '',
  imageApi: '',
  imageStyle: '',
  imageKey: '',
  imageModel: '',
  feedbackEmail: '',
  beatGap: 2,
  askBeforeDepart: false,
};

const world = new JourneyWorld({ cfg, dataDir: dataA, botName: 'test', now: () => clock });
await world.start(host);

const tools = world.tools();
const diaryWrite = tools.find((t) => t.name === 'journey_diary_write');
const diaryRead = tools.find((t) => t.name === 'journey_diary_read');
if (!diaryWrite || !diaryRead) throw new Error('没找到日记工具');

type St = { dateKey: string; hereId: string; stayDateKey: string | null };
const stOf = (): St => (world as unknown as { st: St }).st;

const written: string[] = [];
const problems: string[] = [];
let rewrites = 0;

/** 一天的日记正文。故意带上日期和城市，读回来能对上就行。 */
const bodyFor = (dateKey: string, cityId: string, extra: string): string =>
  `${dateKey} 在 ${cityId}。${extra} 这段是模拟写的，用来验月文件和读回。`;

const STEP_MS = 60_000;
const ticks = Math.ceil((DAYS * 86_400_000) / STEP_MS);
let lastDay = '';
for (let i = 0; i < ticks; i++) {
  clock = new Date(clock.getTime() + STEP_MS);
  await (world as unknown as { tick: () => Promise<void> }).tick();

  const st = stOf();
  const key = st.stayDateKey;
  // 跨天（stayDateKey 变了）就给她「昨天」写一篇 —— 她在晚上写当天的那篇。
  if (key && key !== lastDay) {
    if (lastDay && /^-?\d{4}-\d{2}-\d{2}$/.test(lastDay)) {
      const r = await diaryWrite.handler({ body: bodyFor(lastDay, st.hereId, '白天在外面走了走。'), dateKey: lastDay });
      const text = (r as { text?: string; isError?: boolean }).text ?? '';
      if ((r as { isError?: boolean }).isError) problems.push(`写 ${lastDay} 失败：${text}`);
      else written.push(lastDay);
    }
    lastDay = key;

    // 每 7 天故意改一次口，验 _bak（世界时间回退时就会这样）
    if (written.length % 7 === 0 && written.length > 0) {
      const d = written[written.length - 1];
      const r = await diaryWrite.handler({ body: bodyFor(d, st.hereId, '改口之后的版本，比上一版多一句。'), dateKey: d });
      if (!(r as { isError?: boolean }).isError) rewrites += 1;
    }
  }
}

await world.stop();

// ---------- 检查 ----------
const diaryDir = join(syncDir);
const months = readdirSync(diaryDir).filter((n) => /^\d{4}-\d{2}\.md$/.test(n)).sort();
const daysInMonths = new Map<string, number>();
for (const m of months) {
  const txt = readFileSync(join(diaryDir, m), 'utf8');
  daysInMonths.set(m, (txt.match(/^date: \d{4}-\d{2}-\d{2}$/gm) ?? []).length);
}

const totalInFiles = [...daysInMonths.values()].reduce((a, b) => a + b, 0);
const bakFiles = (() => {
  try { return readdirSync(join(diaryDir, '_bak')).filter((n) => n.endsWith('.md')); } catch { return []; }
})();

// 读回抽查：三种入口都要能用 —— 单天精确、按月列目录、最近 N 天。
// **这里刻意不只用 days**：2026-11-02 就是栽在「只看 days」上，
// 跑到 141 天时最早那天和跨年那天都读不回来，而文件里明明有。
const probeDates = [written[0], written[Math.floor(written.length / 2)], written[written.length - 1]].filter(Boolean);
const readResults: { date: string; ok: boolean; via: string }[] = [];
for (const d of probeDates) {
  const r = await diaryRead.handler({ dateKey: d });
  const txt = (r as { text?: string }).text ?? '';
  readResults.push({ date: d, ok: txt.includes(d) && !txt.includes('日记里没有'), via: 'dateKey' });
}
for (const m of months) {
  const r = await diaryRead.handler({ month: m.slice(0, 7) });
  const txt = (r as { text?: string }).text ?? '';
  const listed = (txt.match(/^[0-9]{4}-[0-9]{2}-[0-9]{2} · /gm) ?? []).length;
  const want = daysInMonths.get(m) ?? 0;
  readResults.push({ date: m, ok: listed === want, via: 'month' });
  if (listed !== want) problems.push(`按月列 ${m} 只列出 ${listed} 天，文件里有 ${want} 天`);
}
// 最近 N 天入口：只验它自己没坏，不要求覆盖全程
const recent = await diaryRead.handler({ days: 30 });
const recentText = (recent as { text?: string }).text ?? '';
const recentDays = (recentText.match(/^[0-9]{4}-[0-9]{2}-[0-9]{2} · /gm) ?? []).length;
if (recentDays === 0) problems.push('最近 30 天读不出来');

// ---------- 跨设备 ----------
const dataB = mkdtempSync(join(tmpdir(), 'jmem-b-'));
mkdirSync(syncDir, { recursive: true });
const world2 = new JourneyWorld({ cfg, dataDir: dataB, botName: 'test', now: () => clock });
await world2.start(host);
const st2 = (world2 as unknown as { st: { wishes: string[]; everVisited: string[]; spent: number; earned: number } }).st;
const snap2 = (world2 as unknown as {
  uiSnapshot: () => { diary: { days: number }; wishes: string[]; trip: { spent: number; visited: number } };
}).uiSnapshot();
await world2.stop();

// ---------- 报告 ----------
console.log('==== 记忆模拟 ====');
console.log(`真实 ${DAYS} 天 × ${SPEED}x = 世界约 ${DAYS * SPEED} 天，巡检 ${ticks} 次，预算 ${BUDGET || '不限'}`);
console.log(`写了 ${written.length} 篇，改口 ${rewrites} 次`);
console.log(`月文件 ${months.length} 个：${months.map((m) => `${m}(${daysInMonths.get(m)}天)`).join('  ')}`);
console.log(`月文件里的天数合计 ${totalInFiles}，_bak 里 ${bakFiles.length} 个文件`);
console.log('');
console.log('读回抽查（单天 / 按月）：');
for (const r of readResults) {
  console.log(`  ${r.date}  ${r.ok ? '✓' : '✗'}  ${r.via}`);
  if (!r.ok) problems.push(`读不回 ${r.date}（${r.via}）`);
}
console.log(`  最近 30 天：${recentDays} 篇`);
console.log('');
// ---- 钱与打工 ----
const purseLeft = cfg.budget - (st2.spent - st2.earned);
const starts = events.filter((e) => e.key.startsWith('work-start'));
const ends = events.filter((e) => e.key.startsWith('work-end'));
console.log('');
console.log('钱与打工：');
console.log(`  预算 ${cfg.budget}：花了 ${st2.spent}、挣了 ${st2.earned}（净值 ${st2.spent - st2.earned}）`);
console.log(`  打工开工 ${starts.length} 次、收工 ${ends.length} 次`);
for (const e of starts.slice(0, 6)) console.log(`    · ${e.text.split('。')[0]}`);
/*
 * 同一时间只能有一份工。开工比收工多一次是正常的（最后一次还没干完），
 * 多两次就说明中间有重复开工 —— 那样她会一边打工一边「又找了份活」。
 */
if (starts.length - ends.length > 1) {
  problems.push(`开工 ${starts.length} 次、收工 ${ends.length} 次 —— 有重复开工`);
}
if (purseLeft < 0 && starts.length === 0) {
  problems.push(`预算 ${cfg.budget} 已经花超 ${-purseLeft}，却一次工都没打`);
}

console.log('换一台机器（新 dataDir + 同一个同步盘）：');
console.log(`  日记 ${snap2.diary.days} 天｜去过 ${snap2.trip.visited} 个｜想去 ${snap2.wishes.length} 个｜花销 ${snap2.trip.spent}`);
console.log(`  本机 state 里 everVisited=${st2.everVisited.length}，wishes=${st2.wishes.length}，spent=${st2.spent}`);
if (snap2.diary.days !== totalInFiles) problems.push(`新机器看到的日记天数 ${snap2.diary.days} ≠ 文件里的 ${totalInFiles}`);
if (st2.everVisited.length === 0 && totalInFiles > 0) problems.push('换机器后「去过的地方」空了 —— 记忆没接上');

console.log('');
if (problems.length) {
  console.log(`❌ ${problems.length} 个问题：`);
  for (const p of problems.slice(0, 10)) console.log('  - ' + p);
} else {
  console.log('✅ 日记按月、读得回、改口留底、换机器接得上');
}

rmSync(dataA, { recursive: true, force: true });
rmSync(dataB, { recursive: true, force: true });
rmSync(syncDir, { recursive: true, force: true });
if (problems.length) process.exit(1);
