#!/usr/bin/env node
/*
 * 从 TourMind 拉真实酒店数据，落成 `data/hotel-facts.json`。
 *
 * ## 为什么要做这件事
 *
 * 2026-11-09 Mr.Q： 「你就让子agent去查查 185 座城市的酒店呗，
 * 把它有什么设施、活动都全部查清楚嘛，以后别再返工了。我也不差那点 token。」
 *
 * 返工的根源是：原来的酒店信息全是**猜**的 ——
 * 档位靠名字里的「大酒店」「国际」，设施靠模板里的「温泉度假酒店·带私汤」。
 * 用户去携程一查，二钻、92 块、只有餐厅和停车场。
 *
 * TourMind 的 `get_hotel_detail` 给三样真东西：
 *   - `amenities_hotel` / `amenities_room` —— 结构化设施清单
 *   - `descriptions.Attractions` —— 周边景点 + 距离（这就是「周遭环境」）
 *   - `star_rating` + `min_price` —— 档次和真实房价
 *
 * 拉一次存下来，以后代码只读本地，不再联网猜。
 *
 * ## 用法
 *
 *   node tools/fetch-hotel-facts.mjs                # 全量（断点续跑）
 *   node tools/fetch-hotel-facts.mjs --only chengdu,lanzhou
 *   node tools/fetch-hotel-facts.mjs --index-only   # 只跑第一遍（城市→酒店池）
 *   node tools/fetch-hotel-facts.mjs --refresh chengdu   # 重查某城
 *
 * 进度写在 `data/hotel-facts.json` 里，中断再跑会跳过已完成的城市。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'data', 'hotel-facts.json');

const UPSTREAM = 'https://api.tourmind.com/mcp/toc';
const PROTO = '2025-06-18';

/* ---------------------------------------------------------------- 上游调用 */

let sid = null;

function parseSse(text) {
  const out = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const payload = buf.join('\n').trim();
    buf = [];
    if (payload && payload !== '[DONE]') out.push(JSON.parse(payload));
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === '') flush();
    else if (line.startsWith('data:')) buf.push(line.slice(5).trimStart());
  }
  flush();
  return out;
}

async function post(msg, timeout = 60000) {
  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': PROTO,
  };
  if (sid) headers['Mcp-Session-Id'] = sid;
  const res = await fetch(UPSTREAM, {
    method: 'POST',
    headers,
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(timeout),
  });
  const nextSid = res.headers.get('mcp-session-id');
  if (nextSid && msg.method === 'initialize') sid = nextSid;
  if (res.status === 202 || res.status === 204) return [];
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  if (!body.trim()) return [];
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('event-stream') ? parseSse(body) : [JSON.parse(body)];
}

async function handshake() {
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'hotel-facts', version: '1' } },
  });
  if (!init.find((m) => m.id === 1)?.result) throw new Error('TourMind 握手失败');
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

async function call(name, args, timeout = 60000) {
  const msgs = await post(
    { jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method: 'tools/call', params: { name, arguments: args } },
    timeout,
  );
  const hit = msgs.find((m) => m.result || m.error);
  if (hit?.error) throw new Error(`${name}: ${JSON.stringify(hit.error).slice(0, 200)}`);
  const text = hit?.result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 重试。上游并发时偶尔会 429 或短暂 5xx ——
 * 2026-11-09 第一轮 185 城并发 8，17 个城市报「酒店池为空」，
 * 但单独再查（比如东京）是好的，说明是限流不是没数据。
 * 判据：**报错和空结果是两件事**，空结果不重试，报错要重试。
 */
async function retry(fn, times = 3) {
  let last;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw last;
}

/* ---------------------------------------------------------------- 设施归一化 */

/*
 * 只保留「能写进描述」的那些设施 —— 不追求把上游 200 个英文项全翻一遍，
 * 那既做不完也没用：游戏里只有 `feel` 那一两句话用得上。
 *
 * 判据：**这一项能不能变成一句人话**。能，就留；不能（`Vending machine`、
 * `Wheelchair accessible – no`），丢掉 —— 写进描述只会变成堆砌。
 */
const FLAGS = [
  ['pool', /swimming pool|indoor pool|outdoor pool|游泳池/i, '泳池'],
  ['onsen', /hot spring|温泉|onsen/i, '温泉'],
  ['spa', /\bspa\b|massage|sauna|steam room|温泉浴|桑拿/i, '桑拿/SPA'],
  ['gym', /fitness|health club|gym|健身房/i, '健身房'],
  ['restaurant', /restaurant|餐厅|breakfast|早餐/i, '餐厅'],
  ['bar', /\bbar\b|lounge|酒吧/i, '酒吧'],
  ['parking', /parking|停车/i, '停车场'],
  ['shuttle', /shuttle|airport|接送|机场/i, '接送'],
  ['laundry', /laundry|dry cleaning|洗衣/i, '洗衣'],
  ['front24', /24-hour front desk|24小时前台/i, '24小时前台'],
  ['luggage', /luggage|porter|bellhop|行李/i, '行李寄存'],
  ['elevator', /elevator|lift|电梯/i, '电梯'],
  ['ac', /air condition|空调/i, '空调'],
  ['wifi', /\bwi-?fi\b|wireless|上网|网络/i, 'WiFi'],
  ['meeting', /meeting|banquet|conference|会议/i, '会议室'],
  ['nosmoke', /smoke-free|non-smoking|无烟|禁烟/i, '无烟'],
  ['pet', /pet friendly|pets allowed|宠物/i, '可带宠物'],
];

function flagsOf(hotel) {
  const names = [
    ...(hotel.amenities_hotel ?? []),
    ...(hotel.amenities_room ?? []),
  ].map((x) => String(x?.name ?? ''));

  /*
   * 反向项要先排除：上游会写 `Wheelchair accessible – no`、`No accessible shuttle`，
   * 含关键词但意思是「没有」。判据：`– no` / `No ` 开头的整条丢掉。
   */
  const positive = names.filter((n) => !/–\s*no$/i.test(n) && !/^no\s/i.test(n));
  const blob = positive.join(' | ');
  const out = [];
  for (const [key, re, label] of FLAGS) if (re.test(blob)) out.push({ key, label });
  return out;
}

/* 周边景点：`Attractions` 长这样 ——
 *   `Huai Hai Road Shopping District - 0.4 km / 0.3 mi <br /> …`
 * 只取前 10 个，只要公里数。 */
function aroundOf(hotel) {
  const raw = String(hotel.descriptions?.Attractions ?? '');
  if (!raw) return [];
  const out = [];
  for (const piece of raw.split(/<br\s*\/?>/i)) {
    const m = /^(.+?)\s*-\s*([\d.]+)\s*km/i.exec(piece.replace(/<[^>]+>/g, ' ').trim());
    if (!m) continue;
    const name = m[1].trim();
    const km = Number(m[2]);
    if (!name || !Number.isFinite(km)) continue;
    out.push({ n: name, km: Math.round(km * 10) / 10 });
    if (out.length >= 10) break;
  }
  return out;
}

function shrink(hotel, listItem) {
  return {
    id: hotel.hotel_id ?? listItem?.hotel_id,
    name: String(hotel.name_cn || hotel.name || listItem?.hotel_name_cn || '').trim(),
    star: Number(hotel.star_rating ?? listItem?.star_rating ?? 0) || 0,
    price: Number(listItem?.min_price ?? 0) || 0,
    addr: String(hotel.address_cn || hotel.address || listItem?.address_cn || '').trim(),
    flags: flagsOf(hotel).map((f) => f.key),
    amen: flagsOf(hotel).map((f) => f.label),
    around: aroundOf(hotel),
  };
}

/* ---------------------------------------------------------------- 分档取样 */

/*
 * 每城留多少家：四个档位各 2 家。
 *
 * 为什么不是全留：detail 一家 100KB（58 个房型 + 图片），185 城全留要 200MB，
 * 而且游戏里一城最多住三四晚 —— **用不上的数据不该进包**。
 * 四档 × 2 家在真实店铺里已经够抽签了。
 *
 * 档位按 `star_rating` 分（这是上游给的真星级，不是名字猜的）：
 *   5 星 → luxury，4 星 → view，3 星 → budget，≤2 星 → dingy
 */
const TIER_OF_STAR = (star) => (star >= 5 ? 'luxury' : star === 4 ? 'view' : star === 3 ? 'budget' : 'dingy');
const PER_TIER = 3;

function pickPerTier(list) {
  const byTier = new Map();
  for (const h of list) {
    const star = Number(h.star_rating ?? 0);
    if (!star) continue; // 没星级的无法分档，跳过
    const tier = TIER_OF_STAR(star);
    const bucket = byTier.get(tier) ?? [];
    /* 同档里优先取价格差异大的 —— 便宜的和贵的各留一家，别留两家一模一样的 */
    bucket.push(h);
    byTier.set(tier, bucket);
  }
  const chosen = [];
  for (const [, bucket] of byTier) {
    const sorted = [...bucket].sort((a, b) => Number(a.min_price ?? 0) - Number(b.min_price ?? 0));
    if (sorted.length <= PER_TIER) chosen.push(...sorted);
    else chosen.push(sorted[0], sorted[sorted.length - 1]);
  }
  return chosen;
}

/* ---------------------------------------------------------------- 并发池 */

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        out[i] = { error: e.message };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------------------------------------------------------- 城市解析 */

/**
 * 候选区域，按「有多像这座城市」排序。
 *
 * 2026-11-09 两个坑都出在这一步：
 *
 * 1. **同名区域不止一个。** 格尔木有 79 家和 17 家两个 City 区域，
 *    默认取第一个（79 家）—— 那一片恰好没有可订房源，于是报「池为空」，
 *    看起来像「TourMind 没有格尔木」。实际 17 家那个区域有房。
 * 2. **中文名会撞到别处。** 搜「加里宁格勒」第一个 City 型结果是「维什尼沃耶」。
 *
 * 所以返回**候选列表**，让调用方逐个试到有房源为止；
 * 排序上，名字完全一样的排最前，其次同国、其次店多的。
 */
async function regionsOf(city) {
  const res = await retry(() => call('search_location', { keyword: city.name }, 45000));
  const regions = res?.data?.regions ?? [];
  const wantCountry = city.country === 'CN' ? 'China' : null;
  const cities = regions.filter((r) => r.region_type === 'City');

  const score = (r) => {
    let n = 0;
    if (r.name_cn === city.name) n += 100;
    else if (String(r.name_cn ?? '').includes(city.name)) n += 40;
    if (wantCountry && r.country === wantCountry) n += 20;
    if (!wantCountry && r.country && r.country !== 'China') n += 5;
    n += Math.min(Number(r.hotel_count ?? 0) / 100, 5);
    return n;
  };
  return [...cities]
    .sort((a, b) => score(b) - score(a))
    .slice(0, 3)
    .map((r) => ({
      regionId: String(r.region_id),
      regionName: String(r.full_name_cn || r.name_cn || r.name || ''),
    }));
}

async function hotelsOf(regionId) {
  /*
   * **入住日要用明天，不能用今天。**（2026-11-09 踩）
   *
   * 第一轮 17 个城市报「酒店池为空」，其中东京手工一查有 19 家 ——
   * 差别就在日期：脚本传的是「今天入住」，而当天房源在日本等地已经关了。
   * 上游对当天入住直接返回 `no hotels found with available rates`，
   * 看起来跟「这个区域没有酒店」一模一样。
   */
  const base = new Date(Date.now() + 86400000);
  const next = new Date(base.getTime() + 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const res = await retry(() => call(
    'search_hotels',
    {
      region_id: regionId,
      check_in_date: iso(base),
      check_out_date: iso(next),
      adults: 1,
      room_count: 1,
      limit: 20,
    },
    60000,
  ));
  return res?.data?.hotels ?? [];
}

/* ---------------------------------------------------------------- 主流程 */

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : undefined;
};
const only = flag('only') ? String(flag('only')).split(',').map((s) => s.trim()).filter(Boolean) : null;
const indexOnly = flag('index-only') === true;
const refresh = flag('refresh') ? String(flag('refresh')).split(',').map((s) => s.trim()) : [];
const CONC = Number(flag('concurrency') ?? 6);

if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
const db = existsSync(OUT)
  ? JSON.parse(readFileSync(OUT, 'utf8'))
  : { version: 1, fetchedAt: null, cities: {} };

const { CITIES } = await import('../src/geo/cities.ts').catch(async () => {
  /* 直接跑 .mjs 时 ts 不会被 strip —— 用 tsx 跑就好；这里给出清晰提示 */
  console.error('需要 tsx：npx tsx tools/fetch-hotel-facts.mjs');
  process.exit(1);
});

await handshake();

let targets = CITIES.filter((c) => !only || only.includes(c.id));
if (refresh.length) targets = CITIES.filter((c) => refresh.includes(c.id));

/* 第一遍：城市 → region_id + 酒店池（已完成的跳过） */
const needIndex = targets.filter((c) => {
  const cur = db.cities[c.id];
  return !cur || !cur.pool?.length || refresh.includes(c.id);
});

console.log(`城市 ${targets.length} 个，需要建索引 ${needIndex.length} 个`);

const indexed = await pool(needIndex, CONC, async (city) => {
  const candidates = await regionsOf(city);
  if (!candidates.length) return { id: city.id, ok: false, why: '找不到区域' };
  let region = null;
  let hotels = [];
  for (const cand of candidates) {
    const list = await hotelsOf(cand.regionId);
    if (list.length) {
      region = cand;
      hotels = list;
      break;
    }
  }
  if (!region) return { id: city.id, ok: false, why: '候选区域都没有可订房源', candidates };

  const chosen = pickPerTier(hotels);
  db.cities[city.id] = {
    regionId: region.regionId,
    regionName: region.regionName,
    poolSize: hotels.length,
    /*
     * **整池都存下来**（2026-11-09）。原来只存被选中的那几家，结果发现
     * 二钻档的真实设施覆盖率只有 35% —— 想补查时手里没有剩下的 id，只能重跑索引。
     * 存全池多花约 300KB，省一次全量重来。
     */
    pool: hotels.map((h) => ({
      id: String(h.hotel_id),
      name: String(h.hotel_name_cn || h.hotel_name || ''),
      star: Number(h.star_rating ?? 0),
      price: Number(h.min_price ?? 0),
    })),
    picked: chosen.map((h) => ({
      id: String(h.hotel_id),
      name: String(h.hotel_name_cn || h.hotel_name || ''),
      star: Number(h.star_rating ?? 0),
      price: Number(h.min_price ?? 0),
    })),
    hotels: db.cities[city.id]?.hotels ?? [],
  };
  return { id: city.id, ok: true, n: chosen.length, pool: hotels.length };
});

const failed = indexed.filter((x) => !x?.ok);
console.log(`索引完成：成功 ${indexed.length - failed.length}，失败 ${failed.length}`);
for (const f of failed.slice(0, 20)) console.log('  ×', f.id, f.why);

writeFileSync(OUT, JSON.stringify(db, null, 1) + '\n', 'utf8');

/* ---------------------------------------------------------------- 补查空档 */
/*
 * 2026-11-09 第一轮跑完的实测覆盖率（1052 家）：
 *
 * | 档 | 城-档组合 | 有真实设施 |
 * |---|---|---|
 * | luxury | 105 | 93% |
 * | view | 144 | 66% |
 * | budget | 159 | 58% |
 * | dingy | 135 | 35% |
 *
 * 合计 61%。剩下那 39% 不是「上游没有这家店的数据」就完事 ——
 * **池里还有二十几家没查过**。这一轮就是去补：同档里再试几家，
 * 直到该档有一家有设施为止（或者把该档池子试完）。
 *
 * 为什么值得补：覆盖率直接决定描述能写多实。二钻档 35% 意味着
 * 大部分时候只能说「房间内部」—— 用户要的「周边环境」就写不出来。
 */
const fill = flag('fill') === true;
if (fill) {
  const TIER = (star) => (star >= 5 ? 'luxury' : star === 4 ? 'view' : star === 3 ? 'budget' : star <= 2 ? 'dingy' : null);
  const MAX_TRY = Number(flag('max-try') ?? 6);
  const jobs = [];
  for (const city of targets) {
    const cur = db.cities[city.id];
    if (!cur?.pool?.length) continue;
    const have = new Set((cur.hotels ?? []).map((h) => String(h.id)));
    const tiers = new Set(cur.pool.map((h) => TIER(h.star)).filter(Boolean));
    for (const t of tiers) {
      const rows = (cur.hotels ?? []).filter((h) => TIER(h.star) === t);
      if (rows.some((h) => h.amen.length)) continue; // 这一档已经有真实数据了
      const spare = cur.pool.filter((h) => TIER(h.star) === t && !have.has(String(h.id))).slice(0, MAX_TRY);
      for (const p of spare) jobs.push({ cityId: city.id, item: p });
    }
  }
  console.log(`补查 ${jobs.length} 家（空档）`);
  let n = 0;
  const t0 = Date.now();
  await pool(jobs, CONC, async (job) => {
    const res = await retry(() => call('get_hotel_detail', { hotel_id: String(job.item.id), language: 'zh-CN' }, 90000));
    const h = res?.data?.hotel;
    if (!h) throw new Error('详情为空');
    const rec = shrink(h, { hotel_id: job.item.id, hotel_name_cn: job.item.name, star_rating: job.item.star, min_price: job.item.price });
    const city = db.cities[job.cityId];
    city.hotels = [...(city.hotels ?? []).filter((x) => String(x.id) !== String(rec.id)), rec];
    n++;
    if (n % 40 === 0) {
      writeFileSync(OUT, JSON.stringify(db, null, 1) + '\n', 'utf8');
      const rate = n / ((Date.now() - t0) / 1000);
      console.log(`  ${n}/${jobs.length}  剩余约 ${Math.round((jobs.length - n) / Math.max(rate, 0.01))}s`);
    }
  });
  db.fetchedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(db, null, 1) + '\n', 'utf8');
  const all = Object.values(db.cities).flatMap((c) => c.hotels ?? []);
  console.log(`补查完成：酒店 ${all.length} 家，有设施 ${all.filter((h) => h.amen.length).length} 家`);
  process.exit(0);
}

if (!indexOnly) {
  /* 第二遍：逐店拉详情，提取设施与周边 */
  const jobs = [];
  for (const city of targets) {
    const cur = db.cities[city.id];
    if (!cur?.picked?.length) continue;
    const have = new Set((cur.hotels ?? []).map((h) => String(h.id)));
    for (const p of cur.picked) if (!have.has(String(p.id))) jobs.push({ cityId: city.id, item: p });
  }
  console.log(`需要拉详情 ${jobs.length} 家`);

  let done = 0;
  const t0 = Date.now();
  await pool(jobs, CONC, async (job) => {
    const res = await retry(() => call('get_hotel_detail', { hotel_id: String(job.item.id), language: 'zh-CN' }, 90000));
    const h = res?.data?.hotel;
    if (!h) throw new Error('详情为空');
    const rec = shrink(h, { hotel_id: job.item.id, hotel_name_cn: job.item.name, star_rating: job.item.star, min_price: job.item.price });
    const city = db.cities[job.cityId];
    city.hotels = [...(city.hotels ?? []).filter((x) => String(x.id) !== String(rec.id)), rec];
    done++;
    if (done % 20 === 0) {
      writeFileSync(OUT, JSON.stringify(db, null, 1) + '\n', 'utf8');
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`  ${done}/${jobs.length}  剩余约 ${Math.round((jobs.length - done) / Math.max(rate, 0.01))}s`);
    }
  });

  db.fetchedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(db, null, 1) + '\n', 'utf8');
}

db.fetchedAt = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(db, null, 1) + '\n', 'utf8');

const stat = Object.values(db.cities);
console.log(
  `完成。城市 ${stat.length}，带酒店数据 ${stat.filter((c) => c.hotels?.length).length}，`
  + `酒店 ${stat.reduce((n, c) => n + (c.hotels?.length ?? 0), 0)} 家`,
);
