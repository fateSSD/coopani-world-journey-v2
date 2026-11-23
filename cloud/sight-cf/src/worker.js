/**
 * 碰面服务器 · Cloudflare Workers 版。
 *
 * 和 `cloud/sight/index.js`（腾讯云开发 + PostgreSQL 版）**接口完全一样**：
 * 同一个 `GET /sight?city=&date=&slot=&exclude=`，同一个 `POST /sight {uid,pet,city,date,slot,doing}`。
 * 客户端只要把地址从 `xxx.tcloudbase.com` 换成 `xxx.workers.dev`，别的一个字都不用改。
 *
 * ## 为什么搬到 Workers
 *
 * 腾讯云开发免费版一个月只有 3000 资源点（约 1000 次调用）。一万用户里只要有
 * 两千人开了碰面，一天就是一万两千次请求 —— 免费额度撑不到两个小时。
 * Workers 免费 10 万请求/天、D1 免费 10 万行写入/天，同样的量占 12% 左右。
 *
 * **注意：必须配 D1，不能用 KV。** KV 免费只给 1000 次写入/天，
 * 一次上报写一条就爆了。这是 Cloudflare 免费额度里最大的一个坑。
 *
 * ## 两条不能破的规矩（从旧版继承）
 *
 * 1. **只回宠物名和在干嘛。** 别人的 uid、上报时间、任何能拿来联系的东西都不出这个函数。
 *    设计上就不是社交 —— 看得见，摸不着。
 * 2. **只按「城 + 日 + 时段」查。** 不接受模糊查询、不接受按 uid 查别人的轨迹。
 *
 * ## 这一版新加的：限速
 *
 * 旧版没有任何防刷。五个人的时候无所谓，一万人的时候必须堵 —— uid 是本地随机的，
 * 谁都能伪造。更彻底的办法是给客户端发 token 做签名，但那要改客户端；
 * token 字段已经在表里留好了（`token_hash`），以后客户端升级直接填。
 *
 * ## 三条闸都按「天」算，且都是 O(1)
 *
 * - `u:<uid>:<day>` —— 一个宠物一天最多 50 次。正常人 4–8 次，这一档只挡脚本。
 * - `i:<ip>:<day>`  —— 一个出口 IP 一天最多 2000 次。按公司 NAT 五十人 × 24 次算还差一半。
 * - `d:<day>`       —— 全站一天 5 万次，最后的硬顶。
 *
 * ## 为什么不是「两次上报间隔 20 秒」
 *
 * 第一版是那么写的，跑起来才发现两个毛病：
 *
 * 1. **粒度错了。** 她的行程里同一天换城市、换时段各报一次是**合法的**，
 *    但按 uid 算间隔会把这些正常上报一起挡掉，而且客户端是 `void` 调用，
 *    挡了没人知道 —— 那一格就静默缺了。
 * 2. **防重复本来就不需要它。** 写入是 upsert（主键 uid+city+date+slot），
 *    重复报同一格只是覆盖同一个值，天然幂等。真正要防的是「刷出大量不同的格」。
 *
 * ## 为什么不是 `COUNT(*)`
 *
 * 第一版三条闸全用 `COUNT(*) FROM presence WHERE ...`。执行计划很漂亮
 * （走 covering index，没有全表扫描），但**走索引不等于不花钱** ——
 * `COUNT` 范围内有多少行就要读多少行。实测表里 8 万行时每次 POST 读 8 万行，
 * D1 免费版一天 500 万行读取，**62 次上报就烧光**。
 *
 * 也就是说：那道「防止刷爆额度」的闸，本身就是最大的刷子。换成计数表后一次判定读 1 行。
 */

/** 时段白名单。和扩展里的 `slotOf()` 必须一致，改一边记得改另一边。 */
const SLOTS = new Set(['morning', 'afternoon', 'evening', 'night']);
/** 一次最多回几个 —— 加上查询方自己正好四个。 */
/*
 * 管鱼页由这个 Worker 自己发（`/pets`）。
 *
 * 内容是 `site/pets.html` 的生成物（`pets-page.js`，见 `build-pets.mjs`）。
 * 不走 wrangler 的 Text rule：那样 node 跑测试时 import 不到 .html，整套 worker 测试会挂。
 */
import petsPage from './pets-page.js';

const MAX = 3;
const MAX_NEIGHBOR_LIMIT = 20;

/** 一个宠物一天的写入上限。正常人一天 4–8 次，50 是给反复调试留的余量。 */
const UID_PER_DAY = 50;
/** 一个出口 IP 一天的写入上限。公司 NAT 五十人一天也就一千二，取两千。 */
const IP_PER_DAY = 2000;

/*
 * ## 每日硬顶为什么按「行」算，不按「次」算
 *
 * D1 免费额度的单位是**行**（10 万行写入/天），不是请求数。
 * 而一次上报要写 4 行：presence 一条 + rate 三条。
 *
 * 第一版直接拿「8 万次」当上限（那是旧版 `COUNT(*) FROM presence` 的口径，
 * 一次上报只写 1 行）。换成计数表之后每次写 4 行，同样 8 万次就是 **32 万行** ——
 * 超额度三倍。**阈值没变，但它的单位偷偷变了。**
 *
 * 现在按行算，再除以每次的行数，以后改写入行数会自动跟着变。
 */
const DAILY_ROW_BUDGET = 80_000;   // 10 万额度留 20% 给定时清理
const ROWS_PER_POST = 4;           // presence 1 + rate 3
const DAILY_WRITE_CAP = Math.floor(DAILY_ROW_BUDGET / ROWS_PER_POST);   // = 20000 次

/** 历史数据保留天数。查询只用到今天和昨天，四天足够宽松。 */
const KEEP_DAYS = 4;
/** 一次清理最多删几行 —— 分批删，别让一次 cron 撞上执行时间上限。 */
const PURGE_BATCH = 5000;

/*
 * 表里有两个时间，别混用。
 *
 *   `date_key`  **她那边的游戏日期**。世界时钟跑 24 倍，跑上几天的鱼早就到 2027 年了。
 *   `at`        服务端写进去的**真实上报时刻**，跟谁的游戏进度无关。
 *
 * 2026-11-10 的 bug 就出在拿真实日期去比 `date_key`：
 * 「今天多少只」数的是「游戏内日期恰好等于现实今天」那一小撮，
 * 来多少新上报都不会动 —— 面板上的数字就这么卡死在 19。
 * 当天真实上线的是 174 只。
 *
 * 凡是「今天 / 最近 / 留存」这类**现实时间**的口径，一律用 `at`。
 * 只有「同城同日同时段还有谁」这种**她自己那套日历**的查询才用 `date_key`。
 */

/*
 * 「今天」按北京时间算，不是 UTC。
 *
 * 用户都在国内，UTC 零点等于北京早上八点 —— 凌晨 0 点到 8 点上过线的鱼会被算进
 * 「昨天」，早上打开面板看到一个明显偏小的数字。2026-11-10 一并修掉。
 */
const CN_OFFSET_MS = 8 * 3_600_000;
const todayStartIso = () => {
  const shifted = Date.now() + CN_OFFSET_MS;
  const midnight = Math.floor(shifted / 86_400_000) * 86_400_000 - CN_OFFSET_MS;
  return new Date(midnight).toISOString();
};

/*
 * 「在线」= 最近 30 分钟有过上报。
 *
 * 客户端每 20 分钟一次心跳（`world.ts` 的 `HEARTBEAT_MS`），所以正常在线的鱼
 * 一定落在窗口里，留 10 分钟给一次失败的请求重来。
 *
 * **别再把这个数叫做「今天多少只」。** 一个人今天来过、现在关掉了，那是「今天来过」，
 * 不是在线 —— 2026-11-10 Mr.Q 问「我的鱼有两只，何来一只在线」，就是这个词用错了。
 */
const ONLINE_WINDOW_MS = 30 * 60_000;
const onlineSinceIso = () => new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();

/*
 * `pool` / `online` 两个数 —— **贵的那个缓存 15 分钟，便宜的那个每次现算**（2026-11-14）。
 *
 * ## 修了三次才找对靶子
 *
 * 11-10 改成每次请求现算 → 读行数从 168 万涨到 575 万，连穿三天额度。
 * 11-12 修成「一次扫描 + 5 分钟缓存」→ 11-13 第一个跑满全天的日子，**583 万，更高**。
 * 11-13 又改成「pool 长缓存 + online 现算」→ 还是不够。
 *
 * 三次都在调「扫多少次」。真正的问题是「每次扫多少行」：
 * `COUNT(DISTINCT uid) ... WHERE at >= ?` 被优化器选中 `idx_presence_uid` ——
 * 它是覆盖索引，但按 `uid` 排序，`at >= ?` 定位不了起点，**只能全索引扫到尾**。
 * 表里 1,647 行，每次读 1,663 行。换成 `(at, uid)` 索引后只读 **57 行**，差 29 倍。
 *
 * 索引那半在 schema.sql 的 `idx_presence_at_uid`，查询侧用 `INDEXED BY` 强制指定
 * （优化器不会自己选它）。下面是次数那半，两半配合着用：
 *
 * - `poolToday`（今天来过多少只）：扫今天全部行 —— **15 分钟一算，96 次/天**。
 *   它是个日粒度的数（一天只增不减），滞后一刻钟看不出来。窗口不敢放长：
 *   跨零点后的第一次计算结果是「刚过午夜只有几只」，缓存一小时就会跟
 *   `online` 的八十几只并排显示，看着像坏了。
 * - `onlineNow`（此刻在线多少只）：只扫最近 30 分钟 —— **每次现算**，必须实时。
 *
 * 拆开之后，在线窗口的午夜跨天问题也自动没了：它自己从「30 分钟前」开始扫，
 * 不必跟 `pool` 共用一个起点。
 *
 * **缓存 key 带「时间片」，不靠 max-age 过期。** Cache API 对 put 进去的响应
 * 是否遵守 cache-control 各环境不一致，指望它过期就有「缓一整天不更新」的风险。
 * 时间片是确定性的：换一片就是换一个 key。
 *
 * `caches` 在本地 node 测试里不存在 —— 先判一下，没有缓存也必须算得对。
 */
const POOL_CACHE_MS = 15 * 60_000;

/** 今天来过多少只。要扫今天全部行，贵 —— 15 分钟缓存一次。 */
async function poolToday(db, ctx) {
  const cache = typeof caches === 'object' && caches.default ? caches.default : null;
  const key = new Request(`https://sight-count.internal/v2/${Math.floor(Date.now() / POOL_CACHE_MS)}`);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const j = await hit.json().catch(() => null);
        if (j && Number.isFinite(j.pool)) return { pool: j.pool, cache: 'hit' };
      }
    } catch {
      // 缓存层异常时降级直查 D1，不拖垮接口
    }
  }

  const row = await db.prepare(
    'SELECT COUNT(DISTINCT uid) AS n FROM presence INDEXED BY idx_presence_at_uid WHERE at >= ?1',
  ).bind(todayStartIso()).first();
  const pool = Number(row?.n ?? 0) || 0;

  if (cache) {
    const putTask = Promise.resolve()
      .then(() => cache.put(key, new Response(JSON.stringify({ pool }), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': `public, max-age=${Math.round(POOL_CACHE_MS / 1000)}`,
        },
      })))
      .catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(putTask);
    } else {
      await putTask;
    }
  }
  return { pool, cache: 'miss' };
}

/** 此刻在线多少只。只扫最近 30 分钟，便宜到可以每次现算。 */
async function onlineNow(db) {
  const row = await db.prepare(
    'SELECT COUNT(DISTINCT uid) AS n FROM presence INDEXED BY idx_presence_at_uid WHERE at >= ?1',
  ).bind(onlineSinceIso()).first();
  return Number(row?.n ?? 0) || 0;
}

async function poolAndOnline(db, ctx) {
  const [poolRes, online] = await Promise.all([poolToday(db, ctx), onlineNow(db)]);
  return { pool: poolRes.pool, online, cache: poolRes.cache };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  /*
   * `x-admin-key` 必须列在这里 —— 管理页面是跨域打过来的，
   * 自定义头会触发预检，预检说这个头不允许，浏览器就不会发真正的请求。
   * 症状是「明明密钥对了却一直连不上」。
   */
  'access-control-allow-headers': 'content-type, x-admin-key',
  'access-control-max-age': '86400',
};

const reply = (status, body, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  // 接口数据一律不缓存：改名之后要立刻看到新名字，不能被浏览器或边缘拿旧响应糊过去。
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...extraHeaders },
});

/* ------------------------------------------------------------------
 * 扩展市场索引的国内镜像
 *
 * ## 为什么要有这个
 *
 * 宿主读索引的超时是**硬编码**的：raw.githubusercontent.com 3 秒、GitHub API 5 秒。
 * 国内直连 raw 实测 2.2 秒 —— 余量不到一秒，网络抖一下就整片市场读不出来。
 * 2026-11-06 Mr.Q 那台就是从 11-05 晚上起一直失败，界面停在旧索引上。
 *
 * 这个 Worker 跑在 Cloudflare 上，访问 GitHub 快；国内访问它又快（同一个域名）。
 * 于是把索引反代一遍，宿主把索引源指过来。jsDelivr 试过：命中缓存 0.3 秒，
 * 但**回源要 11 秒**，purge 之后照样超时，不可用。
 *
 * **只放行索引仓里那几类路径** —— 不做开放式反代，免得被人当免费代理用。
 * 边缘缓存 5 分钟：索引是 Action 生成后推到 main 的，5 分钟延迟没有影响。
 * ------------------------------------------------------------------ */

const MARKET_UPSTREAM = 'https://raw.githubusercontent.com/Pal-AI-Lab/cortico-extensions/main';
/** index.json / catalog.json / packages/*.json / comments/*.json / icons|screenshots/*。 */
const MARKET_PATH = /^\/(?:index|catalog)\.json$|^\/(?:packages|comments)\/[a-z0-9._-]+\.json$|^\/(?:icons|screenshots)\/[A-Za-z0-9._\/-]+$/i;

async function marketProxy(path, ctx) {
  if (!MARKET_PATH.test(path)) return reply(404, { ok: false, error: 'not found' });
  /*
   * 用 Cache API 显式缓存，**不用** fetch 的 `cf.cacheTtl`。
   *
   * 实测：`cf: { cacheTtl, cacheEverything }` 对 catalog.json（750KB）不生效，
   * 每次都回源，稳定在 3 秒上下 —— 而宿主那边的超时正好是 3 秒。
   * Cache API 对单个响应的体积限制宽得多，缓存住之后就是几十毫秒。
   *
   * `caches` 在本地 node 测试里不存在，所以要先判一下。
   */
  const cache = typeof caches === 'object' && caches.default ? caches.default : null;
  const key = new Request(`https://market-cache.internal/v2${path}`);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }

  let upstream;
  try {
    upstream = await fetch(MARKET_UPSTREAM + path);
  } catch {
    return reply(502, { ok: false, error: 'upstream' });
  }
  if (!upstream.ok) return reply(upstream.status, { ok: false, error: 'upstream' });
  const type = path.endsWith('.json') ? 'application/json; charset=utf-8'
    : path.endsWith('.png') ? 'image/png'
      : path.endsWith('.webp') ? 'image/webp'
        : 'application/octet-stream';
  /*
   * **不要自己 gzip。**
   *
   * 试过：Workers 里 `new Response(gzBytes, { headers: { 'content-encoding': 'gzip' } })`
   * 出来之后 Cloudflare 会把那个 header **剥掉**，body 仍是压缩过的字节 ——
   * 客户端按 JSON 解析就是语法错误。这比读不到更糟：读不到还有缓存兜底，读坏了没有。
   *
   * 明文直出，体积交给 Cloudflare（它会按 content-type 自己压）。
   */
  const out = new Response(await upstream.arrayBuffer(), {
    status: 200,
    headers: {
      'content-type': type,
      // 索引文件更新频率是「Action 跑一次才变」，但 CF 对 .json 有自己的默认缓存；
      // 写短一点，免得发了新版四个小时看不到。
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });
  if (cache && ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}

const okUid = (v) => typeof v === 'string' && /^[a-f0-9]{20,64}$/i.test(v);
const okCity = (v) => typeof v === 'string' && /^[a-z0-9_-]{1,40}$/i.test(v);
const okDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * 「这一带还有谁」看多久以内报过的（2026-11-10）。
 *
 * 原来是同城 + 同日 + 同时段三重与，而那个「日」是 `date_key` —— **各人自己的游戏内日期**。
 * 世界时钟按 24 倍速跑，同一刻线上同时存在 2026-11-10、2026-11-12、2027-03-07，
 * 两条鱼差几天到几个月是常态，于是这行几乎永远返回空。
 * 2026-11-10 实测：他女儿在昆明，`/sight?...&date=2026-11-10&slot=afternoon` 回 `list: []`，
 * 而池子里有 7 只在跑。
 *
 * 改成按 `at`（真实写入时刻）划一个窗口 —— 跟「现实时间口径一律用 `at`」同一条线。
 * `slot` 留着：4 个值撞得上，而且它担着语义（凌晨三点不该说「她也在这一带」）。
 */
const RECENT_NEIGHBOR_MS = 2 * 3600_000;
const MAX_NEIGHBOR_WINDOW_MS = 24 * 3600_000;
const clean = (v, max) => String(v == null ? '' : v)
  .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

/* ------------------------------------------------------------------
 * 宠物名和「在干嘛」的清洗
 *
 * ## 为什么必须在服务端做
 *
 * 客户端改一行就能跳过过滤。一万用户的规模下，「有人把名字改成广告蹲在
 * 热门城市」是**必然会发生**的事，不是可能性 —— 而宠物名是唯一展示给
 * 陌生人的字段。
 *
 * ## 为什么是「换掉」而不是「拒绝」
 *
 * 拒绝会让那只鱼彻底从别人屏幕上消失，用户完全不知道为什么 ——
 * 他只会以为「碰面坏了」，然后来找你。换成中性名字她还在，
 * 只是别人看到的不是他填的那个。恶意名字本来也不该出现在别人屏幕上，
 * 这个代价是合理的。
 *
 * ## 词表为什么这么短
 *
 * 中文没有词边界，用「包含匹配」查脏话，词越短误伤越大（「沙」会撞「长沙」）。
 * 所以只收**多字、无歧义**的。这份表故意不全 —— 靠 `BANNED_WORDS`
 * 环境变量按反馈往上加，比在代码里堆一份大表更实际，也更好维护。
 * ------------------------------------------------------------------ */

/** 被判为广告/脏话时换成的名字。中性，不像占位符，也不跟世界观冲突。 */
const FALLBACK_PET = '一只鱼';

/** 内置最小词表。只收多字、无歧义的，单字一概不收。 */
const BAD_WORDS = [
  '傻逼', '煞笔', '操你', '草你', '尼玛', '你妈死', '滚你妈', '滚蛋', '去死',
  '卖片', '约炮', '裸聊', '代开发票', '办证', '刷单', '招代理',
];

/** 广告与联系方式的「形状」。这些不用词表，模式就认得出来。 */
const AD_PATTERNS = [
  /https?:\/\//i,
  /www\./i,
  /\b[a-z0-9-]{2,}\.(com|cn|net|org|top|xyz|vip|cc|me|shop|site|link)\b/i,
  /(微信|威信|薇信|vx|wx|weixin|qq|扣扣|企鹅)\s*[:：]?\s*[a-z0-9_-]{2,}/i,
  /(私聊|加我|联系我|扫码|返利|优惠券|代购|微商)/,
  /\b1[3-9]\d{9}\b/,   // 手机号
  /\b\d{6,11}\b/,      // QQ 号那一档。6 位起，「海拔 3000 米」这种四位数不会中
];

/** 额外的词表，部署时用 `wrangler secret put BANNED_WORDS` 配，逗号分隔。 */
function bannedExtra(env) {
  return String(env?.BANNED_WORDS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 这个名字能不能直接给人看。 */
function looksBad(s, extra) {
  if (!s) return false;
  if (/(.)\1{3,}/.test(s)) return true;   // 「啊啊啊啊」刷屏式占位
  for (const p of AD_PATTERNS) if (p.test(s)) return true;
  const low = s.toLowerCase();
  for (const w of BAD_WORDS) if (low.includes(w)) return true;
  for (const w of extra) if (low.includes(w)) return true;
  return false;
}

/**
 * 洗宠物名。`flagged` 表示被换过 —— 调用方据此记日志，
 * 但**不回给客户端**（不想让人拿它来试探词表边界）。
 */
function safePet(raw, extra) {
  const s = clean(raw, 24);
  if (!s) return { name: '', flagged: false };
  if (looksBad(s, extra)) return { name: FALLBACK_PET, flagged: true };
  return { name: s, flagged: false };
}

/**
 * 「在干嘛」也给别人看，同一套判断。
 * 被换掉就留空 —— 空的时候那句话会退化成「也在这一带」，比挂个假动作自然。
 */
function safeDoing(raw, extra) {
  const s = clean(raw, 40);
  if (!s) return '';
  return looksBad(s, extra) ? '' : s;
}

/* ------------------------------------------------------------------
 * 本城设定（2026-11-15）
 *
 * ## 为什么这件事在服务器上，而别的都在客户端
 *
 * 前面所有东西都是「每只鱼自己的」—— 行踪、名片、足迹、路标。
 * 唯独「这座城叫什么、有哪几条街、守哪几条城规」不属于任何一只鱼，
 * 它属于**这台服务器**。放进某只鱼的客户端，它就成了她的私人设定，
 * 而它明明是大家共用的那个地方。
 *
 * ## 默认值只写这一份
 *
 * 服务端没被设过时返回它，管理页首次打开也从它开始填。
 * 客户端不许各自写一份 —— 改默认值要改三处就是 bug 的温床。
 * ------------------------------------------------------------------ */

/** 本城设定的街道与城规各最多几条。需与前端 `site/pets.html` 的 `SLOTS` 一致。 */
const TOWN_LIST_MAX = 20;

const TOWN_DEFAULTS = {
  id: 'lanzhou',
  name: '兰州',
  /*
   * 来历（2026-11-21 定城兰州）。
   * ⚠ 这份要和客户端 `coopani-world-life/src/bridge.ts` 的 `BUILTIN_TOWN` 一致，
   * 两边都改才不漂。
   */
  origin: '黄河自西向东穿城，两岸黄土山梁夹着长长一溜灯火，铁桥横在河面上。'
    + '早上出门沿着河边走两步就能吃碗热面，晚上不管走多远，望见河谷里的灯就知道到家了。',
  /* 默认四条街，生活层按此落址并统计同城居民。 */
  streets: ['南滨河路', '张掖路', '皋兰路', '雁滩路'],
  /*
   * 四条城规 —— 第一条对应底线（不吃同类），后三条各自对应一条机制，不是装饰：
   *   货不过夜              → stalls 3 天过期、qty 会坏
   *   价自己定              → 回执不带金额，定价权在卖方
   *   赊账记在心里不记账上  → 货跨机、钱本地、不设中心账本
   * 改文案可以，别改意思 —— 改了意思，她按城规过日子就不再等于按规则过日子。
   */
  rules: ['河里的不吃河里的', '货不过夜', '价自己定，别人说贵你就听着', '赊账记在心里，不记在账上'],
};

/**
 * 城名 / 街名 / 城规都要给别人看，和宠物名同一套判断，只是长度不同。
 * 被判定有问题就留空，由调用方退默认 —— **不把脏字替换成「某城」那种假名**，
 * 城名和宠物名不一样：宠物名换掉她还在，城名换掉整座城都叫错了。
 */
function safeText(raw, max, extra) {
  const s = clean(raw, max);
  if (!s) return '';
  return looksBad(s, extra) ? '' : s;
}

/** 把库里那一行（或者没有）整理成一份能用的设定：缺的补默认，脏的整条丢掉。 */
function normTown(row, env) {
  const extra = bannedExtra(env);
  const d = TOWN_DEFAULTS;
  const arr = (v, max, n) => {
    let list = [];
    try {
      const parsed = JSON.parse(String(v || '[]'));
      if (Array.isArray(parsed)) list = parsed;
    } catch { /* 存坏了就当没有 —— 退默认比抛出去好，这是展示用的数据 */ }
    return list.map((x) => safeText(x, max, extra)).filter(Boolean).slice(0, n);
  };
  const id = okCity(row?.id) ? clean(row.id, 40) : d.id;
  const name = safeText(row?.name, 24, extra) || d.name;
  const streets = arr(row?.streets, 12, TOWN_LIST_MAX);
  const rules = arr(row?.rules, 60, TOWN_LIST_MAX);
  return {
    id,
    name,
    origin: safeText(row?.origin, 400, extra) || d.origin,
    streets: streets.length ? streets : d.streets.slice(),
    rules: rules.length ? rules : d.rules.slice(),
    at: row?.at || '',
    /*
     * `custom` = 表里真有这一行。
     * 没有的时候页面要明说「现在看到的是默认值，还没存过」——
     * 不然服务器主会以为自己早就设过了。
     */
    custom: !!row,
  };
}

/**
 * 读本城设定。
 *
 * **三种失败都退默认，不报错**：表没建、库没连、行没了。
 * 理由是它的用途是「显示这座城叫什么」—— 显示不出城名比显示一个默认城名更糟，
 * 而 `custom: false` 已经诚实说明了「这不是你设的那个」。
 */
async function readTown(db, env) {
  if (!db) return normTown(null, env);
  try {
    const row = await db.prepare(
      'SELECT id, name, origin, streets, rules, at FROM town_meta ORDER BY at DESC LIMIT 1',
    ).first();
    return normTown(row, env);
  } catch {
    return normTown(null, env);
  }
}

/** 一个宠物一天最多发几条邀约。正常人一周也发不了一条，3 是给调试留的。 */
const INVITE_PER_DAY = 3;
/** 一天最多接几条。接多了等于把行程排满，那不是「一起玩」，是赶场。 */
const ACCEPT_PER_DAY = 1;
/** 邀约挂多久。过期不通知任何人 —— 不回应就是没看见，不该构成一次「被拒绝」。 */
const INVITE_TTL_MS = 24 * 3_600_000;

/** 某个计数 key 今天用了多少。 */
async function rateOf(db, key) {
  const row = await db.prepare('SELECT n FROM rate WHERE key = ?1').bind(key).first();
  return Number(row?.n ?? 0);
}

/** 记一次。窗口按 UTC 日期天然切，跨天换 key 从 1 重新数。 */
async function bumpRate(db, key, day) {
  const expSec = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + 86_400;
  await db.prepare(
    `INSERT INTO rate (key, n, exp) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET n = rate.n + 1`,
  ).bind(key, expSec).run();
}

/* ------------------------------------------------------------------
 * 错误计数（2026-11-14）
 *
 * 11-12 那次全站 500，Worker 侧一个字都没留，用户替我们查了一整天。
 * 之后各处补了 `console.error` —— 但那是**实时日志**：没人天天翻 dashboard，
 * 事后也看不出趋势。这张表补的是「这一小时哪个接口在报错、报了哪种、多少次」。
 *
 * ## 为什么不是每次错误写一行
 *
 * D1 写入按行计费。错误风暴恰恰是最需要记录的时候，也最容易把额度打爆
 * （全站 500 → 每个请求都报错 → 一次事故烧掉整个月的写额度）。
 * 所以写入前有一道**进程内闸**：同一 tag 每分钟最多写一次，之后靠 count+1 累加。
 * 写入量上限 = 错误种类数 × 60/小时。
 *
 * 闸在三处会失效（isolate 重启、跨节点、冷启动），失效的后果是**多写几行**
 * 而不是漏记 —— 这个方向是对的。
 * ------------------------------------------------------------------ */

/** tag → 上次写入的时刻。isolate 级，重启即清空。 */
const ERR_SEEN = new Map();
/** 同一个 tag 最快多久写一次。60 秒：够把风暴压平，又不至于漏掉一整段故障。 */
const ERR_MIN_GAP_MS = 60_000;
/** 最多记多少种 tag，防止某类未知异常刷出无数种。 */
const ERR_MAX_TAGS = 40;

/**
 * 记一次错误。
 *
 * `console.error` 照旧留一份（dashboard 一眼能看到），落库那份是给趋势用的。
 * 记账本身失败**绝不能再抛** —— 否则一个错误变成两个。
 */
function recordError(env, ctx, tag, err, path) {
  const msg = String(err && err.message ? err.message : err ?? '').slice(0, 200);
  console.error(tag, msg);
  try {
    const db = env?.DB;
    if (!db || ERR_SEEN.size > ERR_MAX_TAGS) return;
    const now = Date.now();
    if (now - (ERR_SEEN.get(tag) ?? 0) < ERR_MIN_GAP_MS) return;
    ERR_SEEN.set(tag, now);
    const iso = new Date().toISOString();
    const p = db.prepare(
      `INSERT INTO errors (day, hour, path, tag, count, last_msg, last_at)
       VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)
       ON CONFLICT(day, hour, path, tag) DO UPDATE SET
         count = errors.count + 1,
         last_msg = excluded.last_msg,
         last_at = excluded.last_at`,
    ).bind(iso.slice(0, 10), iso.slice(0, 13), path || '', tag, msg, iso).run();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p.catch(() => {}));
    else p.catch(() => {});
  } catch {
    /* 记账失败静默 —— 它不该影响任何正常路径。 */
  }
}

const newId = () => [...crypto.getRandomValues(new Uint8Array(8))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * 邀约。**服务端完全不懂语义** —— 它只存「谁、从哪、想去哪、几天、一句话」，
 * 和「这条被谁接了」。
 *
 * 想不想去、凭什么判断、要不要回应，全在模型那边。这里一旦开始做撮合判断，
 * 就得有用户关系、权限、审核，那是另一个量级的东西。
 */
/**
 * 一条邀约最多几个人一起走（**含发起者**）。
 *
 * 2026-11-05 之前一条邀约只能被一个人接，三只鱼同城时总有一只没位置 ——
 * 用户原话：「两两配对总有一个鱼会单出来」。
 *
 * 2026-11-06 从 4 提到 6：Mr.Q 有两只鱼（两台电脑），本机那只的邀约已经满员，
 * 另一只从成都方向过来却挤不进去 ——「不想让她伤心」。四条鱼一车是他自己提过的场景，
 * 六个人（含发起者）刚好是一辆七座车的量。
 *
 * 不再和 `MEET_MAX = 4` 绑定：「同城能看见几只」和「一趟能带几个人」本来就不是一件事，
 * 绑在一起会让「看得见但加不进」变成常态。
 */
const MAX_PARTY = 6;

/* ------------------------------------------------------------------
 * 同行卡（2026-11-11，Discussion #586）
 *
 * 用户来信：「约到一起的那几天里，让同行的伙伴能留下一个号，或者留一句话。
 * 不用多复杂，能让我在别处说一句「我在」就够了。」
 *
 * ## 和 `AD_PATTERNS` 的正面冲突 —— 这条要看清
 *
 * 上面那套过滤把「微信号 / QQ / 手机号」当成广告特征，`safeDoing` 一撞就清空。
 * 而这张卡的字面功能就是**留一个号**。两条规则直接对撞，不是漏了。
 *
 * 为什么最后决定为卡片开一个口子：
 *
 * 1. **可见范围根本不同。** `doing` 是给同城任何一只鱼看的（公开广场），
 *    卡片只有同一段同行的 ≤5 个人取得到 —— 他们要一起走几天，本来就会互相知道。
 * 2. **不留号，这个功能就没有意义。** 只留一句「她的话」，散了还是找不着人。
 * 3. **口子是可关的。** `CARD_ALLOW_CONTACT` 一改 false 就退回老策略，
 *    线上真出问题不用改结构。
 *
 * 放开的是**联系方式那一格**，不是全部：`note` 仍然按 `looksBad` 洗，
 * 两个字段都禁 URL —— 链接能钓鱼，而且它比号传播得远得多。
 * ------------------------------------------------------------------ */

/** 卡片活多久。散伙之后还能找，所以比邀约（24 小时）长得多。 */
const CARD_KEEP_DAYS = 30;

/** 卡片能不能留联系方式。关掉就退回「联系方式也算广告」的老策略。 */
const CARD_ALLOW_CONTACT = true;

/** 她写的那句话的上限。跟 `doing` 同档就够，再长就成小作文了。 */
const CARD_NOTE_MAX = 40;

/** 联系方式那一格的上限。一个微信号/手机号远用不到 40 个字。 */
const CARD_CONTACT_MAX = 40;

/** 一天最多留几张。正常一段同行留一张，5 是给重试和手滑留的。 */
const CARD_PER_DAY = 5;

/** 名片多长。够写一句自我交代 + 一两个外部 id，再长就成小作文了。 */
const PROFILE_MAX = 120;

/** 名片活多久。和卡同一个尺度 —— 用户不用记两套规矩。 */
const PROFILE_KEEP_DAYS = 30;

/**
 * 洗名片那一段字。
 *
 * 和 `safeContact` 同一套判断，只是长了点：**不套 `AD_PATTERNS`**。
 * 名片的意义就是让人找到你，把「微信号 / QQ / 花语乡 id」清掉等于把功能清掉。
 * 但**继续禁 URL** —— 号是给发生过关系的人用的，链接是给所有人用的。
 */
function safeProfile(raw, extra) {
  const s = clean(raw, PROFILE_MAX);
  if (!s) return '';
  if (/https?:\/\//i.test(s) || /www\./i.test(s)) return '';
  if (/(.)\1{3,}/.test(s)) return '';
  const low = s.toLowerCase();
  for (const w of BAD_WORDS) if (low.includes(w)) return '';
  for (const w of extra) if (low.includes(w)) return '';
  return s;
}

/**
 * 名片（2026-11-11）。全局一张，只有**真的一起走过**的人看得见。
 *
 * ## 可见性怎么判
 *
 * 「一起走过」= 在同一份 `invites` 里出现过。三种情况都要算：
 *   ① 我们都是接单的人（`invite_takers` 同一 id）
 *   ② 我是接单的人，他是发起者
 *   ③ 我是发起者，他是接单的人
 *
 * 少算任何一种，就会有一半人「明明一起走过却看不见」——
 * 而这个问题不会报错，只会让人觉得功能时好时坏。
 *
 * ## 不做「请求-同意」
 *
 * chloveln 原本提的是「发请求 → 对方同意 → 公开」。这一版没做，理由写在
 * `schema.sql` 里那张表的注释上：她没有通知通道，一个要等下次碰面才生效的同意，
 * 比不给更让人难受。换成「一起走过」这个已经发生过的事实，不需要谁点同意。
 *
 * ## 陌生人拿不到
 *
 * 这就是「和碰面同一条线」的延续：能看见，摸不着 —— 而且现在**能摸到一点了**，
 * 但只对真的同路走过的人开放。
 */
async function profileRoute(request, env, url, method) {
  const db = env?.DB;
  if (!db) return reply(500, { ok: false, error: 'server error' });

  const extra = bannedExtra(env);
  const nowIso = new Date().toISOString();

  try {
    if (method === 'GET') {
      const uid = clean(url.searchParams.get('uid'), 64);
      if (!okUid(uid)) return reply(400, { ok: false, error: 'bad query' });

      /*
       * 一次查完：自己的那张 + 一起走过的人的那几张。
       *
       * 用 UNION 三个子查询求「同行过的 uid 集合」，再一次 JOIN 到 profiles ——
       * 分成多次往返会把 D1 行读和延迟都翻倍，而这里每次轮询都会调。
       */
      const rows = await db.prepare(
        `SELECT uid, pet, text, at FROM profiles
          WHERE exp > ?2 AND (
            uid = ?1 OR uid IN (
              SELECT t2.uid FROM invite_takers t1
                JOIN invite_takers t2 ON t2.id = t1.id
               WHERE t1.uid = ?1 AND t2.uid <> ?1
              UNION
              SELECT i.uid FROM invite_takers t JOIN invites i ON i.id = t.id
               WHERE t.uid = ?1 AND i.uid <> ?1
              UNION
              SELECT t.uid FROM invites i JOIN invite_takers t ON t.id = i.id
               WHERE i.uid = ?1 AND t.uid <> ?1
            )
          )
          ORDER BY at DESC LIMIT 20`,
      ).bind(uid, nowIso).all();

      const all = rows?.results ?? [];
      const mineRow = all.find((r) => r.uid === uid);
      const others = all
        .filter((r) => r.uid !== uid)
        .map((r) => ({ pet: String(r.pet ?? ''), text: String(r.text ?? ''), at: String(r.at ?? '') }));
      const mine = mineRow
        ? { text: String(mineRow.text ?? ''), at: String(mineRow.at ?? '') }
        : null;
      return reply(200, { ok: true, mine, others });
    }

    if (method !== 'POST') return reply(405, { ok: false, error: 'method not allowed' });

    let body;
    try { body = await request.json(); } catch { return reply(400, { ok: false, error: 'bad json' }); }

    const uid = clean(body?.uid, 64);
    if (!okUid(uid)) return reply(400, { ok: false, error: 'bad fields' });
    const pet = safePet(body?.pet, extra).name;
    if (!pet) return reply(400, { ok: false, error: 'bad fields' });

    /*
     * 空名字段 = 撤回。
     *
     * 用户想收回名片，不该只能等 30 天 —— 他能改，就该能清。
     */
    const text = safeProfile(body?.text, extra);
    if (!text) {
      await db.prepare('DELETE FROM profiles WHERE uid = ?1').bind(uid).run();
      return reply(200, { ok: true, cleared: true });
    }

    const exp = new Date(Date.now() + PROFILE_KEEP_DAYS * 86_400_000).toISOString();
    await db.prepare(
      `INSERT INTO profiles (uid, pet, text, at, exp)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(uid) DO UPDATE SET
         pet = ?2, text = ?3, at = ?4, exp = ?5`,
    ).bind(uid, pet, text, nowIso, exp).run();

    return reply(200, { ok: true });
  } catch (e) {
    /*
     * **这里原来是空 catch**（2026-11-14 补）。
     *
     * 同一个文件里 invite / status / accept / admin 都有 `console.error`，
     * 只有名片这两条没有 —— 于是 11-12 那天全站 D1 500，客户端只拿到一句
     * 「服务器回了 500」，而 Worker 侧一个字都没留，查了一整天。
     */
    recordError(env, null, '[sight profile]', e, '/sight/profile');
    return reply(500, { ok: false, error: 'server error' });
  }
}

/**
 * 洗「联系方式」那一格。
 *
 * 和 `safeDoing` 的区别只有一条：**不套 `AD_PATTERNS`**。
 * 词表（脏话）和刷屏判据照旧 —— 留号可以，骂人不行。
 *
 * 另外**禁 URL**：链接能钓鱼，而且一条短链能把人带到任何地方，
 * 那不是「留个号」的意思。号是给认识的人用的，链接是给陌生人用的。
 */
function safeContact(raw, extra) {
  const s = clean(raw, CARD_CONTACT_MAX);
  if (!s) return '';
  if (!CARD_ALLOW_CONTACT) return looksBad(s, extra) ? '' : s;
  // 只放行「联系方式」，不放行链接。
  if (/https?:\/\//i.test(s) || /www\./i.test(s)) return '';
  if (/(.)\1{3,}/.test(s)) return '';
  const low = s.toLowerCase();
  for (const w of BAD_WORDS) if (low.includes(w)) return '';
  for (const w of extra) if (low.includes(w)) return '';
  return s;
}

/**
 * 留一张卡，或者取同一段同行里别人留的卡。
 *
 * ## 鉴权只有一条：你是不是这段同行的人
 *
 * 判断依据是 `invite_takers`（接单表）和 `invites.uid`（发起者）。
 * 不是这两者之一，`id` 猜对了也拿不到 —— `id` 是 16 位 hex，
 * 但安全不能建立在「猜不到」上面。
 *
 * ## 什么都不返回「失败」
 *
 * 没卡就是空列表，不是错误。客户端拿去显示「这一趟没有人留卡」。
 */
async function cardRoute(request, env, url, method) {
  const db = env?.DB;
  if (!db) return reply(500, { ok: false, error: 'server error' });

  const day = new Date().toISOString().slice(0, 10);
  const extra = bannedExtra(env);
  const nowIso = new Date().toISOString();

  /** 这段同行的成员吗？是就返回 true。 */
  const inParty = async (id, uid) => {
    const own = await db.prepare('SELECT uid FROM invites WHERE id = ?1').bind(id).first();
    if (own && own.uid === uid) return true;
    const tak = await db.prepare(
      'SELECT 1 AS x FROM invite_takers WHERE id = ?1 AND uid = ?2',
    ).bind(id, uid).first();
    return !!tak;
  };

  try {
    /* ---------------- 取：同一段同行里，别人留了什么 ---------------- */
    if (method === 'GET') {
      const id = clean(url.searchParams.get('id'), 32);
      const uid = clean(url.searchParams.get('uid'), 64);
      if (!okUid(uid) || !/^[a-f0-9]{16}$/.test(id)) {
        return reply(400, { ok: false, error: 'bad query' });
      }
      if (!(await inParty(id, uid))) return reply(403, { ok: false, error: 'not in party' });

      const rows = await db.prepare(
        `SELECT uid, pet, note, contact, at FROM party_cards
          WHERE id = ?1 AND exp > ?2
          ORDER BY at ASC LIMIT 8`,
      ).bind(id, nowIso).all();

      /*
       * **不回 uid。** 谁留的是谁，客户端不需要知道 —— 名字已经够了，
       * 而 uid 一旦给出去，就能被拿去反查 presence、串起这个人所有行程。
       * 这条和 `invites` 不发 uid 是同一条线。所以下面按 uid 分完组就把它扔掉。
       *
       * 自己那张单独放 `mine`（2026-11-11）：用户改自己留的话时要能回填，
       * 混在「别人留了什么」里既读着别扭，也会让他以为多了一个人。
       */
      const all = rows?.results ?? [];
      const mineRow = all.find((r) => r.uid === uid);
      const cards = all
        .filter((r) => r.uid !== uid)
        .map((r) => ({
          pet: String(r.pet ?? ''),
          note: String(r.note ?? ''),
          contact: String(r.contact ?? ''),
          at: String(r.at ?? ''),
        }));
      const mine = mineRow
        ? {
            note: String(mineRow.note ?? ''),
            contact: String(mineRow.contact ?? ''),
            at: String(mineRow.at ?? ''),
          }
        : null;
      return reply(200, { ok: true, cards, mine });
    }

    /* ---------------- 留：写一张（重复提交就是覆盖） ---------------- */
    if (method !== 'POST') return reply(405, { ok: false, error: 'method not allowed' });

    let body;
    try { body = await request.json(); } catch { return reply(400, { ok: false, error: 'bad json' }); }

    const uid = clean(body?.uid, 64);
    const id = clean(body?.id, 32);
    if (!okUid(uid) || !/^[a-f0-9]{16}$/.test(id)) {
      return reply(400, { ok: false, error: 'bad fields' });
    }

    const pet = safePet(body?.pet, extra).name;
    if (!pet) return reply(400, { ok: false, error: 'bad fields' });
    if (!(await inParty(id, uid))) return reply(403, { ok: false, error: 'not in party' });

    /*
     * `note` 走和 `doing` 一样的清洗：它同样是「给别人看的字」。
     * 空串是正常的 —— 有的人就想留个号，不想写字。
     */
    const note = safeDoing(body?.note, extra);
    const contact = safeContact(body?.contact, extra);
    if (!note && !contact) return reply(400, { ok: false, error: 'empty card' });

    /*
     * 限流只按「第一次留」算。
     *
     * 覆盖自己那张不该扣额度 —— 用户改一个字就重发一次是正常动作，
     * 按次计数会让他十分钟内什么都改不了。所以先查有没有旧卡，
     * 有就直接更新，不走 `bumpRate`。
     */
    const had = await db.prepare(
      'SELECT 1 AS x FROM party_cards WHERE id = ?1 AND uid = ?2',
    ).bind(id, uid).first();

    if (!had) {
      const key = `cc:${uid}:${day}`;
      if (await rateOf(db, key) >= CARD_PER_DAY) {
        return reply(429, { ok: false, error: 'too many' });
      }
      await bumpRate(db, key, day);
    }

    const exp = new Date(Date.now() + CARD_KEEP_DAYS * 86_400_000).toISOString();
    await db.prepare(
      `INSERT INTO party_cards (id, uid, pet, note, contact, at, exp)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(id, uid) DO UPDATE SET
         pet = ?3, note = ?4, contact = ?5, at = ?6, exp = ?7`,
    ).bind(id, uid, pet, note, contact, nowIso, exp).run();

    return reply(200, { ok: true });
  } catch (e) {
    /* 和名片同一条（2026-11-14 补）：留卡失败也得留下是哪种失败。 */
    recordError(env, null, '[sight card]', e, '/sight/card');
    return reply(500, { ok: false, error: 'server error' });
  }
}

async function inviteRoute(request, env, url, method) {
  const db = env?.DB;
  if (!db) return reply(500, { ok: false, error: 'server error' });

  const day = new Date().toISOString().slice(0, 10);
  const extra = bannedExtra(env);

  try {
    /* ---------------- 收：同城别人发的，还挂着的 ---------------- */
    if (method === 'GET') {
      const city = clean(url.searchParams.get('city'), 40);
      const uid = clean(url.searchParams.get('uid'), 64);
      /*
       * **两条口径**（2026-11-05）：
       *   mine=1  → 「我发的、已经被人接了的」。发起者靠它知道有人应了，
       *             然后自己也往那座城走 —— 这才是「两条鱼一起去」。
       *   其余    → 别人发的、还挂着的。带 city 时同城优先（池子小的时候，
       *             只给同城等于永远没人接，所以**不再只查同城**）。
       */
      const mine = url.searchParams.get('mine') === '1';
      if (!okUid(uid)) return reply(400, { ok: false, error: 'bad query' });
      if (!mine && city && !okCity(city)) return reply(400, { ok: false, error: 'bad query' });

      const nowIso = new Date().toISOString();

      if (mine) {
        /*
         * 「我发的、已经有人接了的」。
         *
         * 一条邀约现在可以被好几个人接，所以**每个人一行** —— 发起者一次拿到全部，
         * 自己在客户端合成一句「X、Y 接了你的话」，而不是收到三次「有人接了」。
         */
        const { results } = await db.prepare(
          `SELECT t.id AS id, t.pet AS pet, t.uid AS taker_uid,
                  i.to_city AS to_city, i.days AS days, i.note AS note,
                  i.meet_city AS meet_city, i.pace AS pace
             FROM invite_takers t JOIN invites i ON i.id = t.id
            WHERE i.uid = ?1 AND t.seen = 0 AND i.expires_at > ?2
            ORDER BY t.at ASC LIMIT 12`,
        ).bind(uid, nowIso).all();

        if (results && results.length) {
          // 认领一次就勾掉，别在每次排表时反复建同一份约定。
          const ids = [...new Set(results.map((r) => r.id))];
          for (const one of ids) {
            await db.prepare('UPDATE invite_takers SET seen = 1 WHERE id = ?1 AND seen = 0').bind(one).run();
          }
        }
        const list = (results ?? []).map((r) => ({
          id: r.id,
          pet: safePet(r.pet, extra).name,            // 接的人
          to: r.to_city,
          days: Number(r.days) || 1,
          note: looksBad(String(r.note || ''), extra) ? '' : clean(r.note, 60),
          /* 见面城。空 = 老数据（那时没有这一级），客户端按「就在 to 见」处理。 */
          meet: clean(r.meet_city, 40),
          pace: Number(r.pace) || 0,
        }));
        return reply(200, { ok: true, list });
      }

      const { results } = await db.prepare(
        /*
         * 还**能进人**的邀约才返回。
         *
         * 判据从 `taken_by = ''`（一个都没接）换成「已接人数 < MAX_PARTY - 1」——
         * 这样三个人一起走之后，第四只鱼仍然看得见这条邀约、还能加进来。
         */
        `SELECT id, pet, to_city, days, note, at, meet_city, pace,
                CASE WHEN from_city = ?1 THEN 1 ELSE 0 END AS near,
                (SELECT COUNT(*) FROM invite_takers t WHERE t.id = invites.id) AS joined
         FROM invites
         WHERE expires_at > ?2 AND uid <> ?3
           AND (SELECT COUNT(*) FROM invite_takers t WHERE t.id = invites.id) < ?4
         ORDER BY near DESC, at DESC LIMIT 3`,
      ).bind(city, nowIso, uid, MAX_PARTY - 1).all();

      /*
       * **不返回发起者的 uid。** 跟碰面同一条线：能看见，摸不着。
       * 名字和「想去哪」够她判断了，多一个标识就是多一条能拿去别处用的东西。
       */
      const list = (results ?? []).map((r) => ({
        id: r.id,
        pet: safePet(r.pet, extra).name,
        to: r.to_city,
        days: Number(r.days) || 1,
        note: looksBad(String(r.note || ''), extra) ? '' : clean(r.note, 60),
        meet: clean(r.meet_city, 40),
        pace: Number(r.pace) || 0,
      }));

      return reply(200, { ok: true, list });
    }

    /* ---------------- 发 ---------------- */
    if (method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return reply(400, { ok: false, error: 'bad json' }); }

      const uid = clean(body?.uid, 64);
      const from = clean(body?.from, 40);
      const to = clean(body?.to, 40);
      const pet = safePet(body?.pet, extra).name;
      const days = Math.min(30, Math.max(1, Number(body?.days) || 1));
      /*
       * 见面城（2026-11-07，Mr.Q：「约好在哪个城市见面，然后一起走」）。
       *
       * **空字符串是合法的**，意思是「老口径：直接在目的地见」。老客户端不发这个字段，
       * 新客户端也可能就在本地发（见面城 = 自己所在城），两种情况都得过。
       *
       * 合法性只在「非空」时才校验：空串不是城市 id，不该被 `okCity` 判死。
       */
      const meet = clean(body?.meet, 40);
      /*
       * 发起方的世界流速（1 = 和真实时间同步）。**0 = 老客户端没报。**
       *
       * 不拿它做拒绝，只拿它让接的人在界面上说清「你们时间流速差太多，凑不到一起」——
       * 这件事本地能判断（自己的 speed 在配置里），服务端不需要懂业务。
       */
      const pace = Math.min(240, Math.max(0, Math.round(Number(body?.pace) || 0)));

      /*
       * 一句话。**这是整个系统里唯一一段自由文本**，所以它是过滤最该管的地方 ——
       * 也是「邀约」这件事必须先有内容安全才能做的原因。
       * 被判定为广告就留空，不拒绝整条邀约：她还能发，只是不带那句话。
       */
      const noteRaw = clean(body?.note, 60);
      const note = looksBad(noteRaw, extra) ? '' : noteRaw;

      if (!okUid(uid) || !okCity(from) || !okCity(to) || !pet) {
        return reply(400, { ok: false, error: 'bad fields' });
      }
      if (meet && !okCity(meet)) return reply(400, { ok: false, error: 'bad fields' });
      /*
       * 被封的也不能发邀约。
       *
       * 只挡上报的话，她照样能发邀请、照样能被别人接走 —— 那叫封了半截。
       */
      if ((await flagOf(db, uid))?.kind === 'ban') return reply(403, { ok: false, error: 'banned' });

      const key = `iv:${uid}:${day}`;
      if (await rateOf(db, key) >= INVITE_PER_DAY) {
        return reply(429, { ok: false, error: 'too many' });
      }

      const now = new Date();
      const id = newId();
      await db.prepare(
        `INSERT INTO invites (id, uid, pet, from_city, to_city, days, note, date_key, at, expires_at, meet_city, pace)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(
        id, uid, pet, from, to, days, note, day,
        now.toISOString(), new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
        meet, pace,
      ).run();

      await bumpRate(db, key, day);
      return reply(200, { ok: true, id });
    }

    return reply(405, { ok: false, error: 'method not allowed' });
  } catch (e) {
    recordError(env, null, '[sight invite]', e, '/sight/invite');
    return reply(500, { ok: false, error: 'server error' });
  }
}

/**
 * 一次拿齐「池子多大」和「谁在找伴」。
 *
 * ## 为什么要合成一个
 *
 * 客户端原来每 20 分钟问一次池子、每 30 分钟问一次邀约 —— **一只鱼一天 120 次请求**。
 * Cloudflare 免费额度是 10 万/天，等于 800 只鱼就到顶（2026-11-06 算的账）。
 * 这两样本来就是「顺手一问」，合成一个请求次数直接砍半；客户端再把间隔拉到 60 分钟，
 * 一只鱼一天 24 次，同样额度能撑到 4000 只。
 *
 * ## 为什么不带 mine=1
 *
 * 「谁接了她的话」是一次性认领（`taken` → `seen=1`），必须单独走 `/sight/invite?mine=1`，
 * 不能和这个「随便看一眼」的请求混在一起 —— 混了就会出现「顺手看一眼把约定认领了」。
 */
/**
 * 足迹：记下「她来过这座城」（2026-11-14）。
 *
 * ## 为什么不挂在 `POST /sight` 上
 *
 * 上报是心跳（20 分钟一次）：一天 72 次 × 上百只鱼 = 上万行写入，
 * 而足迹只在**到达一座新城**时才变。挂在心跳上等于拿 99% 的写入换 1% 的信息。
 * 所以给它单独一个口，由客户端的 `journey.arrive` 触发 —— 一天最多几次。
 *
 * ## GET 和 POST 同一个路径
 *
 * `/sight/footprints`：GET 查我自己的履历，POST 记一笔到达。
 * 一只鱼只能查自己的（要带 uid），没有"看别人足迹"的口 —— 那是另一件事，
 * 真要做也得先有可见性开关，不能默认公开。
 */
async function footprintRoute(request, env, url, method) {
  const db = env?.DB;
  if (!db) return reply(500, { ok: false, error: 'server error' });

  /* ---------------- 记：她到了 ---------------- */
  if (method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return reply(400, { ok: false, error: 'bad json' }); }
    const uid = clean(body?.uid, 64);
    const city = clean(body?.city, 40);
    if (!okUid(uid) || !okCity(city)) return reply(400, { ok: false, error: 'bad query' });

    const now = new Date().toISOString();
    try {
      await db.prepare(
        /*
         * 同一个 uid+city 只有一行：第一次到达建行，以后只刷新 `last_at` 并 +1。
         * `visits` 封顶 999 —— 上限只是防刷（重复 POST 不会无限膨胀这个数），
         * 真要跑一千次重游，那个数也没人看了。
         */
        `INSERT INTO footprints (uid, city, first_at, last_at, visits)
         VALUES (?1, ?2, ?3, ?3, 1)
         ON CONFLICT(uid, city) DO UPDATE SET
           last_at = excluded.last_at,
           visits = CASE WHEN footprints.visits >= 999 THEN 999 ELSE footprints.visits + 1 END`,
      ).bind(uid, city, now).run();
      return reply(200, { ok: true });
    } catch (e) {
      recordError(env, null, '[footprint]', e, '/sight/footprints');
      return reply(500, { ok: false, error: 'server error' });
    }
  }

  /* ---------------- 查：她去过哪儿 ---------------- */
  if (method === 'GET') {
    const uid = clean(url.searchParams.get('uid'), 64);
    if (!okUid(uid)) return reply(400, { ok: false, error: 'bad query' });
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 300));
    try {
      const { results } = await db.prepare(
        `SELECT city, first_at, last_at, visits FROM footprints
         WHERE uid = ?1 ORDER BY last_at DESC LIMIT ${limit}`,
      ).bind(uid).all();
      const places = (results ?? []).map((r) => ({
        city: r.city,
        first: r.first_at,
        last: r.last_at,
        visits: Number(r.visits) || 1,
      }));
      return reply(200, { ok: true, total: places.length, places });
    } catch (e) {
      recordError(env, null, '[footprints]', e, '/sight/footprints');
      return reply(500, { ok: false, error: 'server error' });
    }
  }

  return reply(405, { ok: false, error: 'method not allowed' });
}

/**
 * 路标：她在一座城留一句「这里值得来」（2026-11-14）。
 *
 * ## 和「留言板」的区别
 *
 * 这是**推荐**，不是聊天。留言板要求有人来回，冷门城市空得像坏了；
 * 路标只有去留，空态是「这城还没人留过」—— 天然成立，不依赖同一时刻有别人。
 * 池子里 256 只鱼散在 102 座城，一座城平均两只半，只有这种形态能转起来。
 *
 * ## 从《死亡搁浅》借的结构
 *
 * 玩家 A 建的桥会出现在 B 的世界里，B 走过去顺手点个赞。两人永不同时在线。
 * 关键不是「共享」，是**只留正向痕迹**：没有踩、没有举报、没有排序。
 *
 * ## 三条限制，都是为了不让它变成广告栏
 *
 * 1. 一句话 ≤ 40 字，写入前过 `safeDoing`（禁 URL、禁联系方式）
 * 2. 一只鱼在一座城**一天只留一条**——重留覆盖旧的，不是刷屏
 * 3. 一城最多留 20 条，超了删最老的
 */
const SIGNPOST_MAX = 20;
const SIGNPOST_TTL_DAYS = 7;

/**
 * `GET /town/info` —— **公开，不要 key**（2026-11-15）。
 *
 * 这是方案 §4.18 里那个「一台城服务器想被别人找到」的接口：
 * 城 id、城名、设定、接口版本。别的城拿它拼目录、做健康检查；
 * 自己的客户端拿它显示「本城：浅水埠」。
 *
 * **只回这座城的设定，不回任何一只鱼的东西。** 城名不是秘密 ——
 * 它本来就会出现在市集货架和她的对话里。而「谁住在这儿」是另一件事，
 * 那走 `town` 表，且要经过 §4.17 那套口径。
 */
async function townInfoRoute(env) {
  const town = await readTown(env.DB, env);
  return reply(200, {
    ok: true,
    town: town.id,
    name: town.name,
    origin: town.origin,
    streets: town.streets,
    rules: town.rules,
    /*
     * 接口版本。将来加了字段，别的服务器按这个数字判断能不能用 ——
     * 没有版本号的跨机接口，第一次改结构就会把所有老客户端弄坏。
     */
    api: 1,
    /* 设定的最后修改时刻。目录那边用它判断「这条还新吗」。 */
    at: town.at,
    custom: town.custom,
  });
}

const TOWN_KEEP_DAYS = 30;
const STALLS_MAX = 60;
const STALL_KEEP_DAYS = 3;
const STALLS_PER_USER_MAX = 3;
const STALLS_CACHE_MS = 15 * 60_000;
const DEAL_KEEP_DAYS = 7;

const stallsCacheKey = () =>
  new Request(`https://town-stalls.internal/v1/${Math.floor(Date.now() / STALLS_CACHE_MS)}`);

async function invalidateStallsCache(ctx) {
  const cache = typeof caches === 'object' && caches.default ? caches.default : null;
  if (!cache) return;
  try {
    const task = Promise.resolve().then(() => cache.delete(stallsCacheKey())).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
    else await task;
  } catch { /* ignore */ }
}

async function townJoinRoute(request, env, method) {
  if (method !== 'POST') return reply(405, { ok: false, error: 'method not allowed' });
  const db = env?.DB;
  if (!db) return reply(500, { ok: false, error: 'server error' });
  let body;
  try { body = await request.json(); } catch { return reply(400, { ok: false, error: 'bad json' }); }

  const uid = clean(body?.uid, 64);
  const extra = bannedExtra(env);
  const washed = safePet(body?.pet, extra);
  const pet = washed.name;
  const street = safeDoing(clean(body?.street, 24), extra);
  if (!okUid(uid) || !pet) return reply(400, { ok: false, error: 'bad fields' });

  try {
    const flag = await flagOf(db, uid);
    if (flag?.kind === 'ban') return reply(403, { ok: false, error: 'banned' });

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const day = nowIso.slice(0, 10);
    const rKey = `tj:${uid}:${day}`;
    if (await rateOf(db, rKey) >= 12) return reply(429, { ok: false, error: 'too many' });

    const expIso = new Date(now + TOWN_KEEP_DAYS * 86_400_000).toISOString();
    await db.prepare(
      `INSERT INTO town (uid, pet, street, lane, at, expires_at)
       VALUES (?1, ?2, ?3, 0, ?4, ?5)
       ON CONFLICT(uid) DO UPDATE SET
         pet = excluded.pet,
         street = excluded.street,
         at = excluded.at,
         expires_at = excluded.expires_at`,
    ).bind(uid, pet, street, nowIso, expIso).run();
    await bumpRate(db, rKey, day);
    const town = await readTown(db, env);
    return reply(200, { ok: true, town: town.id, name: town.name, street });
  } catch (e) {
    if (/no such table/i.test(String(e?.message || e))) {
      return reply(503, { ok: false, error: 'not migrated' });
    }
    recordError(env, null, '[town join]', e, '/town/join');
    return reply(500, { ok: false, error: 'server error' });
  }
}

async function townStallsRoute(request, env, method, ctx) {
  const db = env?.DB;
  if (!db) return reply(500, { ok: false, error: 'server error' });

  if (method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return reply(400, { ok: false, error: 'bad json' }); }

    const uid = clean(body?.uid, 64);
    const extra = bannedExtra(env);
    const washedPet = safePet(body?.pet || '街坊', extra);
    const seller = washedPet.name || '街坊';
    const item = safeDoing(body?.item, extra);
    const kind = body?.kind === 'errand' ? 'errand' : 'goods';
    const price = Math.round(Number(body?.price));
    const stock = Math.round(Number(body?.stock ?? 1));
    const freshVeg = body?.freshVeg ? 1 : 0;
    const note = safeDoing(body?.note || '', extra);

    if (!okUid(uid) || !item || !Number.isFinite(price) || price < 1 || price > 999 || !Number.isFinite(stock) || stock < 1 || stock > 99) {
      return reply(400, { ok: false, error: 'bad fields' });
    }

    try {
      const flag = await flagOf(db, uid);
      if (flag?.kind === 'ban') return reply(403, { ok: false, error: 'banned' });

      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const day = nowIso.slice(0, 10);
      const rKey = `ts:${uid}:${day}`;
      if (await rateOf(db, rKey) >= 20) return reply(429, { ok: false, error: 'too many' });

      const activeRow = await db.prepare(
        `SELECT COUNT(*) AS n
           FROM stalls
          WHERE uid = ?1 AND stock > 0 AND expires_at > ?2`,
      ).bind(uid, nowIso).first();
      if ((Number(activeRow?.n ?? 0) || 0) >= STALLS_PER_USER_MAX) {
        return reply(409, { ok: false, error: 'too many stalls' });
      }

      const id = newId();
      const expIso = new Date(now + STALL_KEEP_DAYS * 86_400_000).toISOString();
      await db.prepare(
        `INSERT INTO stalls (id, uid, seller, kind, item, price, stock, fresh_veg, note, at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ).bind(id, uid, seller, kind, item, price, stock, freshVeg, note, nowIso, expIso).run();

      await bumpRate(db, rKey, day);
      await invalidateStallsCache(ctx);
      return reply(200, { ok: true, id, seller, kind, item, price, stock, freshVeg: !!freshVeg, note, at: nowIso, expiresAt: expIso });
    } catch (e) {
      if (/no such table|no such column/i.test(String(e?.message || e))) {
        return reply(503, { ok: false, error: 'not migrated' });
      }
      recordError(env, null, '[town stalls post]', e, '/town/stalls');
      return reply(500, { ok: false, error: 'server error' });
    }
  }

  if (method !== 'GET') return reply(405, { ok: false, error: 'method not allowed' });

  const cache = typeof caches === 'object' && caches.default ? caches.default : null;
  const cKey = stallsCacheKey();
  if (cache) {
    try {
      const hit = await cache.match(cKey);
      if (hit) return hit;
    } catch { /* 缓存失败直接回源 */ }
  }

  const town = await readTown(db, env);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const since24h = new Date(now - 86_400_000).toISOString();
  const extra = bannedExtra(env);

  try {
    const [stallsRes, dealsTopRes, dealsSumRes, townRes] = await Promise.all([
      db.prepare(
        `SELECT id, seller, kind, item, price, stock, fresh_veg, note, at
           FROM stalls
          WHERE expires_at > ?1 AND stock > 0
          ORDER BY at DESC LIMIT ${STALLS_MAX}`,
      ).bind(nowIso).all(),
      db.prepare(
        `SELECT item, SUM(qty) AS n
           FROM deals
          WHERE at >= ?1
          GROUP BY item
          ORDER BY n DESC LIMIT 2`,
      ).bind(since24h).all(),
      db.prepare(
        `SELECT COALESCE(SUM(qty), 0) AS total_qty
           FROM deals
          WHERE at >= ?1`,
      ).bind(since24h).first(),
      db.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN at >= ?1 THEN 1 ELSE 0 END) AS recent
           FROM town
          WHERE expires_at > ?2`,
      ).bind(since24h, nowIso).first(),
    ]);

    const stalls = (stallsRes?.results ?? [])
      .map((r) => ({
        id: String(r.id),
        seller: safePet(r.seller, extra).name || '街坊',
        kind: r.kind === 'errand' ? 'errand' : 'goods',
        item: safeDoing(r.item, extra) || String(r.item || '').slice(0, 24),
        price: Math.max(1, Math.round(Number(r.price) || 0)),
        stock: Math.max(0, Math.round(Number(r.stock) || 0)),
        freshVeg: Boolean(r.fresh_veg),
        note: safeDoing(r.note, extra),
      }))
      .filter((x) => x.item && x.stock > 0);

    const bulletin = [];
    const totalDeals = Number(dealsSumRes?.total_qty ?? 0) || 0;
    const topItem = dealsTopRes?.results?.[0]?.item ? safeDoing(dealsTopRes.results[0].item, extra) : '';
    if (totalDeals > 0) {
      bulletin.push(topItem
        ? `过去一天城里一共成交了 ${totalDeals} 份摊货，最抢手的是「${topItem}」。`
        : `过去一天城里一共成交了 ${totalDeals} 份摊货。`);
    }
    const residents = Number(townRes?.total ?? 0) || 0;
    const newResidents = Number(townRes?.recent ?? 0) || 0;
    if (residents > 0) {
      bulletin.push(newResidents > 0
        ? `${town.name}眼下住着 ${residents} 户人家，这阵子新搬来 ${newResidents} 户。`
        : `${town.name}眼下在册住着 ${residents} 户人家。`);
    }
    if (stalls.length > 0) {
      const head = stalls[0];
      bulletin.push(`鱼市街此刻摆着 ${stalls.length} 个摊子，${head.seller}刚挂出「${head.item}」。`);
    }

    const body = { ok: true, town: town.id, name: town.name, stalls, bulletin };
    const out = reply(200, body);
    if (cache) {
      const putRes = new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': `public, max-age=${Math.round(STALLS_CACHE_MS / 1000)}`,
          ...CORS,
        },
      });
      const putTask = Promise.resolve().then(() => cache.put(cKey, putRes)).catch(() => {});
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(putTask);
      else await putTask;
    }
    return out;
  } catch (e) {
    if (/no such table/i.test(String(e?.message || e))) {
      return reply(200, { ok: true, town: town.id, name: town.name, stalls: [], bulletin: [], degraded: true });
    }
    recordError(env, null, '[town stalls]', e, '/town/stalls');
    return reply(500, { ok: false, error: 'server error' });
  }
}

async function townBuyRoute(request, env, method, ctx) {
  if (method !== 'POST') return reply(405, { ok: false, error: 'method not allowed' });
  const db = env?.DB;
  if (!db) return reply(500, { ok: false, error: 'server error' });
  let body;
  try { body = await request.json(); } catch { return reply(400, { ok: false, error: 'bad json' }); }

  const stallId = clean(body?.stallId, 64);
  const qty = Math.max(1, Math.min(10, Math.round(Number(body?.qty ?? 1) || 1)));
  const buyerUid = clean(body?.buyerUid ?? body?.uid ?? '', 64);
  if (!stallId || !okUid(buyerUid)) return reply(400, { ok: false, error: 'bad fields' });

  const extra = bannedExtra(env);
  const buyerPet = safePet(body?.buyer || body?.buyerPet || '街坊', extra).name || '一只鱼';
  const note = safeDoing(body?.note || '', extra);

  try {
    const flag = await flagOf(db, buyerUid);
    if (flag?.kind === 'ban') return reply(403, { ok: false, error: 'banned' });

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const day = nowIso.slice(0, 10);
    const rKey = `tb:${buyerUid}:${day}`;
    if (await rateOf(db, rKey) >= 60) return reply(429, { ok: false, error: 'too many' });

    const row = await db.prepare(
      `SELECT id, uid, seller, kind, item, price, stock, fresh_veg, expires_at
         FROM stalls WHERE id = ?1`,
    ).bind(stallId).first();
    if (!row) return reply(404, { ok: false, error: 'not found' });

    if (row.expires_at <= nowIso || Number(row.stock) < qty) {
      return reply(409, { ok: false, error: 'sold out' });
    }
    if (buyerUid === row.uid) {
      return reply(400, { ok: false, error: 'own stall' });
    }

    const upd = await db.prepare(
      `UPDATE stalls SET stock = stock - ?1
        WHERE id = ?2 AND stock >= ?1 AND expires_at > ?3`,
    ).bind(qty, stallId, nowIso).run();
    if (!upd?.meta?.changes) return reply(409, { ok: false, error: 'sold out' });

    const dealId = newId();
    const dealExp = new Date(now + DEAL_KEEP_DAYS * 86_400_000).toISOString();
    await db.prepare(
      `INSERT INTO deals (id, stall_id, seller_uid, buyer_uid, buyer_pet, item, qty, note, seen, at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10)`,
    ).bind(
      dealId,
      row.id,
      row.uid,
      buyerUid,
      buyerPet,
      String(row.item),
      qty,
      note,
      nowIso,
      dealExp,
    ).run();

    await bumpRate(db, rKey, day);
    await invalidateStallsCache(ctx);
    return reply(200, {
      ok: true,
      id: dealId,
      item: String(row.item),
      price: Math.max(1, Math.round(Number(row.price) || 0)),
      seller: safePet(row.seller, extra).name || '街坊',
      freshVeg: Boolean(row.fresh_veg),
      qty,
      stockLeft: Math.max(0, Number(row.stock) - qty),
    });
  } catch (e) {
    if (/no such table|no such column/i.test(String(e?.message || e))) {
      return reply(503, { ok: false, error: 'not migrated' });
    }
    recordError(env, null, '[town buy]', e, '/town/buy');
    return reply(500, { ok: false, error: 'server error' });
  }
}

async function townDealsRoute(request, env, url, method, path) {
  const db = env?.DB;
  if (!db) return reply(500, { ok: false, error: 'server error' });
  const extra = bannedExtra(env);

  if (path === '/town/deals/seen') {
    if (method !== 'POST') return reply(405, { ok: false, error: 'method not allowed' });
    let body;
    try { body = await request.json(); } catch { return reply(400, { ok: false, error: 'bad json' }); }
    const uid = clean(body?.uid, 64);
    if (!okUid(uid)) return reply(400, { ok: false, error: 'bad fields' });
    try {
      const ids = Array.isArray(body?.ids)
        ? body.ids.map((x) => clean(x, 64)).filter(Boolean).slice(0, 30)
        : [];
      if (ids.length) {
        const ph = ids.map((_, idx) => `?${idx + 2}`).join(',');
        await db.prepare(
          `UPDATE deals SET seen = 1 WHERE seller_uid = ?1 AND id IN (${ph})`,
        ).bind(uid, ...ids).run();
      } else {
        await db.prepare(
          `UPDATE deals SET seen = 1 WHERE seller_uid = ?1 AND seen = 0`,
        ).bind(uid).run();
      }
      return reply(200, { ok: true });
    } catch (e) {
      if (/no such table|no such column/i.test(String(e?.message || e))) {
        return reply(503, { ok: false, error: 'not migrated' });
      }
      recordError(env, null, '[town deals seen]', e, '/town/deals/seen');
      return reply(500, { ok: false, error: 'server error' });
    }
  }

  if (method !== 'GET') return reply(405, { ok: false, error: 'method not allowed' });
  const uid = clean(url.searchParams.get('uid'), 64);
  if (!okUid(uid)) return reply(400, { ok: false, error: 'bad fields' });
  const ack = url.searchParams.get('ack') === '1';

  try {
    const nowIso = new Date().toISOString();
    const day = nowIso.slice(0, 10);
    const rKey = `td:${uid}:${day}`;
    if (await rateOf(db, rKey) >= 120) return reply(429, { ok: false, error: 'too many' });

    const [listRes, unseenRow] = await Promise.all([
      db.prepare(
        `SELECT id, stall_id, item, qty, buyer_pet, note, seen, at
           FROM deals
          WHERE seller_uid = ?1
          ORDER BY at DESC LIMIT 30`,
      ).bind(uid).all(),
      db.prepare(
        `SELECT COUNT(*) AS n
           FROM deals
          WHERE seller_uid = ?1 AND seen = 0`,
      ).bind(uid).first(),
    ]);
    await bumpRate(db, rKey, day);

    const rows = listRes?.results ?? [];
    const deals = rows.map((r) => ({
      id: String(r.id),
      stallId: String(r.stall_id || ''),
      item: safeDoing(r.item, extra) || String(r.item || '').slice(0, 24),
      qty: Math.max(1, Math.round(Number(r.qty) || 1)),
      buyerPet: safePet(r.buyer_pet, extra).name || '一只鱼',
      note: safeDoing(r.note, extra),
      seen: Boolean(r.seen),
      at: String(r.at || ''),
    }));
    let unseen = Number(unseenRow?.n ?? 0) || 0;

    if (ack && deals.some((d) => !d.seen)) {
      const ackIds = deals.filter((d) => !d.seen).map((d) => d.id);
      const ph = ackIds.map((_, idx) => `?${idx + 2}`).join(',');
      await db.prepare(
        `UPDATE deals SET seen = 1 WHERE seller_uid = ?1 AND id IN (${ph})`,
      ).bind(uid, ...ackIds).run();
      unseen = Math.max(0, unseen - ackIds.length);
    }

    return reply(200, { ok: true, deals, unseen });
  } catch (e) {
    if (/no such table|no such column/i.test(String(e?.message || e))) {
      return reply(200, { ok: true, deals: [], unseen: 0, degraded: true });
    }
    recordError(env, null, '[town deals]', e, '/town/deals');
    return reply(500, { ok: false, error: 'server error' });
  }
}

async function signpostRoute(request, env, url, method) {
  const db = env?.DB;
  if (!db) return reply(500, { ok: false, error: 'server error' });

  /* ---------------- 留一个 ---------------- */
  if (method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return reply(400, { ok: false, error: 'bad json' }); }
    const uid = clean(body?.uid, 64);
    const pet = clean(body?.pet, 24);
    const city = clean(body?.city, 40);
    if (!okUid(uid) || !okCity(city) || !pet) {
      return reply(400, { ok: false, error: 'bad query' });
    }
    const text = safeDoing(clean(body?.text, 60), bannedExtra(env));
    if (!text) return reply(400, { ok: false, error: 'bad text' });

    const now = new Date();
    const nowIso = now.toISOString();
    const todayKey = todayStartIso();
    const id = newId();
    const expires = new Date(now.getTime() + SIGNPOST_TTL_DAYS * 86_400_000).toISOString();

    try {
      /*
       * 一天一城一条：先删当天这条鱼在同一城留的旧路标，再插新的。
       * 用 `at >= todayStart` 判断「同一天」—— `date_key` 是游戏内日期，跟现实对不上。
       */
      await db.prepare(
        'DELETE FROM signposts WHERE uid = ?1 AND city = ?2 AND at >= ?3',
      ).bind(uid, city, todayKey).run();

      await db.prepare(
        `INSERT INTO signposts (id, uid, pet, city, text, at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(id, uid, pet, city, text, nowIso, expires).run();

      /* 一城封顶 20 条：删掉超出上限里最老的。 */
      await db.prepare(
        `DELETE FROM signposts WHERE city = ?1 AND id NOT IN
           (SELECT id FROM signposts WHERE city = ?1 ORDER BY at DESC LIMIT ${SIGNPOST_MAX})`,
      ).bind(city).run();

      return reply(200, { ok: true, id });
    } catch (e) {
      recordError(env, null, '[signpost]', e, '/sight/signposts');
      return reply(500, { ok: false, error: 'server error' });
    }
  }

  /* ---------------- 看这城的路标 ---------------- */
  if (method === 'GET') {
    const city = clean(url.searchParams.get('city'), 40);
    const exclude = clean(url.searchParams.get('exclude'), 64);
    if (!okCity(city)) return reply(400, { ok: false, error: 'bad query' });
    const nowIso = new Date().toISOString();
    try {
      const { results } = await db.prepare(
        /*
         * 只回 `pet` 和一句话 —— **不回 uid、不回精确时间**。
         * 时间只用来排序和过期，出了这个函数就该消失。
         */
        `SELECT pet, text, at FROM signposts
         WHERE city = ?1 AND expires_at > ?2 AND uid <> ?3
         ORDER BY at DESC LIMIT 10`,
      ).bind(city, nowIso, exclude).all();
      const extra = bannedExtra(env);
      return reply(200, {
        ok: true,
        list: (results ?? [])
          .map((r) => ({
            pet: safePet(r.pet, extra).name,
            text: looksBad(String(r.text || ''), extra) ? '' : clean(r.text, 60),
          }))
          .filter((r) => r.pet && r.text),
      });
    } catch (e) {
      recordError(env, null, '[signposts]', e, '/sight/signposts');
      return reply(500, { ok: false, error: 'server error' });
    }
  }

  return reply(405, { ok: false, error: 'method not allowed' });
}

async function statusRoute(request, env, url, ctx) {
  if (request.method !== 'GET') return reply(405, { ok: false, error: 'method not allowed' });
  const db = env?.DB;
  if (!db) return reply(500, { ok: false, error: 'server error' });

  const city = clean(url.searchParams.get('city'), 40);
  const uid = clean(url.searchParams.get('uid'), 64);
  if (!okUid(uid)) return reply(400, { ok: false, error: 'bad query' });
  if (city && !okCity(city)) return reply(400, { ok: false, error: 'bad query' });

  const extra = bannedExtra(env);
  const nowIso = new Date().toISOString();
  try {
    /*
     * 两个数一起给，别混：
     *
     *   `pool`   今天有过上报的去重 uid —— 「今天来过多少只」
     *   `online` 最近 30 分钟有过上报   —— 「此刻在线多少只」
     *
     * 客户端面板说的是「它今天碰上过几只」，用 `pool` 是对的；
     * 管理页要看的「现在有几只在跑」必须用 `online`。
     */
    /*
     * **先编译，再并发**（2026-11-14，从另一份源码搬回来）。
     *
     * `db.prepare()` 是**同步**的，D1 额度耗尽时它会当场抛。
     * 写成 `Promise.all([poolAndOnline(...), db.prepare(...)])` 的话，
     * prepare 抛出的瞬间 `poolAndOnline` 返回的那个 Promise 就没人接了 ——
     * 变成 unhandledRejection（Workers 里会打额外错误、也可能判这次请求失败）。
     * 把同步部分提到 await 之前，抛错就走正常的 catch，不会有孤儿 Promise。
     */
    const mineStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM invites WHERE uid = ?1 AND taken_by <> ?2',
    ).bind(uid, '');
    const inviteStmt = db.prepare(
      `SELECT id, pet, to_city, days, note, at, meet_city, pace,
              CASE WHEN from_city = ?1 THEN 1 ELSE 0 END AS near,
              (SELECT COUNT(*) FROM invite_takers t WHERE t.id = invites.id) AS joined
       FROM invites
       WHERE expires_at > ?2 AND uid <> ?3
         AND (SELECT COUNT(*) FROM invite_takers t WHERE t.id = invites.id) < ?4
       ORDER BY near DESC, at DESC LIMIT 3`,
    ).bind(city, nowIso, uid, MAX_PARTY - 1);

    const [counts, mine, { results }] = await Promise.all([
      poolAndOnline(db, ctx),
      /*
       * **我发出去的邀约，被接过几次。**
       *
       * 这是「她帮到了别人」的唯一一个可数证据 —— `statsSummary` 拿它说一句
       * 「有人应过她几回」。只给次数，不给是谁：说「谁接了」就变成社交账本，
       * 而「不回应 = 没看见」那套规矩要求这里不能有对象。
       */
      mineStmt.first().catch(() => null),
      inviteStmt.all(),
    ]);
    return reply(200, {
      ok: true,
      pool: counts.pool,
      online: counts.online,
      mineTaken: Number(mine?.n ?? 0) || 0,
      list: (results ?? []).map((r) => ({
        id: r.id,
        pet: safePet(r.pet, extra).name,
        to: r.to_city,
        days: Number(r.days) || 1,
        note: looksBad(String(r.note || ''), extra) ? '' : clean(r.note, 60),
        meet: clean(r.meet_city, 40),
        pace: Number(r.pace) || 0,
      })),
    }, { 'x-pool-cache': counts.cache ?? 'miss' });
  } catch (e) {
    recordError(env, null, '[sight status]', e, '/sight/status');
    return reply(500, { ok: false, error: 'server error' });
  }
}

/**
 * 接一条。
 *
 * 用 `UPDATE ... WHERE taken_by = ''` 做条件更新 —— 两个人同时接同一条，
 * 只有一个能改到行，另一个拿到 0 行受影响。比「先查再写」可靠，
 * 那种写法在并发下会两个人都以为接到了。
 */
async function acceptRoute(request, env, url, method) {
  if (method !== 'POST') return reply(405, { ok: false, error: 'method not allowed' });

  const db = env?.DB;
  if (!db) return reply(500, { ok: false, error: 'server error' });

  const day = new Date().toISOString().slice(0, 10);
  const extra = bannedExtra(env);

  try {
    let body;
    try { body = await request.json(); } catch { return reply(400, { ok: false, error: 'bad json' }); }

    const uid = clean(body?.uid, 64);
    const id = clean(body?.id, 32);
    /*
     * 接的人的名字。**必须由客户端带上** —— 服务端只认得 uid，
     * 而发起者要知道「谁接了」，否则他那边没法说「小满接了你的话，一起去拉萨」。
     */
    const pet = safePet(body?.pet, extra).name;
    if (!okUid(uid) || !/^[a-f0-9]{16}$/.test(id)) {
      return reply(400, { ok: false, error: 'bad fields' });
    }

    const row = await db.prepare(
      'SELECT id, uid, pet, to_city, days, note, expires_at, taken_by, meet_city, pace FROM invites WHERE id = ?1',
    ).bind(id).first();

    if (!row) return reply(404, { ok: false, error: 'gone' });
    if (row.uid === uid) return reply(400, { ok: false, error: 'own invite' });
    if (Date.parse(row.expires_at) <= Date.now()) return reply(410, { ok: false, error: 'expired' });

    const respond = (extraFields = {}) => reply(200, {
      ok: true,
      with: safePet(row.pet, extra).name,
      to: row.to_city,
      days: Number(row.days) || 1,
      note: looksBad(String(row.note || ''), extra) ? '' : clean(row.note, 60),
      meet: clean(row.meet_city, 40),
      pace: Number(row.pace) || 0,
      ...extraFields,
    });

    /*
     * 已经在这条里了 → 幂等成功，不重复计数。
     *
     * 客户端可能会重试（网络抖一下、她说了两遍「接」），
     * 第二遍回 409 taken 会让她以为「没接上」，其实上一次就成功了。
     */
    const dup = await db.prepare(
      'SELECT 1 AS x FROM invite_takers WHERE id = ?1 AND uid = ?2',
    ).bind(id, uid).first();
    if (dup) return respond({ already: true });

    /*
     * 人数上限。原来这里写的是「taken_by 非空就 409」——
     * 一条邀约只能成一对，三只鱼同城时总有一只没位置。
     */
    const cnt = await db.prepare(
      'SELECT COUNT(*) AS n FROM invite_takers WHERE id = ?1',
    ).bind(id).first();
    const joined = Number(cnt?.n ?? 0);
    if (joined >= MAX_PARTY - 1) return reply(409, { ok: false, error: 'full' });

    const key = `ia:${uid}:${day}`;
    if (await rateOf(db, key) >= ACCEPT_PER_DAY) {
      return reply(429, { ok: false, error: 'too many' });
    }

    /*
     * INSERT OR IGNORE 而不是 UPDATE ... WHERE taken_by = ''：
     * 后者只能记一个人，第二个人来的时候那句 UPDATE 影响 0 行。
     */
    const ins = await db.prepare(
      'INSERT OR IGNORE INTO invite_takers (id, uid, pet, at) VALUES (?1, ?2, ?3, ?4)',
    ).bind(id, uid, pet, new Date().toISOString()).run();
    if (!ins?.meta?.changes) return respond({ already: true });

    /*
     * 老字段继续写：**只记第一位接单人**。
     * 老版本客户端还在读 `taken_pet` 判断「有没有人接」，这一行不能断。
     */
    await db.prepare(
      "UPDATE invites SET taken_by = ?1, taken_pet = ?2 WHERE id = ?3 AND taken_by = ''",
    ).bind(uid, pet, id).run();

    await bumpRate(db, key, day);

    // `size` = 含发起者一共几只。她会说「现在这条路上有三只了」。
    return respond({ size: joined + 2 });
  } catch (e) {
    recordError(env, null, '[sight accept]', e, '/sight/accept');
    return reply(500, { ok: false, error: 'server error' });
  }
}

/** IP 不做明文入库 —— 存前 16 位 sha256，够去重，又不可逆。 */
async function ipHash(request) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '';
  if (!ip) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip.split(',')[0].trim()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** 恒定时间比较。用 `===` 比密钥会按「第几个字符开始不同」泄露时间差。 */
/**
 * 这只鱼有没有被人工标过。
 *
 * **表不存在就当没标。** `pet_flags` 是 2026-11-05 才加的，线上可能还没跑 DDL；
 * 让它把上报卡死，等于「加了个管理功能，整个池子先停了」。
 */
async function flagOf(db, uid) {
  try {
    const row = await db.prepare('SELECT kind, note FROM pet_flags WHERE uid = ?1').bind(uid).first();
    return row ? { kind: String(row.kind || ''), note: String(row.note || '') } : null;
  } catch {
    return null;
  }
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** uid 只露头尾 —— 页面上够定位，又不会把完整标识留在截图里。 */
const maskUid = (uid) => (typeof uid === 'string' && uid.length > 8
  ? `${uid.slice(0, 4)}…${uid.slice(-4)}`
  : String(uid ?? ''));

/**
 * 管理接口：**只读**。
 *
 * 凭什么只读：封禁和清理都要改数据，走 `wrangler d1 execute` 就够了，
 * 不给网页留写入口 —— 少一个能把线上数据搞坏的地方。
 *
 * 三条闸：
 * 1. `ADMIN_KEY` 没配 → 整个接口 404（默认关闭）
 * 2. 密钥不对 → 401，恒定时间比较
 * 3. 只接受 GET
 */
/**
 * 浏览器里打开根路径的人，看到的是这张说明页。
 *
 * 2026-11-05：群友把域名粘进浏览器，看到 `{"ok":false,"error":"not found"}`，
 * 结论是「服务器连不上」。其实那条路径本来就不是接口 —— 但用户没有第二个线索，
 * 一句 not found 就等于「坏了」。
 *
 * 所以根路径给人看，未知子路径照旧 404（不给扫描器留探测面）。
 * 顺手把「今天池子里有几只」打出来 —— 这是最快能证明「服务活着」的数字。
 */
async function landingPage(env, url, ctx) {
  const today = new Date().toISOString().slice(0, 10);
  let pool = 0;
  let online = 0;
  try {
    if (env?.DB) {
      const counts = await poolAndOnline(env.DB, ctx);
      pool = counts.pool;
      online = counts.online;
    }
  } catch { /* 数据库没就绪也不该让这页 500 —— 它只是说明页 */ }

  const origin = url.origin;
  const selfCheck = `${origin}/sight?city=xian&date=${today}&slot=morning`;
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>碰面服务器 · 大肥鱼环游世界</title>
<style>
  body{margin:0;padding:32px 20px;background:#f7f7f8;color:#1c1c1e;font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  main{max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e5ea;border-radius:14px;padding:28px 26px}
  h1{font-size:19px;margin:0 0 4px}
  p.sub{margin:0 0 20px;color:#6b6b70;font-size:13px}
  h2{font-size:14px;margin:22px 0 6px;color:#3a3a3c}
  .big{background:#f2f2f7;border-radius:9px;padding:12px 14px;font-size:14px;word-break:break-all;margin:8px 0}
  /* 地址 + 复制按钮（2026-11-14）。有人把 cooppets 里的 p 抄漏了一个，连不上还以为服务坏了。 */
  .copy{display:flex;align-items:stretch;gap:8px;margin:8px 0}
  .copy code{flex:1;display:flex;align-items:center;background:#f2f2f7;border-radius:9px;
             padding:12px 14px;font-size:14px;word-break:break-all;line-height:1.4;
             font-family:ui-monospace,Consolas,"Courier New",monospace;color:#1c1c1e;user-select:all}
  .copy button{flex:0 0 auto;font:inherit;font-size:14px;padding:0 16px;border-radius:9px;
               border:1px solid #0a63c9;background:#0a63c9;color:#fff;cursor:pointer;white-space:nowrap}
  .copy button:active{transform:translateY(1px)}
  .copy button.done{background:#0a7d32;border-color:#0a7d32}
  .ok{color:#0a7d32;font-weight:600}
  .hint{color:#8e8e93;font-size:12px;margin-top:8px}
  a{color:#0a63c9}
</style></head>
<body><main>
  <h1>碰面服务器 · 大肥鱼环游世界</h1>
  <p class="sub">让她的宠物和别人的宠物在同一个地方遇上</p>

  <h2>这是干嘛的</h2>
  <p>你的鱼和别人家的鱼各自在旅行，本来互不相干。把下面这个地址打开之后，
  她到站会看一眼这一带还有谁 —— 面板上会多一行「池子 · 今天一共 N 只」。</p>
  <p>想找人一起走就更直接：<b>跟她说一声就行</b>（「帮我问问有没有人想一起去成都，待三天」），
  她会发条话进池子；有人接了，两边就都改道往那儿去。</p>
  <p>每天最多发 3 条、接 1 条 —— 这是防止把池子刷成广告栏，不是限制你。</p>

  <h2>该怎么用</h2>
  <p>把这个地址填进扩展设置里的「碰面」那一栏，保存就好 —— <b>不用在浏览器里打开它</b>。</p>
  <div class="copy">
    <code id="addr">${origin}</code>
    <button id="copyAddr" type="button">复制</button>
  </div>
  <p class="hint">别手打。域名里连着两个相同的字母最容易漏 —— <b>cooppets</b> 是两个 p，
  抄漏一个就连不上，而且报的错会是「请求失败」，看着像服务坏了。</p>

  <h2>扩展本身在哪</h2>
  <p>Coopani 的扩展市场里搜「大肥鱼环游世界」。介绍、更新和反馈在
  <a href="https://github.com/Pal-AI-Lab/cortico-extensions/discussions/586">这里</a>。</p>

  <h2>服务是活的</h2>
  <p>此刻在线 <span class="ok">${online}</span> 只，今天一共来过 <span class="ok">${pool}</span> 只。${
  (online === 0 && pool === 0)
    ? '数字是 0 说明今天还没人上报，不代表坏了。'
    : ''}</p>

  <h2>想自己确认通不通</h2>
  <p>打开这个链接，能看到一段 JSON 就是通的：<br><a href="${selfCheck}">${selfCheck}</a></p>

  <p class="hint">填完之后：她到站会看一眼这一带还有谁，面板上会多一行「池子 · 今天一共 N 只」。
  不想被别人看见就把那一栏留空，其它功能一点不受影响。</p>
</main>
<script>
(function () {
  var btn = document.getElementById('copyAddr');
  var addr = document.getElementById('addr');
  if (!btn || !addr) return;
  var timer = null;
  function flash(text) {
    btn.textContent = text;
    if (text === '已复制') btn.classList.add('done');
    clearTimeout(timer);
    timer = setTimeout(function () {
      btn.textContent = '复制';
      btn.classList.remove('done');
    }, 1600);
  }
  /*
   * 先试 clipboard API；它在非安全上下文（http、某些内嵌窗口）会被直接拒绝，
   * 那就退回「选中 + execCommand」这套老办法 —— 它反而到处都能用。
   */
  function fallback() {
    var range = document.createRange();
    range.selectNodeContents(addr);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    sel.removeAllRanges();
    flash(ok ? '已复制' : '请手动选中');
  }
  btn.addEventListener('click', function () {
    /* 地址块里可能有换行或缩进，复制前把空白全去掉，粘出去才是干净的一串。 */
    var text = addr.textContent.replace(/\\s+/g, '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { flash('已复制'); }, fallback);
    } else {
      fallback();
    }
  });
})();
<\/script>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...CORS },
  });
}

async function adminRoute(request, env, url, method) {
  const key = env?.ADMIN_KEY;
  if (!key) return reply(404, { ok: false, error: 'not found' });

  /*
   * `/admin/flag` 只认 POST，其余只认 GET。
   * 不写死这条的话，GET /admin/flag 会掉进下面 /admin/list 那个分支，
   * 拿回一份列表 —— 看起来像成功，其实请求根本没被拒。
   */
  if (url.pathname === '/admin/flag') {
    if (method !== 'POST') return reply(405, { ok: false, error: 'method not allowed' });
  } else if (url.pathname === '/admin/town') {
    /*
     * 读写同一个口：GET 读、POST 写。
     * **不能漏掉这一支** —— 漏了它，POST /admin/town 会掉进下面那句
     * `method !== 'GET'` 直接 405，而报错长得像「接口没实现」。
     */
    if (method !== 'GET' && method !== 'POST') {
      return reply(405, { ok: false, error: 'method not allowed' });
    }
  } else if (method !== 'GET') {
    return reply(405, { ok: false, error: 'method not allowed' });
  }

  const got = request.headers.get('x-admin-key') || url.searchParams.get('key') || '';
  if (!safeEqual(got, key)) return reply(401, { ok: false, error: 'unauthorized' });

  const db = env.DB;
  if (!db) return reply(500, { ok: false, error: 'server error' });

  const day = clean(url.searchParams.get('date'), 10) || new Date().toISOString().slice(0, 10);

  try {
    /*
     * 认领一只鱼 —— 管理面板（`site/pets.html`）用的那个口。
     *
     * 回的是**完整 uid**，不是打码的：面板要靠它去封/改名。
     * 这条路由整体由 ADMIN_KEY 挡着，没配 key 时 404（见函数开头）。
     */
    /*
     * 实时块：**此刻谁在线**。和下面的「累计」分开成一个接口（2026-11-11）。
     *
     * Mr.Q：「把实时数据和累计数据分开」。这不只是分显示，得分接口 ——
     *
     * 累计那份要扫全表（4 天 × 每只鱼十几格），实时这份只碰最近 30 分钟的几十行。
     * 混在一个口里，页面为了看一眼「在线几只」就得把全表拉一遍；
     * 30 秒一次轮询乘上去，免费版每天 500 万行的额度两天就烧光
     * （2026-11-10 已经真烧光过一次，Cloudflare 发信、池子停了一整天）。
     *
     * **自动刷新只打这个口。** 累计那份只在人点「刷新」时拉。
     */
    if (url.pathname === '/admin/live') {
      const since = onlineSinceIso();
      const [onlineRow, todayRow, listRes] = await Promise.all([
        db.prepare('SELECT COUNT(DISTINCT uid) AS n FROM presence INDEXED BY idx_presence_at_uid WHERE at >= ?1')
          .bind(since).first(),
        db.prepare('SELECT COUNT(DISTINCT uid) AS n FROM presence INDEXED BY idx_presence_at_uid WHERE at >= ?1')
          .bind(todayStartIso()).first(),
        db.prepare(
          /*
           * 每人只取最近那一条。用 `JOIN (MAX(at) GROUP BY uid)` 而不是窗口函数：
           * 外层只回最多 60 行，索引能直接用上 `(uid, …)` 与 `at`，
           * 行读 ≈ 在线窗口内的行数，不会随表变大而变慢。
           */
          /*
           * 名片也带上（2026-11-12）。Mr.Q 在「此刻」这页找不到名片列 ——
           * 原来只有「在册」有，两张表口径不一致。
           *
           * profiles 的 uid 是主键，这个 LEFT JOIN 每个 uid 最多配一行，
           * 不会把「每人一行」变成「每人多行」。
           * 这里没有 GROUP BY（外层就是每人一条），所以直接取列，不用 MAX。
           */
          `SELECT p.uid, p.pet, p.city, p.doing, p.at,
                  pr.text AS profile_text, pr.at AS profile_at, pr.exp AS profile_exp
             FROM presence p
             JOIN (
               SELECT uid, MAX(at) AS m FROM presence INDEXED BY idx_presence_at_uid WHERE at >= ?1 GROUP BY uid
             ) x ON x.uid = p.uid AND x.m = p.at
             LEFT JOIN profiles pr ON pr.uid = p.uid
            ORDER BY p.at DESC LIMIT 60`,
        ).bind(since).all(),
      ]);
      return reply(200, {
        ok: true,
        online: Number(onlineRow?.n ?? 0) || 0,
        today: Number(todayRow?.n ?? 0) || 0,
        onlineWindowMin: Math.round(ONLINE_WINDOW_MS / 60_000),
        at: new Date().toISOString(),
        pets: (listRes?.results ?? []).map((r) => ({
          uid: r.uid,
          pet: clean(r.pet, 24),
          city: clean(r.city, 24),
          doing: clean(r.doing, 40),
          at: r.at,
          /* 和 /admin/pets 同一个形状，前端共用 profileCell()。 */
          profile: {
            text: clean(r.profile_text, 120),
            at: r.profile_at || '',
            expired: !!(r.profile_exp && Date.parse(r.profile_exp) <= Date.now()),
          },
        })),
      });
    }

    if (url.pathname === '/admin/pets') {
      /*
       * 面板请求的是 `?limit=800`，但这个口原来**写死 LIMIT 200** ——
       * 池子里超过 200 只之后「累计」那个数就顶在 200 不动了，
       * 而且页面等着 `data.truncated` 来提示「已截断」，服务端从来没返回过。
       * 现在认 params，上限 800（D1 单次返回行数的安全区），并在顶满时明说。
       */
      const limit = Math.min(800, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      const { results } = await db.prepare(
        /*
         * `city` 用相关子查询取「最近那一条上报的城市」。
         *
         * 不能写成裸列 `p.city` —— 那拿到的是**组里随便一行**的城市，不一定是最新的。
         * 也不能指望 `MAX(p.at)` 配合裸列的那套 SQLite bare-column 语义：
         * 它确实有文档写着，但读代码的人看不出来，改天换个引擎就静默变味。
         * 显式写一次子查询，多几次索引查找，换一个「不用猜」。
         *
         * 2026-11-05 面板上「最近在哪」全是「—」就是因为这里根本没返回城市。
         */
        `SELECT p.uid AS uid,
                MAX(p.at) AS last, COUNT(*) AS rows,
                /*
                 * **跨了几个城、跨了几天。**
                 *
                 * 只给一个行数，看的人会把它读成「发了 N 条消息」——
                 * 2026-11-07 Mr.Q 看到面板上「31」就去查是不是有人刷屏，
                 * 其实是 4 天里跑了两座城（一天最多 4 个时段，4 天 × 4 × 2 ≈ 32 格）。
                 * 把口径直接摆在旁边，比让人自己推省事。
                 */
                COUNT(DISTINCT p.city) AS cities,
                COUNT(DISTINCT p.date_key) AS days,
                MAX(p.date_key) AS day,
                /*
                 * **名字也要取最近那条的。**
                 *
                 * 原来这里写的是裸列 p.pet —— 分组之后它是「组里随便一行」的名字。
                 * 一只鱼改过名，presence 里就有新旧两种名字的行，面板可能一直显示旧的，
                 * 看起来像改名没生效。2026-11-05 用户问「改名了面板看不到吧」，
                 * 查下来一半是这个，一半是「改名只有下一次上报才进库」。
                 */
                /*
                 * 最近一条的名字和城市 —— **用窗口函数，不用相关子查询**（2026-11-11）。
                 *
                 * 原来是两个 「(SELECT … ORDER BY at DESC LIMIT 1)」，对**每一行**跑一次。
                 * 800 行明细 × 2 次子查询 = 单次请求几千行读；面板 30 秒轮询一次，
                 * 一天就是几百万行 —— 免费版每天 500 万行的额度就是这么烧光的
                 * （2026-11-10 Cloudflare 直接发信说 D1 行读超额，池子停了一整天）。
                 *
                 * 现在在子查询里一次算好 「rn」（每只鱼按时间倒序的第一行），
                 * 外面 「MAX(CASE WHEN rn = 1 …)」 取出来 —— 全表只扫一遍。
                 */
                MAX(CASE WHEN p.rn = 1 THEN p.pet END) AS pet,
                MAX(CASE WHEN p.rn = 1 THEN p.city END) AS city,
                COALESCE(f.kind, '') AS kind,
                COALESCE(f.note, '') AS note, COALESCE(f.at, '') AS flag_at,
                /*
                 * **名片（2026-11-12）。**
                 *
                 * Mr.Q 要在管理页看见谁写了什么、能不能管。
                 * profiles 的 uid 是主键，一个 uid 最多一行 —— 这个 JOIN 不会放大行数，
                 * 也就不会把 8 万行的额度账再翻一倍（那是 2026-11-10 停服的原因）。
                 *
                 * exp 一起取回来，是因为「过期了」和「没写过」在页面上要分开说：
                 * 前者是「他写了但已经撤回去了」，后者是「他从没写过」。
                 */
                MAX(pr.text) AS profile_text,
                MAX(pr.at) AS profile_at,
                MAX(pr.exp) AS profile_exp
           FROM (
             /*
              * 每只鱼标出「最近那一行」。
              *
              * 扫一遍就够，且**只取这五列** —— doing 不进来，
              * 明细表用不到它，少读一列就少一次行内解码。
              */
             SELECT uid, pet, city, date_key, at,
                    ROW_NUMBER() OVER (PARTITION BY uid ORDER BY at DESC) AS rn
               FROM presence
           ) p LEFT JOIN pet_flags f ON f.uid = p.uid
               LEFT JOIN profiles pr ON pr.uid = p.uid
          GROUP BY p.uid
          ORDER BY last DESC LIMIT ${limit}`,
      ).all();
      /*
       * **这个口只回「累计」，不再带今天/在线**（2026-11-11）。
       *
       * 三个数天然不一样（在册 / 今天来过 / 此刻在线），原来混在一个响应里，
       * 2026-11-06 Mr.Q 看到「管理页 25、面板 15」以为哪边坏了；
       * 2026-11-10 又问「我有两只鱼，何来一只在线」—— 都是同一个毛病：口径没摆在脸上。
       *
       * 这次不是改文案，是**拆接口**：实时那两个数去了 `/admin/live`。
       * 理由跟额度有关 —— 页面自动刷新时只需要那几个数，不该为此把全表明细拉一遍。
       *
       * `pets` 是**累计**（presence 里还剩的所有 uid，只留 KEEP_DAYS 天）。
       * 数的时候**按 `at`（真实时刻），不按 `date_key`（游戏内日期）** ——
       * 后者是两套时标，2026-11-10 数出来的 19 只从此不动，就是那个 bug。
       */
      return reply(200, {
        ok: true,
        /* 覆盖了几天 —— 累计块要和「在册几只」一起看，否则读不出量级。 */
        days: KEEP_DAYS,
        /* 顶满就是可能还有没列出来的 —— 让面板能说实话，而不是假装完了。 */
        truncated: (results ?? []).length >= limit,
        pets: (results ?? []).map((r) => ({
          uid: r.uid,
          pet: clean(r.pet, 24),
          rows: Number(r.rows ?? 0),
          cities: Number(r.cities ?? 0),
          days: Number(r.days ?? 0),
          /*
           * 面板要的是 `lastAt`（它拿这个格式化时间），早先这里回的是 `last` ——
           * 名字对不上，那一列也一样是「—」。两个都留着，谁读都不落空。
           */
          last: r.last,
          lastAt: r.last,
          day: r.day,
          city: clean(r.city, 24),
          kind: r.kind || '',
          note: clean(r.note, 60),
          flagAt: r.flag_at || '',
          /*
           * 名片。三种状态分开：
           *   `text` 有值、`expired: false` → 正常挂着
           *   `text` 有值、`expired: true`  → 过期了但行还在（还没被清）
           *   `text` 空                    → 没写过，或者自己撤回了
           *
           * 管理页要能看出区别 —— 「他从没写过」和「他写过又撤了」在处理上不是一回事。
           */
          profile: {
            text: clean(r.profile_text, 120),
            at: r.profile_at || '',
            expired: !!(r.profile_exp && Date.parse(r.profile_exp) <= Date.now()),
          },
        })),
      });
    }

    if (url.pathname === '/admin/flags') {
      const { results } = await db.prepare(
        'SELECT uid, pet, kind, note, at FROM pet_flags ORDER BY at DESC LIMIT 200',
      ).all();
      return reply(200, { ok: true, flags: results ?? [] });
    }

    /*
     * 本城设定（2026-11-15）。
     *
     * 这一支是整套「服务器主」概念的唯一落点：**有 ADMIN_KEY 的人就是服务器主**，
     * 不另外存一份「谁是主」。再存一份等于给同一件事造两个真相。
     */
    if (url.pathname === '/admin/life') {
      const townMeta = await readTown(db, env);
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const since24hIso = new Date(nowMs - 86_400_000).toISOString();
      const missing = [];
      let countRow = null;
      let listRes = null;
      let stallsRow = null;
      let dealsRow = null;

      try {
        [countRow, listRes] = await Promise.all([
          db.prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN at >= ?2 THEN 1 ELSE 0 END) AS active24h
               FROM town WHERE expires_at >= ?1`,
          ).bind(nowIso, since24hIso).first(),
          db.prepare(
            `SELECT uid, pet, street, at, expires_at
               FROM town
              WHERE expires_at >= ?1
              ORDER BY at DESC LIMIT 500`,
          ).bind(nowIso).all(),
        ]);
      } catch (e) {
        if (/no such table/i.test(String(e?.message || ''))) missing.push('town');
        else throw e;
      }

      try {
        stallsRow = await db.prepare(
          `SELECT COUNT(*) AS n
             FROM stalls
            WHERE stock > 0 AND expires_at >= ?1`,
        ).bind(nowIso).first();
      } catch (e) {
        if (/no such table/i.test(String(e?.message || ''))) missing.push('stalls');
        else throw e;
      }

      try {
        dealsRow = await db.prepare(
          `SELECT COUNT(*) AS n
             FROM deals
            WHERE at >= ?1`,
        ).bind(since24hIso).first();
      } catch (e) {
        if (/no such table/i.test(String(e?.message || ''))) missing.push('deals');
        else throw e;
      }

      const rawList = listRes?.results ?? [];
      const streetMap = new Map();
      const residents = rawList.map((r) => {
        const st = clean(r.street, 24) || '未定街道';
        streetMap.set(st, (streetMap.get(st) || 0) + 1);
        return {
          uid: String(r.uid || ''),
          pet: clean(r.pet, 24),
          street: clean(r.street, 24),
          at: String(r.at || ''),
          expiresAt: String(r.expires_at || ''),
        };
      });
      const total = Number(countRow?.total ?? residents.length) || 0;
      const active24h = Number(countRow?.active24h ?? 0) || 0;
      return reply(200, {
        ok: true,
        tableReady: missing.length === 0,
        missing,
        keepDays: TOWN_KEEP_DAYS,
        town: townMeta,
        total,
        active24h,
        activeStalls: Number(stallsRow?.n ?? 0) || 0,
        deals24h: Number(dealsRow?.n ?? 0) || 0,
        truncated: total > residents.length,
        byStreet: Array.from(streetMap.entries()).map(([street, count]) => ({ street, count })),
        residents,
        at: nowIso,
      });
    }

    if (url.pathname === '/admin/town' && method === 'GET') {
      return reply(200, { ok: true, town: await readTown(db, env) });
    }

    if (url.pathname === '/admin/town' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return reply(400, { ok: false, error: 'bad json' }); }
      const extra = bannedExtra(env);

      /*
       * 城 id 用的是 `okCity` 那一套格式，**不是随便起名**：
       * 它会被当成 `city` 写进 presence，journey 的 `/sight?city=` 会读它。
       * 带空格、带中文的 id 会让那边整条路 400，而报错只说 bad query。
       */
      /*
       * **这里不能先 `clean(id, 40)` 再校验。**
       *
       * `clean` 会把超长的值截到 40 位 —— 一个 41 位的 id 截完就变合法了，
       * 于是「填了 41 位」被静默存成「前 40 位」。而 id 会被写进 `city`，
       * 存成的东西和填进去的不一样，将来对不上要查很久。
       *
       * 所以先 trim 掉首尾空白（这个可以有），然后交给 `okCity` 验原值 ——
       * 它的字符集本来就排除了空格和控制字符，不需要 `clean` 帮忙。
       * 超长就明说太长，不替人做减法。
       */
      const id = String(body?.id ?? '').trim();
      if (!okCity(id)) {
        return reply(400, { ok: false, error: 'bad id' });
      }
      const name = safeText(body?.name, 24, extra);
      if (!name) {
        return reply(400, { ok: false, error: 'bad name' });
      }
      /* 空串允许：来历可以不写，读的时候会退默认。 */
      const origin = safeText(body?.origin, 400, extra);

      const list = (v, max, n) => (Array.isArray(v) ? v : [])
        .map((x) => safeText(x, max, extra))
        .filter(Boolean)
        .slice(0, n);
      const streets = list(body?.streets, 12, TOWN_LIST_MAX);
      const rules = list(body?.rules, 60, TOWN_LIST_MAX);
      /*
       * 两条都不能空 —— **空街名等于她没地方住，空城规等于没有城规**。
       * 允许清空会让「她住在一条没有名字的街上」这种状态合法化，
       * 而那不是设定，是没设完。
       */
      if (!streets.length || !rules.length) {
        return reply(400, { ok: false, error: 'bad lists' });
      }

      const nowIso = new Date().toISOString();
      try {
        await db.prepare(
          `INSERT INTO town_meta (id, name, origin, streets, rules, at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(id) DO UPDATE SET
             name = ?2, origin = ?3, streets = ?4, rules = ?5, at = ?6`,
        ).bind(id, name, origin, JSON.stringify(streets), JSON.stringify(rules), nowIso).run();
      } catch {
        /*
         * 表没建时的错要能看懂。默认那句 `D1_ERROR: no such table` 会让
         * 服务器主以为是自己填错了 —— 其实是迁移脚本没跑。
         */
        return reply(500, {
          ok: false,
          error: '写不进去：town_meta 表可能不存在，先跑 migrate-2026-11-15-town-meta.sql。',
        });
      }
      /* 本城设定全库只存一份；改换城 id 时清掉旧 id 那行，避免 readTown 读回旧记录。 */
      try {
        await db.prepare('DELETE FROM town_meta WHERE id <> ?1').bind(id).run();
      } catch (e) {
        return reply(500, {
          ok: false,
          error: `清理旧城设定失败：${e instanceof Error ? e.message : String(e)}`,
        });
      }
      /* 街道清单变更后，把 town 表里不再属于新街道的旧街名迁到首条新街，避免面板继续挂着旧城街名。 */
      let migrated = 0;
      try {
        const ph = streets.map((_, idx) => `?${idx + 2}`).join(',');
        const res = await db.prepare(`UPDATE town SET street = ?1 WHERE street NOT IN (${ph})`)
          .bind(streets[0], ...streets).run();
        migrated = Number(res?.meta?.changes ?? 0);
      } catch { /* town 表未迁移时忽略 */ }
      return reply(200, { ok: true, town: await readTown(db, env), migrated });
    }

    if (url.pathname === '/admin/flag' && method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return reply(400, { ok: false, error: 'bad json' }); }
      const uid = clean(body?.uid, 64);
      const kind = clean(body?.kind, 8);
      const pet = clean(body?.pet, 24);
      const note = clean(body?.note, 60);
      if (!okUid(uid) || !['ban', 'rename', 'ok'].includes(kind)) {
        return reply(400, { ok: false, error: 'bad fields' });
      }
      if (kind === 'ok') {
        await db.prepare('DELETE FROM pet_flags WHERE uid = ?1').bind(uid).run();
        return reply(200, { ok: true, uid, kind: 'ok' });
      }
      await db.prepare(
        `INSERT INTO pet_flags (uid, pet, kind, note, at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(uid) DO UPDATE SET pet = ?2, kind = ?3, note = ?4, at = ?5`,
      ).bind(uid, pet, kind, note, new Date().toISOString()).run();
      return reply(200, { ok: true, uid, kind });
    }

    if (url.pathname === '/admin/stats') {
      /* 一律按 `at`（真实时刻）数 —— `date_key` 是游戏内日期，跟「今天」不是一回事。 */
      const since = todayStartIso();
      const [rateRow, dayRow, uidRow, onlineRow, totalRow, cityRes] = await Promise.all([
        db.prepare('SELECT n FROM rate WHERE key = ?1').bind(`d:${day}`).first(),
        db.prepare('SELECT COUNT(*) AS n FROM presence INDEXED BY idx_presence_at_uid WHERE at >= ?1').bind(since).first(),
        db.prepare('SELECT COUNT(DISTINCT uid) AS n FROM presence INDEXED BY idx_presence_at_uid WHERE at >= ?1').bind(since).first(),
        db.prepare('SELECT COUNT(DISTINCT uid) AS n FROM presence INDEXED BY idx_presence_at_uid WHERE at >= ?1')
          .bind(onlineSinceIso()).first(),
        db.prepare('SELECT COUNT(*) AS n FROM presence').first(),
        db.prepare(`SELECT city, COUNT(*) AS n FROM presence INDEXED BY idx_presence_at_uid
                    WHERE at >= ?1 GROUP BY city ORDER BY n DESC LIMIT 12`).bind(since).all(),
      ]);

      const posts = Number(rateRow?.n ?? 0);
      return reply(200, {
        ok: true,
        day,
        today: {
          posts,                                   // 今天上报了几次（rate 计数）
          rows: Number(dayRow?.n ?? 0),            // 今天库里有多少格
          uids: Number(uidRow?.n ?? 0),            // 今天有多少只宠物出现过
          online: Number(onlineRow?.n ?? 0),       // 此刻在线（最近 30 分钟有上报）
        },
        budget: {
          cap: DAILY_WRITE_CAP,
          used: posts,
          ratio: DAILY_WRITE_CAP ? Math.min(1, posts / DAILY_WRITE_CAP) : 0,
        },
        tables: {
          presence: Number(totalRow?.n ?? 0),
          rowsPerPost: ROWS_PER_POST,
        },
        cities: (cityRes?.results ?? []).map((r) => ({ city: r.city, n: Number(r.n) })),
      });
    }

    // /admin/list
    const city = clean(url.searchParams.get('city'), 40);
    const slot = clean(url.searchParams.get('slot'), 12);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));

    const where = ['date_key = ?1'];
    const args = [day];
    if (city) { args.push(city); where.push(`city = ?${args.length}`); }
    if (slot) { args.push(slot); where.push(`slot = ?${args.length}`); }

    const { results } = await db.prepare(
      `SELECT uid, pet, city, date_key, slot, doing, at FROM presence
       WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ${limit}`,
    ).bind(...args).all();

    return reply(200, {
      ok: true,
      day,
      rows: (results ?? []).map((r) => ({
        uid: maskUid(r.uid),
        pet: clean(r.pet, 24),
        city: r.city,
        slot: r.slot,
        doing: clean(r.doing, 40),
        at: r.at,
      })),
    });
  } catch (e) {
    recordError(env, null, '[sight admin]', e, '/sight/admin');
    return reply(500, { ok: false, error: 'server error' });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // 预检：浏览器发 POST(JSON) 前会先问一次。
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    /*
     * 管理接口（只读）。给 `site/admin.html` 用。
     *
     * **没配 `ADMIN_KEY` 时整条路 404** —— 默认关闭，不是默认开放。
     * 部署时用 `wrangler secret put ADMIN_KEY` 设一个长随机串，
     * 不设就等于没有这个接口。
     *
     * 2026-11-05 扩了一条写入口：`POST /admin/flag`（ban / rename / ok）。
     * 原来这里写着「不给网页留写入口」—— 那条规矩是为了少一个能搞坏数据的地方，
     * 但 Mr.Q 要的是能自己判断谁该封、封完立刻生效，只读面板做不到这件事。
     * 折中：写入口只有一条、只认三种取值、整个口由 ADMIN_KEY 挡着。
     */
    /*
     * 管理接口。2026-11-05 从「只读」扩成可写（被封的那只鱼要能真的挡在门外）——
     * 但写入口只有一个 `/admin/flag`，三种取值，别的一概不动。
     */
    /*
     * 这张白名单**必须和 `adminRoute` 里的分支一一对应**。
     *
     * 2026-11-11 加 `/admin/live` 时忘了加这儿 —— 新路由写好了、语法也对、
     * 单元测试直接 404。报错长得像「接口没实现」，其实是没进分发。
     */
    if (url.pathname === '/admin/stats' || url.pathname === '/admin/list'
        || url.pathname === '/admin/live'
        || url.pathname === '/admin/pets' || url.pathname === '/admin/flags'
        || url.pathname === '/admin/flag'
        || url.pathname === '/admin/town'
        || url.pathname === '/admin/life') {
      return adminRoute(request, env, url, method);
    }

    /*
     * 只认这三个路径，其他一律 404 —— 不给扫描器留探测面。
     *
     *   /sight          到站上报、看看这一带还有谁
     *   /sight/invite   邀约：POST 发一条，GET 收同城别人发的
     *   /sight/accept   接一条
     *
     * 尾斜杠一律剥掉再比 —— 用户从浏览器直接试的时候很容易多打一个。
     */
    const path = url.pathname.replace(/\/+$/, '') || '/';
    // 扩展市场索引的镜像。放在最前面：它跟碰面池一点关系都没有，也不碰 D1。
    if (path.startsWith('/market2/')) return marketProxy(path.slice('/market2'.length), ctx);
    if (path === '/sight/status') return statusRoute(request, env, url, ctx);
    if (path === '/sight/invite') return inviteRoute(request, env, url, method);
    if (path === '/sight/accept') return acceptRoute(request, env, url, method);
    if (path === '/sight/card') return cardRoute(request, env, url, method);
    if (path === '/sight/profile') return profileRoute(request, env, url, method);
    if (path === '/sight/footprints') return footprintRoute(request, env, url, method);
    if (path === '/sight/signposts') return signpostRoute(request, env, url, method);
    /* 本城设定：公开只读。给目录、健康检查、别的城用（§4.18）。 */
    if (path === '/town/info') return townInfoRoute(env);
    if (path === '/town/join') return townJoinRoute(request, env, method);
    if (path === '/town/stalls') return townStallsRoute(request, env, method, ctx);
    if (path === '/town/buy') return townBuyRoute(request, env, method, ctx);
    if (path === '/town/deals' || path === '/town/deals/seen') return townDealsRoute(request, env, url, method, path);
    // 根路径给人看（浏览器里打开的那种），别回一句 not found。
    if (path === '/' && (method === 'GET' || method === 'HEAD')) return landingPage(env, url, ctx);
    // 管鱼页：同一个域名发出去，国内能打开；页面里地址栏会自动填成它自己。
    /*
     * 管鱼页有**两个地址**（2026-11-11）：
     *   `/pets`      → 「此刻」（实时，自动刷新）
     *   `/pets/all`  → 「在册」（累计，手动刷新）
     *
     * 界面上是两块页签，这里给两个地址是为了「收藏哪个打开就是哪个」。
     */
    if ((path === '/pets' || path === '/pets.html' || path === '/pets/all'
      || path === '/pets/life' || path === '/pets/town')
      && (method === 'GET' || method === 'HEAD')) {
      return new Response(petsPage, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          /*
           * **别再缓存 10 分钟**（原来是 `public, max-age=600`）。
           *
           * 2026-11-11 一上午两次「怎么还是旧的」都是它：部署完了，浏览器还拿
           * 十分钟前那份 HTML，新加的界面看不见，看着像没上线。
           * 这张页面只有几 KB，每次都让浏览器回源问一句，比让人怀疑部署失败便宜。
           */
          'cache-control': 'no-cache',
        },
      });
    }
    if (path !== '/sight') return reply(404, { ok: false, error: 'not found' });

    const db = env.DB;
    if (!db) return reply(500, { ok: false, error: 'server error' });

    try {
      /* ---------------- 查：同城同日同时段还有谁 ---------------- */
      if (method === 'GET') {
        const city = clean(url.searchParams.get('city'), 40);
        const slot = clean(url.searchParams.get('slot'), 12);
        const exclude = clean(url.searchParams.get('exclude'), 64);
        const rawWin = Number(url.searchParams.get('window'));
        const windowMs = Number.isFinite(rawWin) && rawWin > 0
          ? Math.min(MAX_NEIGHBOR_WINDOW_MS, Math.max(60_000, Math.round(rawWin)))
          : RECENT_NEIGHBOR_MS;
        const rawLim = Number(url.searchParams.get('limit'));
        const limit = Number.isFinite(rawLim) && rawLim > 0
          ? Math.min(MAX_NEIGHBOR_LIMIT, Math.max(1, Math.floor(rawLim)))
          : MAX;
        /*
         * `date` 不再参与筛选（2026-11-10），参数收到也不报错 ——
         * 旧客户端还在传，多一个没用的参数不该让它 400。
         */
        if (!okCity(city) || !SLOTS.has(slot)) {
          return reply(400, { ok: false, error: 'bad query' });
        }

        const since = new Date(Date.now() - windowMs).toISOString();
        // 按 uid 去重并取该 uid 在窗口内的最新一条，防止 24h 窗口下高倍速鱼用多个 date_key 占满名额。
        const stmt = exclude
          ? db.prepare(
            `SELECT pet, doing, MAX(at) AS lat FROM presence
             WHERE city = ?1 AND slot = ?2 AND at >= ?3 AND uid <> ?4
             GROUP BY uid
             ORDER BY lat DESC LIMIT ${limit}`,
          ).bind(city, slot, since, exclude)
          : db.prepare(
            `SELECT pet, doing, MAX(at) AS lat FROM presence
             WHERE city = ?1 AND slot = ?2 AND at >= ?3
             GROUP BY uid
             ORDER BY lat DESC LIMIT ${limit}`,
          ).bind(city, slot, since);

        /*
         * 邻居列表和两个计数一起发出去（2026-11-12）。原来 `pool` / `online`
         * 是两个独立的 `COUNT(DISTINCT uid)`，每来一次请求就全表扫两遍 ——
         * 这是 D1 读额度被顶穿的主因，现在走 `poolAndOnline()` 的一次扫描 + 一分钟缓存。
         */
        const [{ results }, counts, hereRow] = await Promise.all([
          stmt.all(),
          poolAndOnline(db, ctx).catch(() => ({ pool: 0, online: 0 })),
          /*
           * **今天这座城来过几只**（2026-11-14）。
           *
           * `pool` 是「全池子今天来过多少只」，跨城统计 —— 一个人在小城待着，
           * 那个数会显示几十，但她周围其实一个人都没有。这个数只算当前城。
           *
           * 成本实测：热门城（西安 17 只）读 122 行，小城 13 行 —— 走
           * `idx_presence_query (city=?)` 只扫该城 4 天留存内的行，很便宜。
           */
          db.prepare(
            'SELECT COUNT(DISTINCT uid) AS n FROM presence WHERE city = ?1 AND at >= ?2',
          ).bind(city, todayStartIso()).first().catch(() => null),
        ]);
        /*
         * **只挑两个字段。** 防线设在最外层：以后有人改了客户端或 SQL，
         * 这里仍然漏不出 id 和时间戳。
         *
         * 再洗一遍名字 —— 过滤是后加的，库里可能有更早写进去的脏数据。
         * 读的时候也过一道，历史数据才不会漏出去。
         */
        const extra = bannedExtra(env);
        const list = (results || [])
          .map((r) => ({
            pet: safePet(r.pet, extra).name,
            doing: safeDoing(r.doing, extra),
          }))
          .filter((r) => r.pet);

        /*
         * **这个池子今天一共多少只**（不分城市）。
         *
         * 2026-11-05 加的。面板原来只有「同城几个」，而一个人用的时候那一行永远是
         * 「这段时间没别人」—— 用户没法判断是「没人」还是「这条线坏了」，
         * 也没法判断这个功能到底有没有人在用。给一个总数，这两件事同时解决。
         *
         * 只回**数量**，不回任何 uid/名字 —— 聚合数字不构成隐私问题。
         * 旧客户端会忽略这个字段，旧服务端不回它，客户端那边按 0 处理。
         */
        return reply(200, {
          ok: true,
          list,
          pool: counts.pool,
          online: counts.online,
          here: Number(hereRow?.n ?? 0) || 0,
        });
      }

      /* ---------------- 报：我在这儿 ---------------- */
      if (method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return reply(400, { ok: false, error: 'bad json' }); }

        const uid = clean(body?.uid, 64);
        const city = clean(body?.city, 40);
        const date = clean(body?.date, 10);
        const slot = clean(body?.slot, 12);

        /*
         * 名字和「在干嘛」是**唯二会出现在别人屏幕上的字段**，所以在这里洗。
         * 洗在写入前，不是读的时候才遮 —— 脏数据不进库，管理面板看到的也是干净的。
         */
        const extra = bannedExtra(env);
        const washed = safePet(body?.pet, extra);
        const pet = washed.name;
        const doing = safeDoing(body?.doing, extra);

        if (!okUid(uid) || !okCity(city) || !okDate(date) || !SLOTS.has(slot) || !pet) {
          return reply(400, { ok: false, error: 'bad fields' });
        }
        if (washed.flagged) {
          // 只记打码后的 uid，够定位是哪只鱼，又不留完整标识
          console.warn('[sight] pet name replaced', maskUid(uid));
        }

        /*
         * 人工标记：被封的连上报都不收。
         *
         * 挡在写入这一处，读的时候就不用每条查询都挂条件 —— 散在查询里早晚漏一处。
         */
        const flag = await flagOf(db, uid);
        if (flag?.kind === 'ban') return reply(403, { ok: false, error: 'banned' });

        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        const ip = await ipHash(request);

        /* ---- 限速：三条日限，一条 SQL 查完 ---- */
        /*
         * key 里带 UTC 日期，所以「按天」是天然完成的 —— 不需要在 SQL 里
         * 判断窗口有没有过期，跨天就是换了一个 key，从 1 重新数。
         */
        const day = nowIso.slice(0, 10);
        const keys = [`u:${uid}:${day}`, `d:${day}`];
        if (ip) keys.splice(1, 0, `i:${ip}:${day}`);

        const marks = keys.map((_, i) => `?${i + 1}`).join(',');
        const { results: counted } = await db
          .prepare(`SELECT key, n FROM rate WHERE key IN (${marks})`)
          .bind(...keys).all();

        const got = new Map((counted || []).map((r) => [r.key, Number(r.n) || 0]));
        const nUid = got.get(`u:${uid}:${day}`) ?? 0;
        const nIp = ip ? got.get(`i:${ip}:${day}`) ?? 0 : 0;
        const nAll = got.get(`d:${day}`) ?? 0;

        if (nUid >= UID_PER_DAY) return reply(429, { ok: false, error: 'too many' });
        if (ip && nIp >= IP_PER_DAY) return reply(429, { ok: false, error: 'too many' });
        if (nAll >= DAILY_WRITE_CAP) {
          console.error('[sight] daily cap hit', nAll);
          return reply(503, { ok: false, error: 'busy' });
        }

        /*
         * 撞主键 **(uid, date_key, slot)** 就更新 —— 同一天同一时段只留最新那条。
         * 她一天里换几个地方，留下的就是最后一次，那才是「这会儿她在哪」。
         *
         * ## 主键里为什么不再带 `city`（2026-11-07）
         *
         * 带 city 时，「换一座城」不是覆盖而是**多一行**：一天换 2 城 = 8 行，
         * 4 天留存 = 32 行（管理面板上那只「31 格」的鱼就是这么来的）。
         * 而 `/sight/status` 每次都要 `SELECT COUNT(DISTINCT uid) ... WHERE date_key=?`
         * 把当天所有行扫一遍 —— 行数直接乘进 D1 的读取额度。
         *
         * 去掉 city 之后：一只鱼一天最多 4 行（4 个时段），全表小 2–8 倍，
         * 语义一点没变（城市跟着最后一次上报走）。
         */
        await db.prepare(
          /*
           * **内容没变就别写**（2026-11-15）。
           *
           * 心跳一天上万次，而 `doing` 一小时未必变一次 —— 每次心跳都原样写一遍，
           * 代价是 1 行表 + 5 个索引（实测平均 4.3 行/次），换来的只是 `at` 挪一格。
           *
           * ## 为什么不能把 `at` 一起省掉
           *
           * `online`（此刻在线多少只）按「最近 30 分钟有上报」算（`ONLINE_WINDOW_MS`）。
           * `at` 不刷就会把在线的人判成离线。所以留一道**兜底**：内容没变时，
           * 最多 25 分钟也要写一次 —— 比窗口短 5 分钟，留出时钟漂移和请求排队。
           *
           * 用 `julianday` 而不是 `datetime(...)` 比较：后者吐出 `YYYY-MM-DD HH:MM:SS`，
           * 跟 `excluded.at` 那个带 T/Z 的 ISO 串格式不同，比大小会出错。
           *
           * ## `ip_hash` 故意不进这个判断（2026-11-15 深夜纠正）
           *
           * 第一版把 `ip_hash` 也算进「变了才写」，结果命中率只有 5%。
           * 查数据：414 只鱼对应 963 个不同 ip_hash —— 移动网络、代理、IPv6 轮换
           * 每换一次就是一条「变化」。而这个字段只是**记录**（风控去看「同一 IP 几只鱼」），
           * 不是她的状态，没必要每次都最新。
           *
           * 去掉它之后，触发写入的只剩 pet / city / doing 三个真状态 + 25 分钟兜底。
           */
          `INSERT INTO presence (uid, pet, city, date_key, slot, doing, at, ip_hash)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT(uid, date_key, slot) DO UPDATE SET
             pet = excluded.pet,
             city = excluded.city,
             doing = excluded.doing,
             at = excluded.at,
             ip_hash = excluded.ip_hash
           WHERE presence.pet <> excluded.pet
              OR presence.city <> excluded.city
              OR presence.doing <> excluded.doing
              OR (julianday(excluded.at) - julianday(presence.at)) * 1440 >= 25`,
        ).bind(uid, pet, city, date, slot, doing, nowIso, ip).run();

        /*
         * 计数放在写入成功之后 —— 被上面三条挡下的请求不消耗配额，
         * 不然一个狂刷的脚本能靠「被拒」把全站额度顶满。
         */
        const expSec = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + 86_400;
        const vals = keys.map((_, i) => `(?${i * 2 + 1}, 1, ?${i * 2 + 2})`).join(',');
        await db.prepare(
          `INSERT INTO rate (key, n, exp) VALUES ${vals}
           ON CONFLICT(key) DO UPDATE SET n = rate.n + 1`,
        ).bind(...keys.flatMap((k) => [k, expSec])).run();

        // 「请她改名」是软标记：照常上报，只在回执里多说一句，客户端可转成提醒。
        return reply(200, flag?.kind === 'rename' ? { ok: true, notice: 'rename' } : { ok: true });
      }

      return reply(405, { ok: false, error: 'method not allowed' });
    } catch (e) {
      /*
       * 不把内部错误回给调用方 —— 日志里留着就够了。
       * 尤其别把 D1 的报错原文带出去，里面可能有表结构。
       */
      recordError(env, null, '[sight]', e, '/sight');
      return reply(500, { ok: false, error: 'server error' });
    }
  },

  /**
   * 定时清理。`wrangler.toml` 里的 `[triggers] crons` 每小时叫一次。
   *
   * 干两件事：
   * 1. **删四天前的 presence。** 不删的话表会一直长 —— 一天五万行，一个月一百五十万行，
   *    免费版 5 GB 存储撑不到年底。查询只用到今天和昨天，留四天很宽松。
   * 2. **删过期的 rate 行。** 理论上这张表大小约等于「用户数 + IP 数」不会涨
   *    （同一个 key 会一直复用），但换过 IP 的用户会留下旧行，顺手清掉。
   *
   * 每次都限量删（`PURGE_BATCH`）—— 一小时五千行，一天十二万行，
   * 够覆盖最坏情况（五万行/天），又不会让单次执行太久。
   *
   * **判据是 `at`，不是 `date_key`**（2026-11-10）。`date_key` 是游戏内日期，
   * 按它删有两个方向的错：跑到 2027 年的行**永远删不掉**（线上真实存在，
   * 越攒越多），而游戏日期比现实落后的行又会被提前删掉。`at` 是真实写入时刻，
   * 才是「四天前」该用的那把尺。
   */
  async scheduled(event, env) {
    const db = env?.DB;
    if (!db) return;

    const cutoffIso = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
    const nowSec = Math.floor(Date.now() / 1000);
    const nowIso = new Date().toISOString();

    try {
      const p = await db.prepare(
        `DELETE FROM presence WHERE rowid IN
           (SELECT rowid FROM presence WHERE at < ?1 LIMIT ${PURGE_BATCH})`,
      ).bind(cutoffIso).run();
      const r = await db.prepare(
        `DELETE FROM rate WHERE rowid IN
           (SELECT rowid FROM rate WHERE exp < ?1 LIMIT ${PURGE_BATCH})`,
      ).bind(nowSec).run();
      /*
       * 邀约按「过期」删，不按日期 —— 一条昨天发、今晚才过期的邀约，
       * 按日期删会提前把它拿走。
       */
      const i = await db.prepare(
        `DELETE FROM invites WHERE rowid IN
           (SELECT rowid FROM invites WHERE expires_at < ?1 LIMIT ${PURGE_BATCH})`,
      ).bind(nowIso).run();
      /*
       * 接单记录要跟着邀约一起清 —— **清孤儿，不按时间**。
       *
       * 2026-11-05 加这张表时漏了这一步：邀约过期被删、`invite_takers` 的行留着，
       * 表就会一直长（一天几十条，一年也是一万多行白占额度）。
       * 用 LEFT JOIN 找「对应邀约已经不存在」的行，比按时间删安全：
       * 一条还没过期的邀约，它的 takers 一条都不能动。
       */
      const t = await db.prepare(
        `DELETE FROM invite_takers WHERE rowid IN
           (SELECT t.rowid FROM invite_takers t
              LEFT JOIN invites i ON i.id = t.id
             WHERE i.id IS NULL LIMIT ${PURGE_BATCH})`,
      ).run();
      /*
       * 卡也跟着邀约一起清（2026-11-11）。同一条道理：邀约过期被删，
       * `party_cards` 的行留着就是孤儿 —— 没人取得到（鉴权查的 `invites` 已经不在了），
       * 但占着额度，而且里面可能存着别人给的号。
       * **按 `id` 清孤儿，不按 `exp`**：30 天的卡不该被 4 天的 presence 窗口带走。
       */
      const c = await db.prepare(
        `DELETE FROM party_cards WHERE rowid IN
           (SELECT c.rowid FROM party_cards c
              LEFT JOIN invites i ON i.id = c.id
             WHERE i.id IS NULL LIMIT ${PURGE_BATCH})`,
      ).run();
      /*
       * 名片按自己的 exp 删（2026-11-11）。它不挂在任何一条邀约上 ——
       * 名片是「这个人」，不是「这一趟」，所以不能用孤儿清理那套。
       * 30 天不续就等于自己收回去，这里只是把行真的删掉。
       */
      const pf = await db.prepare(
        `DELETE FROM profiles WHERE rowid IN
           (SELECT rowid FROM profiles WHERE exp < ?1 LIMIT ${PURGE_BATCH})`,
      ).bind(nowIso).run();
      /*
       * **路标和错误表原来没进这里**（2026-11-16 补）。
       *
       * 路标的过期只在「同一座城发新路标」时才顺手裁一次 —— 冷门城市没人再发，
       * 那些过期条目就一直躺着。`signposts` 是永久累积的表，不清会无限增长。
       *
       * `errors` 是诊断用的，留 7 天足够回看一次事故；再久也不会有人翻。
       */
      const sp = await db.prepare(
        `DELETE FROM signposts WHERE rowid IN
           (SELECT rowid FROM signposts WHERE expires_at < ?1 LIMIT ${PURGE_BATCH})`,
      ).bind(nowIso).run();
      const errCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
      const er = await db.prepare(
        `DELETE FROM errors WHERE rowid IN
           (SELECT rowid FROM errors WHERE day < ?1 LIMIT ${PURGE_BATCH})`,
      ).bind(errCutoff).run();
      const tn = await db.prepare(
        `DELETE FROM town WHERE rowid IN
           (SELECT rowid FROM town WHERE expires_at < ?1 LIMIT ${PURGE_BATCH})`,
      ).bind(nowIso).run().catch(() => null);
      const st = await db.prepare(
        `DELETE FROM stalls WHERE rowid IN
           (SELECT rowid FROM stalls WHERE expires_at < ?1 LIMIT ${PURGE_BATCH})`,
      ).bind(nowIso).run().catch(() => null);
      const dl = await db.prepare(
        `DELETE FROM deals WHERE rowid IN
           (SELECT rowid FROM deals WHERE expires_at < ?1 LIMIT ${PURGE_BATCH})`,
      ).bind(nowIso).run().catch(() => null);
      console.log(
        '[sight] purge', cutoffIso,
        'presence', p?.meta?.changes ?? '?',
        'rate', r?.meta?.changes ?? '?',
        'invites', i?.meta?.changes ?? '?',
        'cards', c?.meta?.changes ?? '?',
        'profiles', pf?.meta?.changes ?? '?',
        'takers', t?.meta?.changes ?? '?',
        'signposts', sp?.meta?.changes ?? '?',
        'errors', er?.meta?.changes ?? '?',
        'town', tn?.meta?.changes ?? '?',
        'stalls', st?.meta?.changes ?? '?',
        'deals', dl?.meta?.changes ?? '?',
      );
    } catch (e) {
      console.error('[sight] purge failed', e && e.message ? e.message : e);
    }
  },
};
