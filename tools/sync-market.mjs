/**
 * 发版之后，盯住扩展市场有没有收进这一版。
 *
 * ## 为什么要有这个东西
 *
 * 2026-11-07 那次发版踩了一场：0.9.1 在 npm 上早就 `latest` 了，
 * 市场里还是 0.9.0，连着两次 sync 都失败。翻日志才看清根因 ——
 *
 *   GET https://api.npmjs.org/downloads/point/last-month/<包名>: 429
 *   Access denied | api.npmjs.org used Cloudflare to restrict access
 *
 * 上游 `scripts/scan.mjs` 会给**索引里的每一个包**（当前 315 个）逐个拉月下载量，
 * 没有节流、也没有 429 的降级；GitHub runner 的出口 IP 一旦被 Cloudflare 临时封，
 * 整个 job 在 `Scan npm` 这一步就死了，后面的 Commit 根本不会执行。
 * 也就是说**和我们的包一点关系都没有**，纯粹是抽签：05:11 那次抽中了干净 IP 就过了。
 *
 * 我们能控的只有「触发」这一环：开一个 `[sync] 包名` 的 issue（或重开旧的）
 * 就会跑一次。手点两次都没中，与其反复回到 GitHub 页面碰运气，不如写成脚本：
 * 轮询线上 catalog，**没收录就再触发一次，收录了就走**。
 *
 * （这个「再触发」后来被推翻了，理由见下一节。）
 *
 * ## 2026-11-07 追加：**别再手动触发了**
 *
 * 上面那段写于「手点两次没中」的时候，当时以为多试几次总能抽到干净 IP。
 * 跑了一整天之后把上游代码翻出来看，结论反过来了 —— **手动触发是在帮倒忙**：
 *
 * 1. `sync.yml` 的 cron 是 `17,47 * * * *`，**每半小时就自己跑一次**，一天 48 次。
 *    我们开的 `[sync]` issue 只是在这一天 48 次之外**再加一次同样的运行**，
 *    抽中的 IP 池是同一个，成功率不变。
 * 2. 每次运行都会在 `scan.mjs:36` 先调 `fetchDownloads()`，而它对**每一个作用域包**
 *    单独发三次请求（`scan.mjs:268-273`，近一年 / 近一月 / 近一周）——
 *    几百个请求打两秒内打出去。Cloudflare 的 `error 1015` 就是按 IP 限速封的，
 *    **多加一次运行，就给这条被封的 IP 多加一轮请求**。
 * 3. `lib.mjs:105-113` 的 `fetchJson` 确实有重试，但只有 3 次、退避 2s / 4s ——
 *    1015 那种按小时计的封禁，六秒内重试三次没有意义；三次都失败就 `throw`，
 *    `scan.mjs` 直接退 1，后面 `Commit` / `Answer sync requests` 全部 skipped。
 *
 * 所以脚本的职责收窄成一件事：**盯**。cron 自己会去撞，撞中了就退 0。
 * `--attempts` 默认改成 0；真要手动开一次（比如想让维护者看见某个版本的请求），
 * 显式传 `--attempts 1`。
 *
 * ## 用法
 *
 *   node tools/sync-market.mjs                       # 只盯（默认，不触发）
 *   node tools/sync-market.mjs --version 0.9.2
 *   node tools/sync-market.mjs --timeout 2400 --attempts 1   # 真的要开一次 issue
 *   node tools/sync-market.mjs --dry                  # 只看现在收没收，立刻退出
 *
 * 退出码：0 = 已收录；1 = 超时仍未收录；2 = 参数或环境有问题。
 *
 * ## 两条纪律
 *
 * 1. **不重复开 issue。** 同包同版本的 open issue 还在，就不再开——它会在下一次
 *    成功的 run 里被自动回帖关掉，再开一个只是给维护者添噪音。
 * 2. **只读线上事实。** 判定「收录了没有」只看 catalog.json 里的版本号，
 *    不看 issue 有没有被关（关掉也可能只是脚本跑完了但索引还没刷）。
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'Pal-AI-Lab/cortico-extensions';
const CATALOG = `https://raw.githubusercontent.com/${REPO}/main/catalog.json`;
const API = 'https://api.github.com';

/* ------------------------------------------------------------------ 参数 */

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const NAME = argOf('package', pkg.name);
const VERSION = argOf('version', pkg.version);
const TIMEOUT_S = Number(argOf('timeout', '1800'));
/*
 * **默认 0：只盯，不触发。**（2026-11-07 改，原来的默认是 3）
 *
 * 理由写在文件头上：cron 每半小时自己跑一次，我们多触发的每一次
 * 都只是给一条已经被 Cloudflare 封掉的 IP 再加一轮请求。
 * 想看效果又不想碰 issue，用 `--dry`。
 */
const ATTEMPTS = Number(argOf('attempts', '0'));
const TOKEN_FILE = argOf('token', 'E:/Coopanion/data/extensions/github-token.json');
const DRY = flag('dry');
const QUIET = flag('quiet');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => { if (!QUIET) console.log(...a); };

/* ------------------------------------------------------------------ 版本 */

/** 只比 x.y.z 三段；带预发布标签的一律按「比同号正式版小」处理，够用。 */
function cmp(a, b) {
  const pa = String(a).split('-')[0].split('.').map(Number);
  const pb = String(b).split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 线上 catalog 里这个包是哪个版本。查不到返回 null。 */
async function listedVersion() {
  /*
   * **网络抖动不算「没收录」。** 国内直连 raw.githubusercontent.com 本来就慢，
   * 一次 `fetch failed` 就让整个盯梢退出，等于什么都没盯。
   * 重试三次，全失败才抛 —— 让调用方按「这轮没读到」处理，不中断轮询。
   */
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(CATALOG, { headers: { 'cache-control': 'no-cache' } });
      if (!res.ok) throw new Error(`catalog.json ${res.status}`);
      const data = await res.json();
      const pkgs = data.packages ?? data;
      const arr = Array.isArray(pkgs)
        ? pkgs
        : Object.entries(pkgs).map(([name, v]) => ({ name, ...v }));
      const hit = arr.find((p) => (p.name ?? p.package) === NAME);
      return hit?.version ?? null;
    } catch (e) {
      last = e;
      await sleep(3000);
    }
  }
  throw last;
}

/* ------------------------------------------------------------------ 触发 */

function token() {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf8')).token;
  } catch {
    return process.env.GITHUB_TOKEN ?? '';
  }
}

async function gh(path, init = {}) {
  const t = token();
  if (!t) throw new Error(`读不到 token：${TOKEN_FILE}`);
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `token ${t}`,
      'user-agent': 'coopani-sync',
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  return res;
}

/**
 * 已经有一个**同一版本**的 open 请求吗。
 *
 * 为什么还比版本：上一版（比如 0.9.1）的请求可能还挂着没被服务，
 * 但那不构成「0.9.2 不用开」的理由 —— 一次成功的 run 会把两个都回帖关掉。
 * 标题里没写版本号的（老格式）按匹配处理，宁可不开也别漏。
 */
async function pendingIssue() {
  const res = await gh(`/repos/${REPO}/issues?state=open&per_page=30`);
  if (!res.ok) return null;
  const list = await res.json();
  const fresh = Date.now() - 12 * 3600 * 1000;
  return list.find((i) => {
    if (i.pull_request || !i.title.includes(NAME)) return false;
    /*
     * **只认 `[sync]` 请求。**（2026-11-07 修）
     *
     * 原来只要标题含包名就算「已经有人在同步了」，结果把
     * `[report] coopani-world-journey: Sync workflow 卡在 429` 那份故障报告
     * 当成了待处理的同步请求 —— 脚本于是安静地等一个永远不会更新 catalog 的 issue。
     * 同一天仓库里还有 `[bug]` / `[other]` 开头的同包名 issue，都得排掉。
     */
    if (!/\[sync\]|\[同步\]|\[sync\]\[retry/i.test(i.title)) return false;
    /* 半天以前的 open 请求已经死了（上游早该跑过好几轮），不该挡住新的这次。 */
    if (new Date(i.created_at).getTime() < fresh) return false;
    const hasVer = /\d+\.\d+\.\d+/.test(i.title);
    return !hasVer || i.title.includes(VERSION);
  }) ?? null;
}

async function openIssue() {
  const mine = await pendingIssue();
  if (mine) {
    say(`· 已有 open 的同步请求 #${mine.number}，不再重复开`);
    return mine;
  }
  const res = await gh(`/repos/${REPO}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: `[sync] ${NAME} ${VERSION}`,
      body: `package: ${NAME}\nversion: ${VERSION}\n\n发版后市场未收录，自动补一次同步。`,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    /* 403 多半是这个 token 没有 issues:write —— 直接说清楚，别让人以为同步过了 */
    throw new Error(`开 issue 失败 ${res.status}：${text.slice(0, 200)}`);
  }
  const issue = await res.json();
  say(`· 已开同步请求 #${issue.number}`);
  return issue;
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  say(`盯 ${NAME}@${VERSION}（超时 ${TIMEOUT_S}s，最多触发 ${ATTEMPTS} 次）`);
  if (ATTEMPTS === 0) {
    say('· 只盯不触发：cron 每半小时（:17 / :47）自己会跑，多开一次 issue 不加成功率，');
    say('  只会让那条已经被封的 IP 多打一轮请求。真要开一次，传 --attempts 1。');
  }
  let now = null;
  try {
    now = await listedVersion();
  } catch {
    say('· 首次读线上失败（网络），先按「未收录」往下走');
  }
  say(`· 线上现在是 ${now ?? '（还没收录这个包）'}`);
  if (now && cmp(now, VERSION) >= 0) {
    say('✓ 已经收录，不用动');
    return 0;
  }
  if (DRY) {
    say('（--dry：只看，不触发）');
    return 1;
  }

  const deadline = Date.now() + TIMEOUT_S * 1000;
  let attempt = 0;
  /*
   * 本进程开过的那一个 issue。**必须记住它**：列表接口对刚创建的 issue
   * 有几十秒的最终一致性，`pendingIssue()` 有时候读不到它 ——
   * 现实中因此给 0.9.3 连开了 #794 和 #795。按编号直查是准的。
   */
  let opened = null;
  while (Date.now() < deadline) {
    if (attempt < ATTEMPTS) {
      let stillOpen = false;
      if (opened) {
        const res = await gh(`/repos/${REPO}/issues/${opened}`);
        if (res.ok) stillOpen = (await res.json()).state === 'open';
      }
      if (!stillOpen) {
        const issue = await openIssue();
        opened = issue?.number ?? opened;
      }
      attempt += 1;
      /* 一次 run 的 `Scan npm` 大约 30 秒，加上排队，给两分半再看 */
      await sleep(150_000);
    } else {
      await sleep(60_000);
    }
    try {
      now = await listedVersion();
    } catch {
      say(`· [${new Date().toISOString().slice(11, 19)}] 这一轮没读到线上版本，继续等`);
      continue;
    }
    say(`· [${new Date().toISOString().slice(11, 19)}] 线上 ${now ?? '未收录'}`);
    if (now && cmp(now, VERSION) >= 0) {
      say(`✓ 收录完成：${now}`);
      return 0;
    }
  }
  say(`✗ 超时。线上仍是 ${now ?? '未收录'} —— 上游 scan 大概率又被 api.npmjs.org 429 挡了，`);
  say('  这不是我们的包的问题。CRON 每半小时（:17 / :47）还会再试，也可以稍后重跑本脚本。');
  return 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('✗', e.message);
  process.exit(2);
});
