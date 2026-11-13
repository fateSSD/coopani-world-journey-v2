/**
 * 「今天日记写了没」这一行（2026-11-07）
 *
 * ## 起因
 *
 * Mr.Q：「还有我的鱼6号没写日记，不知道为啥」。
 *
 * 翻日记文件：11-01 到 11-05 一天不落，11-06 空着。
 * 翻代码：`journey_diary_write` 这个工具一直都在，提示词里也有「一天一条，晚上写」，
 * **但她的 `nowSummary` 里没有这一项** —— 写不写全靠她主动想起工具表里那行字。
 *
 * 这跟「有车不说」「同伴不说」「住哪不说」是同一条规律：
 * **不在 `nowSummary` 里的事，对她就是不存在的。**
 *
 * ## 这一行要说清三件事
 *
 * 1. 今天写没写 —— 欠账要摆在她每回合都读的那一段里；
 * 2. 现在是不是该写的时候 —— 中午看到「还没写」就动笔，那篇会写成半天的流水；
 * 3. 昨天空没空 —— 她漏了一天自己不一定知道，而补写只有她能做。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

const TRIP_START = '2026-10-31T10:25:01.249Z';

/**
 * 造一个「在成都停留」的世界，`now` 用世界时刻。
 *
 * 日记目录单独给一个临时目录 —— 绝不能碰真实的 OneDrive 那份。
 */
function boot(nowIso, seed = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'diary-'));
  const diaryDir = join(dir, 'diary');
  new StateStore(dir).save(initialState('lanzhou'));
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', memoryDir: diaryDir },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(nowIso),
  });
  /*
   * **直接改 `w.st`，不走 StateStore。**
   *
   * 第一版是先 save 一份「在成都停留」的状态再构造，结果 world 启动时自己
   * 把状态归一化回「在家」了 —— 于是 `nowSummary` 返回「兰州。在家，随时可以动身」。
   * 这条路（构造完再改内存状态）是这个仓库里其它测试一直在用的，稳。
   */
  w.st = {
    ...w.st,
    phase: 'staying',
    hereId: 'chengdu',
    stayDateKey: '2026-11-07',
    stayStartedAt: '2026-11-06T04:18:14.669Z',
    tripStartedAt: TRIP_START,
    ...seed,
  };
  w.diary.configure(diaryDir);
  return w;
}

const writeDay = (w, dateKey, cityName = '成都') => {
  const r = w.diary.write({ dateKey, cityId: 'chengdu', cityName, body: '今天走了不少路。' });
  assert.equal(r.problem, null, `日记没写进去：${r.problem}`);
};

/** 成都 12:00 = UTC 04:00；成都 21:00 = UTC 13:00。 */
const atChengdu = (h) => new Date(Date.UTC(2026, 10, 7, h - 8, 0, 0)).toISOString();

test('白天没写：说还没写，但别催', () => {
  const w = boot(atChengdu(12));
  writeDay(w, '2026-11-06');
  const s = w.nowSummary();
  assert.match(s, /日记：今天还没写/, `没提示欠账：${s.slice(-160)}`);
  assert.match(s, /晚上回酒店再写/, '中午就催她写，会写成半天的流水');
  assert.doesNotMatch(s, /该写了/, '中午不该用「该写了」这种口气');
});

test('过了晚上八点：改成催', () => {
  const w = boot(atChengdu(21));
  writeDay(w, '2026-11-06');
  const s = w.nowSummary();
  assert.match(s, /日记：今天还没写.*回酒店后写一条/s, `晚上没催：${s.slice(-160)}`);
  /* 晚上还用白天那套「（晚上回酒店再写）」，等于没催。 */
  assert.doesNotMatch(s, /晚上回酒店再写/, `晚上还在用白天的措辞：${s.slice(-160)}`);
});

test('昨天也空着：把日期点出来', () => {
  const w = boot(atChengdu(12));
  writeDay(w, '2026-11-05');
  const s = w.nowSummary();
  assert.match(s, /11-06 那天也空着/, `漏了一天却没提：${s.slice(-160)}`);
});

test('今天写过了：只说一句，不催', () => {
  const w = boot(atChengdu(21));
  writeDay(w, '2026-11-07');
  const s = w.nowSummary();
  assert.match(s, /日记：今天已经写过了/, `写完了还在催：${s.slice(-160)}`);
  assert.doesNotMatch(s, /还没写/);
});

test('旅行第一天没有「昨天」—— 别让她以为自己欠两天', () => {
  /* 11-01 是旅行的第三天（10-31 出发），所以把开始时间挪到 11-07。 */
  const w = boot(atChengdu(12), { tripStartedAt: '2026-11-07T00:00:00.000Z' });
  const s = w.nowSummary();
  assert.match(s, /今天还没写/, s.slice(-160));
  assert.doesNotMatch(s, /也空着/, `旅行第一天就提「昨天空着」：${s.slice(-160)}`);
});

test('赶路那天也报 —— 漏掉的那一天正是在路上', () => {
  /*
   * 11-06 她就是从九寨沟往成都走。第一版只在「停留」那一支加了这一行，
   * 赶路和在家两支都没有 —— 等于**恰好漏在最容易忘的那一天**。
   */
  const w = boot(atChengdu(12));
  w.st = {
    ...w.st,
    phase: 'traveling',
    leg: {
      fromId: 'jiuzhaigou', toId: 'chengdu', modeId: 'train', km: 400,
      durationWorldHours: 6, startedAt: '2026-11-07T00:00:00.000Z',
      arriveAt: '2026-11-07T06:00:00.000Z', viaIds: [],
    },
  };
  const s = w.nowSummary();
  assert.match(s, /在路上/, `没进赶路分支：${s.slice(0, 100)}`);
  assert.match(s, /日记：今天还没写/, `赶路那天不报欠账：${s.slice(-160)}`);
});

test('在家那几天也报', () => {
  const w = boot(atChengdu(12), { phase: 'home', hereId: 'lanzhou' });
  const s = w.nowSummary();
  assert.match(s, /日记：今天还没写/, `在家不报欠账：${s.slice(-160)}`);
});

test('真实那份日记目录：11-06 确实空着（本机现场）', () => {
  /*
   * 这条跑的是 Mr.Q 本机 OneDrive 里那份，不是造的数据 ——
   * 它是这次问题的**现场证据**，删掉就没人记得当时发生了什么。
   *
   * 目录不存在时跳过（换台机器跑测试不该红）。
   */
  const real = 'C:/Users/Administrator/OneDrive/Coopanion/journey';
  const probe = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', memoryDir: real },
    dataDir: mkdtempSync(join(tmpdir(), 'diary-probe-')),
    botName: '大肥鱼',
  });
  const health = probe.diary.configure(real);
  if (health.problem) return;   // 这台机器上没有那份日记，跳过

  const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];
  for (const d of days) assert.ok(probe.diary.read(d), `${d} 该有日记，现在没了`);
  assert.equal(probe.diary.read('2026-11-06'), null,
    '11-06 补上了？那这条测试要改成「那一天曾经空着」的说明性断言');
});
