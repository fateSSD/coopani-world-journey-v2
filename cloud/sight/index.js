/**
 * 碰面服务器（PostgreSQL 版）—— 一个云函数，三组接口。
 *
 * 配套扩展 0.5.29 起的「碰面」，0.5.48 起加上「邀约」：
 *   1. 她到站报一声，排作息时看看同城同时段还有谁（presence）
 *   2. 想找个伴一起走一段，发一条出去（invite）
 *   3. 别人发的，看一眼、接一条（accept）
 *
 * ## 为什么是 PG 版
 *
 * 建环境的时候只勾了 PostgreSQL（文档型那个没开，`tcb db nosql` 直接报
 * 「当前环境未开通文档型数据库」）。所以表建在 PG 里，云函数走 `app.rdb()` ——
 * **环境身份 + PostgREST，不需要数据库密码**，也就没有把密码塞进环境变量的风险。
 *
 * ## 路由怎么分
 *
 * 一个函数挂三条 HTTP 路径（控制台「HTTP 访问服务 → 路径」里加）：
 *
 *   /sight          碰面
 *   /sight/invite   发 / 看邀约
 *   /sight/accept   接一条
 *
 * 路径名是**扩展写死的**（客户端拼 `${地址}/invite`），改名就得跟着改客户端。
 *
 * ## 三条不能破的规矩
 *
 * 1. **只回宠物名和「在干嘛」。** 别人的 uid、上报时间、任何能拿来联系的东西都不出这个函数。
 *    这个功能从设计上就不是社交 —— 看得见，摸不着。
 * 2. **只按「城 + 日 + 时段」查。** 不接受模糊查询、不接受按 uid 查别人的轨迹。
 * 3. **不通知结果。** 邀约过期就过期，发起方那边没有任何回音 ——
 *    「发了没人应」不该构成一次社交失败。
 *
 * ## 表
 *
 *   presence(uid, pet, city, date_key, slot, doing, at)
 *     唯一索引 (uid, city, date_key, slot) —— 同一格只留一条
 *
 *   invites(id, uid, pet, from_city, to_city, days, note, date_key, at, expires_at, taken_by)
 *     过期靠 expires_at 判，清理另跑
 *
 *   rate(key, n, exp)
 *     限速用的计数表，key 带日期，跨天天然重置
 *
 * 完整 DDL 见同目录 `README.md` 第三节。
 */

const crypto = require('node:crypto');
const cloud = require('@cloudbase/node-sdk');

// SYMBOL_CURRENT_ENV：用运行环境自己的身份，不用手填 envId。
const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });

/** 时段白名单。和扩展里的 slotOf() 必须一致，改一边记得改另一边。 */
const SLOTS = new Set(['morning', 'afternoon', 'evening', 'night']);
/** 一次最多回几个 —— 加上查询方自己正好四个。 */
const MAX = 3;
/** 一条宠物一天最多发几条邀约。正常人一周也发不了一条，3 是给调试留的。 */
const INVITE_PER_DAY = 3;
/** 一天最多接几条。接多了等于把行程排满，那不是「一起玩」，是赶场。 */
const ACCEPT_PER_DAY = 1;
/** 邀约挂多久。过期不通知任何人 —— 不回应就是没看见。 */
const INVITE_TTL_MS = 24 * 3_600_000;

/**
 * 跨域头。
 *
 * 2026-11-04 实测：控制台那个「跨域设置」开关打开之后，响应里**并没有**
 * `access-control-allow-origin` —— 扩展是跨域调的，浏览器会直接拦掉。
 * 所以头得自己加，不能指望平台那一下开关。
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  // `x-admin-key` 是管理接口用的。不写在这儿，浏览器预检会先把带 key 的请求挡掉 ——
  // 面板上显示「连不上」，而真正的原因在预检，云函数日志里一个字都没有。
  'access-control-allow-headers': 'content-type, x-admin-key',
  'access-control-max-age': '86400',
};

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  body: JSON.stringify(body),
});

const okUid = (v) => typeof v === 'string' && /^[a-f0-9]{20,64}$/i.test(v);
const okCity = (v) => typeof v === 'string' && /^[a-z0-9_-]{1,40}$/i.test(v);
const okDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const clean = (v, max) => String(v == null ? '' : v)
  .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

/* ---------------- 管理口的小工具 ---------------- */

/**
 * 管理口开着没。
 *
 * **没配 `ADMIN_KEY` 就当这条路不存在**（返回 404），不是默认开放。
 * 这套东西能列出全部 uid、能把人封掉 —— 挂在公网上等于把池子交出去。
 * key 不对也回 404，不告诉对方「你有 key 但错了」。
 */
function adminKeyOk(event) {
  const want = String(process.env.ADMIN_KEY || '');
  if (!want) return false;
  const h = event.headers || {};
  const got = h['x-admin-key'] || h['X-Admin-Key'] || h['x-Admin-Key'] || '';
  return String(got) === want;
}

/**
 * 这只鱼身上的标记。没有就是 null。
 *
 * **查不到就当没标记**：`pet_flags` 这张表是后加的，线上还没跑 DDL 的时候
 * 查询会报错。让它把上报卡死，等于「加了个管理功能，整个池子先停了」。
 * 宁可这一段暂时不生效，也不能让它挡路。
 */
async function flagOf(db, uid) {
  try {
    const { data, error } = await db.from('pet_flags')
      .select('uid,pet,kind,note,at').eq('uid', uid).limit(1);
    if (error) return null;
    return (data && data[0]) || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------
 * 宠物名和「在干嘛」的清洗
 *
 * ## 为什么必须在服务端做
 *
 * 客户端改一行就能跳过过滤。而宠物名是**唯一展示给陌生人的字段** ——
 * 有人把它改成广告蹲在热门城市，是必然会发生的事，不是可能性。
 *
 * ## 为什么是「换掉」而不是「拒绝」
 *
 * 拒绝会让那只宠物彻底从别人屏幕上消失，用户完全不知道为什么 ——
 * 他只会以为「碰面坏了」，然后来问你。换成中性名字她还在，
 * 只是别人看到的不是他填的那个。恶意名字本来也不该出现在别人屏幕上。
 *
 * ## 词表为什么这么短
 *
 * 中文没有词边界，用「包含匹配」查脏话，词越短误伤越大（「沙」会撞「长沙」）。
 * 所以只收**多字、无歧义**的。这份表故意不全 —— 靠环境变量
 * `BANNED_WORDS` 按反馈往上加，比在代码里堆一份大表更实际。
 * ------------------------------------------------------------------ */

/** 被判为广告/脏话时换成的名字。中性，不像占位符，也不跟世界观冲突。 */
const FALLBACK_PET = '一只鱼';

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
  /\b1[3-9]\d{9}\b/,
  /\b\d{6,11}\b/,
];

/** 额外的词表，部署时在云函数的环境变量里配 `BANNED_WORDS`，逗号分隔。 */
function bannedExtra() {
  return String(process.env.BANNED_WORDS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function looksBad(s, extra) {
  if (!s) return false;
  if (/(.)\1{3,}/.test(s)) return true;   // 「啊啊啊啊」刷屏式占位
  for (const p of AD_PATTERNS) if (p.test(s)) return true;
  const low = s.toLowerCase();
  for (const w of BAD_WORDS) if (low.includes(w)) return true;
  for (const w of extra) if (low.includes(w)) return true;
  return false;
}

function safePet(raw, extra) {
  const s = clean(raw, 24);
  if (!s) return '';
  return looksBad(s, extra) ? FALLBACK_PET : s;
}

/** 「在干嘛」被换掉就留空 —— 空的时候那句话会退化成「也在这一带」，比挂个假动作自然。 */
function safeDoing(raw, extra) {
  const s = clean(raw, 40);
  if (!s) return '';
  return looksBad(s, extra) ? '' : s;
}

/* ---------------- 限速 ---------------- */

/** 今天（UTC）已经用掉多少。读一行。 */
async function rateOf(db, key) {
  const { data, error } = await db.from('rate').select('n').eq('key', key).limit(1);
  if (error) throw new Error(error.message || String(error));
  return Number((data && data[0] && data[0].n) || 0);
}

/**
 * 记一次。
 *
 * `exp` 是这一格的过期时刻（秒），跨天换 key 从 1 重新数；
 * 清理那边按 exp 删过期行，不用扫全表。
 */
async function bumpRate(db, key, day, n) {
  const exp = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + 86_400;
  const { error } = await db.from('rate').upsert({ key, n, exp }, { onConflict: 'key' });
  if (error) throw new Error(error.message || String(error));
}

const today = () => new Date().toISOString().slice(0, 10);
const newId = () => crypto.randomBytes(8).toString('hex');

/* ---------------- 三组接口 ---------------- */

/** 碰面：报一声 / 看同城同日同时段还有谁。 */
/* ---------------- 管理口 ---------------- */

/**
 * 后台：看池子里都有谁、给某只鱼打个标记。
 *
 * **判断权在人手上，不在规则上。** 自动过滤（`looksBad`）只认得形状明显的广告
 * 和几条多字脏话；「名字不对劲但说不出哪儿不对劲」这种事机器判不了，得有人看。
 * 所以这一层只提供三件事：列出来、请她改名、封掉。什么时候用哪一个，是人的事。
 *
 * 三条都要过 `adminKeyOk`。
 *
 * 标记只有三种：
 *   - `ban`    上报一律 403，池子里就没有她了
 *   - `rename` 照常上报，但回执多一句 `notice: 'rename'`，客户端可以转成一句提醒
 *   - `ok`     解除（不删行，省得依赖 `delete`）
 */
async function adminRoute(db, event, method) {
  if (!adminKeyOk(event)) return reply(404, { ok: false, error: 'not found' });
  const q = event.queryStringParameters || {};

  if (method === 'GET') {
    const p = String(event.path || '');
    // 标记清单：面板要显示「谁已经被打了标」
    if (/\/admin\/flags\/?$/.test(p) || q.what === 'flags') {
      const { data, error } = await db.from('pet_flags')
        .select('uid,pet,kind,note,at').order('at', { ascending: false }).limit(500);
      if (error) throw new Error(error.message || String(error));
      return reply(200, { ok: true, flags: data || [] });
    }

    /*
     * 列鱼：按 uid 收成一行。
     *
     * 不指望 PostgREST 的 group by —— 它那套聚合写法在不同版本上长得不一样，
     * 而这里最多几百条，拉回来在内存里收一次最省事，也最好测。
     */
    const limit = Math.min(2000, Math.max(50, Number(q.limit) || 800));
    const { data, error } = await db.from('presence')
      .select('uid,pet,city,date_key,slot,doing,at')
      .order('at', { ascending: false }).limit(limit);
    if (error) throw new Error(error.message || String(error));

    const byUid = new Map();
    for (const r of data || []) {
      if (!r || !r.uid) continue;
      const cur = byUid.get(r.uid);
      if (!cur) {
        byUid.set(r.uid, {
          uid: r.uid,
          pet: r.pet || '',
          city: r.city || '',
          doing: r.doing || '',
          lastAt: r.at || '',
          rows: 1,
        });
      } else cur.rows += 1;
    }
    const pets = [...byUid.values()]
      .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
    return reply(200, { ok: true, pets, truncated: (data || []).length >= limit });
  }

  if (method === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { ok: false, error: 'bad json' }); }
    const uid = clean(body.uid, 64);
    const kind = clean(body.kind, 12);
    if (!okUid(uid)) return reply(400, { ok: false, error: 'bad uid' });
    if (!['ban', 'rename', 'ok'].includes(kind)) return reply(400, { ok: false, error: 'bad kind' });

    const { error } = await db.from('pet_flags').upsert(
      {
        uid,
        pet: clean(body.pet, 24),
        kind,
        note: clean(body.note, 120),
        at: new Date().toISOString(),
      },
      { onConflict: 'uid' },
    );
    if (error) throw new Error(error.message || String(error));
    return reply(200, { ok: true, kind });
  }

  return reply(405, { ok: false, error: 'method not allowed' });
}

async function presenceRoute(db, event, method) {
  const q = event.queryStringParameters || {};
  const extra = bannedExtra();

  if (method === 'GET') {
    const city = clean(q.city, 40);
    const date = clean(q.date, 10);
    const slot = clean(q.slot, 12);
    const exclude = clean(q.exclude, 64);
    if (!okCity(city) || !okDate(date) || !SLOTS.has(slot)) {
      return reply(400, { ok: false, error: 'bad query' });
    }

    let sel = db.from('presence')
      .select('pet,doing')
      .eq('city', city)
      .eq('date_key', date)
      .eq('slot', slot);
    // exclude 可选：没传就别加这个条件（传空串会把「uid 为空」的记录也滤掉）。
    if (exclude) sel = sel.neq('uid', exclude);

    const { data, error } = await sel.order('at', { ascending: false }).limit(MAX);
    if (error) throw new Error(error.message || String(error));

    /*
     * **只挑两个字段。** 防线设在这一层更稳：以后有人改了客户端，
     * 服务器这边仍然漏不出 id 和时间戳。
     */
    const list = (data || [])
      .map((r) => ({ pet: safePet(r.pet, extra), doing: safeDoing(r.doing, extra) }))
      .filter((r) => r.pet);

    return reply(200, { ok: true, list });
  }

  if (method === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { ok: false, error: 'bad json' }); }

    const uid = clean(body.uid, 64);
    const pet = safePet(body.pet, extra);
    const city = clean(body.city, 40);
    const date = clean(body.date, 10);
    const slot = clean(body.slot, 12);
    const doing = safeDoing(body.doing, extra);

    if (!okUid(uid) || !okCity(city) || !okDate(date) || !SLOTS.has(slot) || !pet) {
      return reply(400, { ok: false, error: 'bad fields' });
    }

    /*
     * 被封的鱼报不进来 —— 池子里自然就没有她。
     *
     * 封禁只在这一处执行：**写的人进不来，读的人就不用过滤**。
     * 散在查询里各加一个条件，早晚有一处漏掉。
     */
    const flag = await flagOf(db, uid);
    if (flag && flag.kind === 'ban') return reply(403, { ok: false, error: 'banned' });

    /*
     * upsert 撞唯一索引 (uid, city, date_key, slot)：同一天同一格只留最新那条。
     * 她一天里换几个地方，留下的就是最后一次 —— 那才是「这会儿她在哪」。
     */
    const { error } = await db.from('presence').upsert(
      { uid, pet, city, date_key: date, slot, doing, at: new Date().toISOString() },
      { onConflict: 'uid,city,date_key,slot' },
    );
    if (error) throw new Error(error.message || String(error));

    // `rename`：照常上报，只多一句 —— 客户端可以把它转成「名字换一下」的提醒。
    // 不在这里拦：提醒是提醒，封禁是处罚，两件事不能挤进同一个返回值。
    return reply(200, flag && flag.kind === 'rename' ? { ok: true, notice: 'rename' } : { ok: true });
  }

  return reply(405, { ok: false, error: 'method not allowed' });
}

/**
 * 邀约：发一条 / 看同城别人发的。
 *
 * **服务端完全不懂语义** —— 它只存「谁、从哪、想去哪、几天、一句话」，
 * 和「这条被谁接了」。想不想去、要不要回应，全在模型那边。
 * 这里一旦开始做撮合判断，就得有用户关系、权限、审核，那是另一个量级的东西。
 */
async function inviteRoute(db, event, method) {
  const q = event.queryStringParameters || {};
  const extra = bannedExtra();
  const day = today();

  if (method === 'GET') {
    const city = clean(q.city, 40);
    const uid = clean(q.uid, 64);
    if (!okCity(city) || !okUid(uid)) return reply(400, { ok: false, error: 'bad query' });

    const { data, error } = await db.from('invites')
      .select('id,pet,to_city,days,note,at,meet_city,pace')
      .eq('from_city', city)
      .eq('taken_by', '')
      .gt('expires_at', new Date().toISOString())
      .neq('uid', uid)
      .order('at', { ascending: false })
      .limit(MAX);
    if (error) throw new Error(error.message || String(error));

    /*
     * **不返回发起者的 uid。** 跟碰面同一条线：能看见，摸不着。
     * 名字和「想去哪」够她判断了，多一个标识就是多一条能拿去别处用的东西。
     */
    const list = (data || []).map((r) => ({
      id: r.id,
      pet: safePet(r.pet, extra),
      to: r.to_city,
      days: Number(r.days) || 1,
      note: looksBad(String(r.note || ''), extra) ? '' : clean(r.note, 60),
      // 见面城（2026-11-07）。空 = 老数据，客户端按「就在 to 见」处理。
      meet: clean(r.meet_city, 40),
      pace: Number(r.pace) || 0,
    }));

    return reply(200, { ok: true, list });
  }

  if (method === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { ok: false, error: 'bad json' }); }

    const uid = clean(body.uid, 64);
    const from = clean(body.from, 40);
    const to = clean(body.to, 40);
    const pet = safePet(body.pet, extra);
    const days = Math.min(30, Math.max(1, Number(body.days) || 1));
    // 见面城 / 世界流速（2026-11-07）。含义见 `cloud/sight-cf/src/worker.js` 同名注释。
    const meet = clean(body.meet, 40);
    const pace = Math.min(240, Math.max(0, Math.round(Number(body.pace) || 0)));

    /*
     * 一句话。**这是整个系统里唯一一处自由文本**，所以它是过滤最该管的地方。
     * 判定为广告就留空，不拒绝整条邀约：她还能发，只是不带那句话。
     */
    const noteRaw = clean(body.note, 60);
    const note = looksBad(noteRaw, extra) ? '' : noteRaw;

    if (!okUid(uid) || !okCity(from) || !okCity(to) || !pet) {
      return reply(400, { ok: false, error: 'bad fields' });
    }
    if (meet && !okCity(meet)) return reply(400, { ok: false, error: 'bad fields' });

    // 封禁在邀约这条路上也要挡一次 —— 只挡上报的话，她照样能发邀请、
    // 照样能被别人接走，等于封了个半截。
    const flag = await flagOf(db, uid);
    if (flag && flag.kind === 'ban') return reply(403, { ok: false, error: 'banned' });

    const key = `iv:${uid}:${day}`;
    const used = await rateOf(db, key);
    if (used >= INVITE_PER_DAY) return reply(429, { ok: false, error: 'too many' });

    const now = new Date();
    const id = newId();
    const { error } = await db.from('invites').insert({
      id,
      uid,
      pet,
      from_city: from,
      to_city: to,
      days,
      note,
      date_key: day,
      at: now.toISOString(),
      expires_at: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
      taken_by: '',
      meet_city: meet,
      pace,
    });
    if (error) throw new Error(error.message || String(error));

    await bumpRate(db, key, day, used + 1);
    return reply(200, { ok: true, id });
  }

  return reply(405, { ok: false, error: 'method not allowed' });
}

/**
 * 接一条。
 *
 * ## 抢位置靠条件更新，不是「先查再写」
 *
 * `update ... where id = ? and taken_by = ''` —— 两个人同时接，PG 只有一个真的改到行，
 * 另一个的 update 命中 0 行。改完之后**再读一次**，看 `taken_by` 是不是自己：
 *
 * - 是 → 接到了
 * - 不是 → 被人抢先了，回 409
 *
 * 为什么不直接看「影响行数」：这个 SDK 的 PostgREST 客户端不一定回 `count`，
 * 而**回读一次是确定能拿到的**。代价是一次多余查询，换掉一个「两个人各自以为接上了」。
 */
async function acceptRoute(db, event, method) {
  if (method !== 'POST') return reply(405, { ok: false, error: 'method not allowed' });

  const extra = bannedExtra();
  const day = today();

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { ok: false, error: 'bad json' }); }

  const uid = clean(body.uid, 64);
  const id = clean(body.id, 32);
  if (!okUid(uid) || !/^[a-f0-9]{16}$/.test(id)) return reply(400, { ok: false, error: 'bad fields' });

  const { data, error } = await db.from('invites')
    .select('id,uid,pet,to_city,days,note,expires_at,taken_by,meet_city,pace')
    .eq('id', id)
    .limit(1);
  if (error) throw new Error(error.message || String(error));
  const row = (data || [])[0];
  if (!row) return reply(404, { ok: false, error: 'gone' });
  if (row.uid === uid) return reply(400, { ok: false, error: 'own invite' });
  if (row.taken_by) return reply(409, { ok: false, error: 'taken' });
  if (Date.parse(row.expires_at) <= Date.now()) return reply(410, { ok: false, error: 'expired' });

  const key = `ia:${uid}:${day}`;
  const used = await rateOf(db, key);
  if (used >= ACCEPT_PER_DAY) return reply(429, { ok: false, error: 'too many' });

  const { error: uErr } = await db.from('invites')
    .update({ taken_by: uid })
    .eq('id', id)
    .eq('taken_by', '');
  if (uErr) throw new Error(uErr.message || String(uErr));

  const { data: after, error: aErr } = await db.from('invites')
    .select('taken_by')
    .eq('id', id)
    .limit(1);
  if (aErr) throw new Error(aErr.message || String(aErr));
  const winner = (after || [])[0];
  if (!winner || winner.taken_by !== uid) return reply(409, { ok: false, error: 'taken' });

  await bumpRate(db, key, day, used + 1);

  // 回「发起者是谁、要去哪、几天」—— 这些她接下来排行程要用
  return reply(200, {
    ok: true,
    with: safePet(row.pet, extra),
    to: row.to_city,
    days: Number(row.days) || 1,
    note: looksBad(String(row.note || ''), extra) ? '' : clean(row.note, 60),
    meet: clean(row.meet_city, 40),
    pace: Number(row.pace) || 0,
  });
}

/**
 * 走哪一组接口。
 *
 * **先认路径，路径认不出来再按请求的形状认。**
 *
 * 2026-11-05 实测：腾讯云的 HTTP 访问服务把 `/sight/invite` **也转给了同一个函数**
 * （拿旧版代码打过去，回的是它自己那句 `bad query`，不是网关的 404）——
 * 也就是说路径基本是通的。但「基本」不够：不同网关对 `event.path` 的处理不一样，
 * 有把子路径裁掉只留 `/sight` 的。裁掉了还得能认出这是邀约，
 * 否则表现会是「接口在、功能不在」，最难查的那一种。
 *
 * 形状判据（不会误伤）：
 *   POST 带 `from` + `to`  → 发邀约
 *   POST 带 `id`           → 接邀约
 *   GET  带 `uid` 不带 `date` → 看邀约（碰面那组必须有 date 和 slot）
 */
function routeOf(event, method) {
  const p = String(event.path || (event.requestContext && event.requestContext.path) || '');
  // 管理口先认：它有自己的路径，别被下面那套「按请求形状猜」的判断吞掉。
  if (/\/admin(\/|$)/.test(p)) return 'admin';
  if (/\/invite\/?$/.test(p)) return 'invite';
  if (/\/accept\/?$/.test(p)) return 'accept';

  if (method === 'POST') {
    let body = null;
    try { body = JSON.parse(event.body || '{}'); } catch { body = null; }
    if (body && typeof body === 'object') {
      if (body.from && body.to) return 'invite';
      if (body.id) return 'accept';
    }
    return 'presence';
  }

  const q = event.queryStringParameters || {};
  if (q.uid && !q.date) return 'invite';
  return 'presence';
}

exports.main = async (event) => {
  const method = String(event.httpMethod || 'GET').toUpperCase();

  // 预检请求：浏览器发 POST(JSON) 前会先问一次，直接放行。
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const route = routeOf(event, method);
  try {
    const db = app.rdb({});
    if (route === 'admin') return await adminRoute(db, event, method);
    if (route === 'invite') return await inviteRoute(db, event, method);
    if (route === 'accept') return await acceptRoute(db, event, method);
    return await presenceRoute(db, event, method);
  } catch (e) {
    // 不把内部错误回给调用方 —— 日志里留着就够了。
    // 表还没建的时候也是走这儿，日志里会写 `relation "invites" does not exist`。
    console.error(`[sight ${route}]`, e && e.message ? e.message : e);
    return reply(500, { ok: false, error: 'server error' });
  }
};
