/**
 * 算一算这台服务器每天吃掉多少额度。
 *
 * ## 为什么要算
 *
 * Cloudflare 免费版给的三条线，各自的量级完全不同，混在一起看会得出错的结论：
 *
 *   Workers   10 万次请求/天      ← 现在是「按次」的，跟数据量无关
 *   D1        500 万行读取/天     ← **跟表有多大有关**，这才是真瓶颈
 *   D1        10 万行写入/天      ← 每次上报写 2 行（计数器 + presence）
 *
 * 注释里原来写的是「一天 24 次，能撑 4000 只鱼」—— 那条只算了请求次数。
 * 但 `/sight/status` 每次都要 `SELECT COUNT(DISTINCT uid) FROM presence WHERE date_key=?`
 * **读一遍当天所有 presence 行**，所以「读的行数」是 `24 × 只数 × 每只每天的槽位数`，
 * 也就是**只数的平方**。真正先撞墙的是 D1 的读取额度，不是 Workers 的请求数。
 *
 * ## 用法
 *
 *   node tools/quota.mjs                 # 探一次线上池子，按它算
 *   node tools/quota.mjs --pets 300      # 按 300 只算（压测/规划）
 *   node tools/quota.mjs --rows 3        # 每只每天写几行 presence（默认 2）
 *   node tools/quota.mjs --offline       # 不打网络，按 --pets 算（默认 100）
 *
 * 线上池子是从 `/sight/status` 回的 `pool` 读的 —— 那是「今天上报过的不同 uid 数」，
 * 也就是**今天真正在用的宠物数**，不是历史累计。
 */

const BASE = 'https://cooppetsjourney.top';

/* ---------------- 免费额度（2026-11 Cloudflare Free） ---------------- */
const LIMIT = {
  requests: 100_000, // Workers 请求/天
  rowsRead: 5_000_000, // D1 行读取/天
  rowsWritten: 100_000, // D1 行写入/天
};

/* ---------------- 参数 ---------------- */
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (n) => process.argv.includes(`--${n}`);

const ROWS_PER_PET = Number(arg('rows', '2')); // 每只每天写几行 presence（1–4 个时段）
const MARKET_CALLS = Number(arg('market', '1')); // 每只每天拉几次 catalog（开面板才拉）
const INVITES = Number(arg('invites', '0.2')); // 每只每天发/接几次邀约
const OFFLINE = flag('offline');
const FIXED = Number(arg('pets', '0'));

/* ---------------- 线上池子 ---------------- */
async function probePool() {
  const uid = Array.from({ length: 32 }, () => 'abcdef0123456789'[Math.floor(Math.random() * 16)]).join('');
  const res = await fetch(`${BASE}/sight/status?city=chengdu&uid=${uid}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = await res.json();
  return Number(body.pool) || 0;
}

/* ---------------- 账 ---------------- */
/**
 * 一次 `/sight/status` 读多少行。
 *
 * 两条查询：
 *   1. `COUNT(DISTINCT uid) ... WHERE date_key = 今天` —— 扫当天全部 presence 行，
 *      行数 = 只数 × 每只每天的行数（PRIMARY KEY 带 slot，一天最多 4 行）。
 *   2. 邀约列表 + 两个相关子查询（每个邀约再去数 takers）。
 *      表小、量级跟只数同阶，按「邀约行数 + 参与行数」粗估。
 */
function rowsPerStatus(pets, rowsPerPet, invitesOpen) {
  const presenceRows = pets * rowsPerPet;
  const inviteRows = invitesOpen + invitesOpen * 2;
  return presenceRows + inviteRows;
}

async function main() {
  let pets = FIXED;
  let source = '--pets';
  if (!pets) {
    if (OFFLINE) {
      pets = 100;
      source = '默认 100（--offline）';
    } else {
      try {
        pets = await probePool();
        source = '线上 /sight/status 的 pool';
      } catch (e) {
        pets = 100;
        source = `探测失败（${e.message}），按 100 算`;
      }
    }
  }

  /* 请求次数 */
  const statusReqs = pets * 24; // 一小时一次
  const presenceReqs = pets * Math.min(ROWS_PER_PET, 4); // 排一天表报一次
  const inviteReqs = Math.ceil(pets * INVITES);
  const marketReqs = Math.ceil(pets * MARKET_CALLS);
  const reqs = statusReqs + presenceReqs + inviteReqs + marketReqs;

  /* D1 */
  const openInvites = Math.max(1, Math.round(pets * 0.1)); // 同时挂着的邀约，按只数 10% 估
  const perStatus = rowsPerStatus(pets, ROWS_PER_PET, openInvites);
  const rowsRead = statusReqs * perStatus + presenceReqs * 3 + inviteReqs * 4;
  const rowsWritten = presenceReqs * 2 + inviteReqs * 2;

  const pct = (n, limit) => `${((n / limit) * 100).toFixed(1)}%`;
  const fmt = (n) => n.toLocaleString('zh-CN');

  console.log(`\n宠物数 ${pets}（来源：${source}）｜每只每天 ${ROWS_PER_PET} 行 presence、${MARKET_CALLS} 次 catalog`);
  console.log('\n—— 每天请求 ——');
  console.log(`  /sight/status   ${fmt(statusReqs).padStart(9)}  （${pets} × 24 次/天）`);
  console.log(`  presence 上报   ${fmt(presenceReqs).padStart(9)}`);
  console.log(`  邀约            ${fmt(inviteReqs).padStart(9)}`);
  console.log(`  catalog 反代    ${fmt(marketReqs).padStart(9)}  （每次 750KB，走边缘缓存）`);
  console.log(`  合计            ${fmt(reqs).padStart(9)}  = 免费额度的 ${pct(reqs, LIMIT.requests)}`);

  console.log('\n—— D1 ——');
  console.log(`  每次 status 读 ${fmt(perStatus)} 行（当天 presence ${pets * ROWS_PER_PET} 行 + 邀约）`);
  console.log(`  读              ${fmt(rowsRead).padStart(9)}  = ${pct(rowsRead, LIMIT.rowsRead)}`);
  console.log(`  写              ${fmt(rowsWritten).padStart(9)}  = ${pct(rowsWritten, LIMIT.rowsWritten)}`);

  /* 规模表：只数翻倍，读取量是四倍 —— 这是平方项的直接后果。 */
  console.log('\n—— 按只数推 ——');
  console.log('  只数  请求/天  请求占比  D1 读取/天  读取占比');
  for (const n of [50, 100, 200, 300, 400, 800]) {
    const r = n * 24 + n * ROWS_PER_PET + Math.ceil(n * INVITES) + Math.ceil(n * MARKET_CALLS);
    const inv = Math.max(1, Math.round(n * 0.1));
    const read = n * 24 * rowsPerStatus(n, ROWS_PER_PET, inv) + n * ROWS_PER_PET * 3;
    console.log(
      `  ${String(n).padStart(4)}  ${String(r).padStart(7)}  ${pct(r, LIMIT.requests).padStart(7)}`
      + `  ${String(read).padStart(10)}  ${pct(read, LIMIT.rowsRead).padStart(7)}`,
    );
  }

  /* 拐点：读额度用完时的只数。rowsRead ≈ 24·N·(N·rows + invites) */
  const cap = Math.floor(Math.sqrt(LIMIT.rowsRead / (24 * ROWS_PER_PET)));
  console.log(`\n拐点：按「每只 ${ROWS_PER_PET} 行」算，D1 读取额度在约 ${cap} 只时用完。`);
  console.log(`（Workers 请求额度要到 ${Math.floor(LIMIT.requests / (24 + ROWS_PER_PET + MARKET_CALLS + INVITES))} 只才用完 —— 所以先撞的是 D1，不是请求数。）`);
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
