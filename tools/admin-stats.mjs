/**
 * 拉一份「谁在刷」的分布。
 *
 * ## 为什么要有这个脚本
 *
 * 管理面板（`/pets`）只给一行一个数字：上报格数。看的人很容易把它读成
 * 「发了 N 条消息」，然后去猜是不是有人刷屏 —— 2026-11-07 就是这么来的。
 *
 * 真正能判「刷没刷」的是另外三个数（`/admin/stats`）：
 *
 *   posts  今天全站上报总次数（rate 计数，含被限速挡下的部分不计）
 *   rows   今天库里有多少格
 *   uids   今天有多少只鱼
 *
 * `posts / uids` 就是「平均每只报了几次」。一只鱼正常情况下一天 1–8 次
 * （4 个时段 + 换城），**明显高于这个数的那只**才值得看。
 *
 * ## 用法
 *
 *   node tools/admin-stats.mjs --key <ADMIN_KEY>
 *   node tools/admin-stats.mjs --key <KEY> --uid d79b8bdc8154b1ef6484881a
 *   node tools/admin-stats.mjs --key <KEY> --top 20
 *
 * 密钥只在本进程里用，不落盘、不打印。
 */

const BASE = process.env.SIGHT_BASE || 'https://cooppetsjourney.top';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const KEY = arg('key', process.env.ADMIN_KEY || '');
const ONLY_UID = arg('uid', '');
const TOP = Number(arg('top', '15'));

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'x-admin-key': KEY },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401) throw new Error('密钥不对（401）');
  if (res.status === 404) throw new Error('服务端没有管理接口（404）—— Worker 是旧版，或者没设 ADMIN_KEY');
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function main() {
  if (!KEY) {
    console.error('缺 --key。管理密钥是 Worker 的 secret ADMIN_KEY（面板「管理密钥」那一栏）。');
    process.exit(2);
  }

  const stats = await get('/admin/stats');
  const t = stats.today || {};
  const b = stats.budget || {};
  const perPet = t.uids ? (t.posts / t.uids) : 0;

  console.log(`\n今天 ${stats.day}（UTC 口径，跨零点按 UTC 切）`);
  console.log(`  上报 ${t.posts} 次 ｜ 格子 ${t.rows} 行 ｜ 宠物 ${t.uids} 只 ｜ 平均每只 ${perPet.toFixed(1)} 次`);
  console.log(`  日写额度 ${b.used}/${b.cap}（${(Number(b.ratio || 0) * 100).toFixed(1)}%）｜表里累计 ${stats.tables?.presence ?? '?'} 行`);

  if (Array.isArray(stats.cities) && stats.cities.length) {
    console.log('\n城市分布（今天上报次数前 12）：');
    for (const c of stats.cities) console.log(`  ${String(c.city).padEnd(14)} ${c.n}`);
  }

  const pets = (await get('/admin/pets')).pets || [];
  const sorted = [...pets].sort((a, b2) => (b2.rows || 0) - (a.rows || 0));

  console.log(`\n上报格数排行（保留 4 天，一天最多 4 格）：`);
  console.log('  格数  城数  天数  每格/天  名字');
  for (const p of sorted.slice(0, TOP)) {
    const perDay = p.days ? (p.rows / p.days).toFixed(1) : '-';
    console.log(
      `  ${String(p.rows).padStart(4)}  ${String(p.cities ?? '-').padStart(4)}  `
      + `${String(p.days ?? '-').padStart(4)}  ${String(perDay).padStart(7)}  ${p.pet || '（没名字）'}`,
    );
  }

  /* 判据：一天超过 4 格只可能是「换过城」；超过 4 且城数也多，属于跑得快，不是刷。 */
  const odd = sorted.filter((p) => p.days && p.rows / p.days > 8);
  console.log(
    odd.length
      ? `\n值得看一眼（每天 >8 格）：${odd.map((p) => p.pet || p.uid).slice(0, 8).join('、')}`
      : '\n没有每天超过 8 格的 —— 都在「4 时段 × 少数几次换城」的正常范围内。',
  );

  if (ONLY_UID) {
    const one = pets.find((p) => p.uid === ONLY_UID);
    console.log(`\n单只 ${ONLY_UID}:`, one ? JSON.stringify(one, null, 1) : '列表里没有（可能已过 4 天留存）');
  }
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
