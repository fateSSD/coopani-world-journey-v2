/**
 * Cloudflare 版碰面服务端的本地验证。
 *
 * 用 Node 22 内置的 `node:sqlite` 当 D1 的替身 —— **跑的是真 SQL**，不是假的。
 * 这样在部署之前就能确认：upsert 对不对、限速生不生效、隐私字段有没有漏出去。
 *
 * 不测网络层，只测 handler 的逻辑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const worker = (await import('../cloud/sight-cf/src/worker.js')).default;

/* ---------- 用真 SQLite 冒充 D1 ---------- */
function makeDB() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('cloud/sight-cf/schema.sql', 'utf8'));
  const api = {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async first() { return db.prepare(sql).get(...args) ?? undefined; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() {
          const r = db.prepare(sql).run(...args);
          return { success: true, meta: { changes: Number(r.changes) } };
        },
      };
      return stmt;
    },
    /* 测试要直接看表、预置计数器 —— 真实 D1 上对应 `wrangler d1 execute`。 */
    exec(sql) { db.exec(sql); },
    query(sql, ...a) { return db.prepare(sql).all(...a); },
    raw: null,
  };
  api.raw = api;   // 让 `env.DB = makeDB()` 和 `db` 自己都能用
  return api;
}

const BASE = 'https://sight.test/sight';
const UID_A = 'a'.repeat(32);
const UID_B = 'b'.repeat(32);

function post(body, ip = '1.1.1.1') {
  return new Request(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify(body),
  });
}
const get = (q, ip = '1.1.1.1') => new Request(`${BASE}?${q}`, { headers: { 'cf-connecting-ip': ip } });

const rec = (over = {}) => ({
  uid: UID_A, pet: '大肥鱼', city: 'xian', date: '2026-11-05', slot: 'evening', doing: '吃面', ...over,
});

test('上报一条，能查到自己', async () => {
  const env = { DB: makeDB() };
  const r1 = await worker.fetch(post(rec()), env);
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { ok: true });

  const r2 = await worker.fetch(get('city=xian&date=2026-11-05&slot=evening'), env);
  const body = await r2.json();
  assert.equal(body.ok, true);
  assert.equal(body.list.length, 1);
  assert.equal(body.list[0].pet, '大肥鱼');
});

test('返回里只有 pet 和 doing —— 不许漏 uid 和时间', async () => {
  const env = { DB: makeDB() };
  await worker.fetch(post(rec()), env);
  const body = await (await worker.fetch(get('city=xian&date=2026-11-05&slot=evening'), env)).json();
  const keys = Object.keys(body.list[0]).sort();
  assert.deepEqual(keys, ['doing', 'pet'], `多了字段：${keys.join(',')}`);
});

test('exclude 能把自己排除掉', async () => {
  const env = { DB: makeDB() };
  await worker.fetch(post(rec()), env);
  const body = await (await worker.fetch(
    get(`city=xian&date=2026-11-05&slot=evening&exclude=${UID_A}`), env,
  )).json();
  assert.equal(body.list.length, 0);
});

test('同一个 uid 一天报满 50 次之后才被挡 —— 不再卡 20 秒间隔', async () => {
  /*
   * 第一版是「两次上报至少隔 20 秒」，跑起来发现粒度错了：
   * 她同一天换城市、换时段各报一次是**合法的**，但按 uid 算间隔会把这些
   * 正常上报一起挡掉，而客户端是 `void` 调用，挡了没人知道 —— 那一格静默就缺了。
   *
   * 现在按「一天 50 次」算。重复报同一格本来就是 upsert，天然幂等，
   * 不需要靠限速去防。
   */
  const env = { DB: makeDB() };
  for (let i = 0; i < 50; i += 1) {
    const r = await worker.fetch(post(rec({ doing: `第${i}次` })), env);
    assert.equal(r.status, 200, `第 ${i + 1} 次应该放行`);
  }
  const blocked = await worker.fetch(post(rec({ doing: '第51次' })), env);
  assert.equal(blocked.status, 429, '第 51 次没被挡住');
  assert.equal((await blocked.json()).error, 'too many');
});

test('同一天换城市、换时段都能正常报 —— 限速不该误伤行程', async () => {
  /*
   * 这是上面那条的另一面，也是第一版真踩到的坑：
   * 「同一 uid 两次写入间隔 20 秒」会把「上午在西安、晚上到兰州」这种
   * 完全正常的行程挡掉一半。现在按天计数，连报四格都该过。
   */
  const env = { DB: makeDB() };
  const trip = [
    ['xian', 'morning', '在城墙上吹风'],
    ['xian', 'afternoon', '在南门吃泡馍'],
    ['lanzhou', 'evening', '黄河边看日落'],
    ['lanzhou', 'night', '正宁路喝醪糟'],
  ];
  for (const [city, slot, doing] of trip) {
    const r = await worker.fetch(post(rec({ city, slot, doing })), env);
    assert.equal(r.status, 200, `${city}/${slot} 被挡了 —— 限速误伤正常行程`);
  }
  const body = await (await worker.fetch(get('city=lanzhou&date=2026-11-05&slot=night'), env)).json();
  assert.equal(body.list.length, 1);
  assert.equal(body.list[0].doing, '正宁路喝醪糟');
});

test('同一个 IP 刷爆之后才挡（IP 闸）', async () => {
  /*
   * IP 闸不是防单个脚本（那靠 uid 闸），是防「一个人换 uid 狂刷」。
   * 阈值定在一天 2000 次 —— 公司 NAT 五十人一天也就一千二，不会误伤。
   *
   * 这里直接往计数表里预置 1999 次，省得真发两千个请求。
   */
  const db = makeDB();
  const env = { DB: db.raw ?? db };

  const ip = '9.9.9.9';
  const day = new Date().toISOString().slice(0, 10);
  const ipKey = `i:${createHash('sha256').update(ip).digest('hex').slice(0, 16)}:${day}`;
  const expSec = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + 86_400;
  db.exec(
    `INSERT INTO rate (key, n, exp) VALUES ('${ipKey}', 1999, ${expSec})`,
  );

  const r1 = await worker.fetch(post(rec({ uid: '1'.repeat(32) }), ip), env);
  assert.equal(r1.status, 200, '第 2000 次应该还能过');
  const r2 = await worker.fetch(post(rec({ uid: '2'.repeat(32) }), ip), env);
  assert.equal(r2.status, 429, '第 2001 次没被 IP 闸挡住');
});

test('全站每日硬顶到了就 503（应急开关）', async () => {
  const db = makeDB();
  const env = { DB: db.raw ?? db };
  const day = new Date().toISOString().slice(0, 10);
  const expSec = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + 86_400;
  db.exec(`INSERT INTO rate (key, n, exp) VALUES ('d:${day}', 20000, ${expSec})`);

  const r = await worker.fetch(post(rec()), env);
  assert.equal(r.status, 503, '硬顶没生效');
  assert.equal((await r.json()).error, 'busy');
});

test('被挡下的请求不消耗配额 —— 不然刷子能靠「被拒」顶满全局额度', async () => {
  const db = makeDB();
  const env = { DB: db.raw ?? db };
  const day = new Date().toISOString().slice(0, 10);
  const expSec = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + 86_400;
  const uid = '9'.repeat(32);
  db.exec(`INSERT INTO rate (key, n, exp) VALUES ('u:${uid}:${day}', 50, ${expSec})`);

  for (let i = 0; i < 5; i += 1) await worker.fetch(post(rec({ uid })), env);
  const [row] = db.query('SELECT n FROM rate WHERE key = ?1', `u:${uid}:${day}`);
  assert.equal(Number(row?.n), 50, `被拒的请求也计数了：n = ${row?.n}`);
});

test('字段不合法当场拒，不写库', async () => {
  const env = { DB: makeDB() };
  const bads = [
    rec({ uid: 'short' }),
    rec({ uid: 'zzzz'.repeat(8) }),          // 非十六进制
    rec({ city: '西安' }),                    // 中文不行，只收 id
    rec({ date: '2026-11-5' }),
    rec({ slot: 'noon' }),
    rec({ pet: '' }),
  ];
  for (const b of bads) {
    const r = await worker.fetch(post(b), env);
    assert.equal(r.status, 400, `该拒的没拒：${JSON.stringify(b).slice(0, 60)}`);
  }
});

test('查询参数不合法也当场拒', async () => {
  const env = { DB: makeDB() };
  for (const q of ['city=xian&date=2026-11-05', 'city=&date=2026-11-05&slot=evening', 'city=xian&slot=midnight']) {
    assert.equal((await worker.fetch(get(q), env)).status, 400, `该拒没拒：${q}`);
  }
});

test('date 参数已经不参与筛选，旧客户端还在传也不该 400', async () => {
  /*
   * 2026-11-10：邻居改成「同城 + 同时段 + 近 2 小时」，`date` 被服务端忽略 ——
   * 但旧版客户端仍在传它。多一个没用的参数把请求打成 400，
   * 等于一次服务端改动把所有没升级的客户端一起废掉。
   */
  const env = { DB: makeDB() };
  for (const q of ['city=xian&slot=evening', 'city=xian&date=x&slot=evening', 'city=xian&date=&slot=evening']) {
    assert.equal((await worker.fetch(get(q), env)).status, 200, `不该拒：${q}`);
  }
});

test('同一格重复上报是更新，不是新增', async () => {
  /*
   * 撞主键就 upsert —— 她一天里换几个地方，留下的应该是最后一次。
   *
   * 第一版这条测试得把第一条记录的时间往前拨 20 秒才能过（不然被「间隔」闸挡），
   * 那本身就是一个信号：**正常的重复上报被限速误伤了**。
   * 现在按天计数，连报两次天然就能过。
   */
  const db = makeDB();
  const env = { DB: db };
  assert.equal((await worker.fetch(post(rec({ doing: '吃面' })), env)).status, 200);
  assert.equal((await worker.fetch(post(rec({ doing: '还在回民街' })), env)).status, 200);

  const rows = db.query('SELECT doing FROM presence');
  assert.equal(rows.length, 1, '应该只有一条（upsert）');
  assert.equal(rows[0].doing, '还在回民街');
});

test('限速用计数表 —— 不扫 presence，成本跟表大小无关', async () => {
  /*
   * 第一版三条闸全用 `COUNT(*) FROM presence`。执行计划走 covering index，
   * 看着没有全表扫描，但 COUNT 范围内有多少行就要读多少行：
   * 表里 8 万行时每次 POST 读 8 万行，D1 免费版一天 500 万行读取，
   * **62 次上报就烧光**。那道「防刷爆额度」的闸自己就是最大的刷子。
   *
   * 这条守的是「判定不再依赖 presence 的行数」：
   * 塞几千行进去，限速判定该怎么过还怎么过。
   */
  const db = makeDB();
  const env = { DB: db };
  const day = new Date().toISOString().slice(0, 10);

  // 造 5000 行别人的记录（同一个城、同一个时段，正好是查询会命中的范围）
  db.exec('BEGIN');
  for (let i = 0; i < 5000; i += 1) {
    db.exec(`INSERT INTO presence (uid,pet,city,date_key,slot,doing,at,ip_hash)
             VALUES ('${i.toString(16).padStart(32, '0')}','鱼${i}','xian','2026-11-05','evening','在逛','${new Date(Date.now() - i * 1000).toISOString()}','')`);
  }
  db.exec('COMMIT');

  // 一个全新的 uid，第一次上报就该过 —— 不看表里有多少行
  const r = await worker.fetch(post(rec({ uid: 'c'.repeat(32) })), env);
  assert.equal(r.status, 200, '表大了之后正常上报被挡住');

  // 而且计数只记了它自己那一次
  const row = db.query('SELECT n FROM rate WHERE key = ?1', `u:${'c'.repeat(32)}:${day}`);
  assert.equal(Number(row[0]?.n), 1, `计数不对：${JSON.stringify(row)}`);

  // 查询本身仍然只回 3 个
  const body = await (await worker.fetch(get('city=xian&date=2026-11-05&slot=evening'), env)).json();
  assert.equal(body.list.length, 3, '查询应该还限 3 个');
});

test('定时清理：删掉保留期之外的，留下最近四天', async () => {
  /*
   * 不清理的话表会一直长：一天五万行，一个月一百五十万行，
   * 免费版 5 GB 存储撑不到年底。
   */
  const db = makeDB();
  const env = { DB: db };
  const now = Date.now();
  const d = (daysAgo) => new Date(now - daysAgo * 86_400_000).toISOString().slice(0, 10);

  for (const [daysAgo, uid] of [[10, 'a'], [6, 'b'], [1, 'c']]) {
    db.exec(`INSERT INTO presence (uid,pet,city,date_key,slot,doing,at,ip_hash)
             VALUES ('${uid.repeat(32)}','鱼','xian','${d(daysAgo)}','evening','在逛','${new Date(now - daysAgo * 86_400_000).toISOString()}','')`);
  }
  assert.equal(db.query('SELECT COUNT(*) AS n FROM presence')[0].n, 3);

  await worker.scheduled({ cron: '17 * * * *' }, env);

  const left = db.query('SELECT date_key FROM presence ORDER BY date_key');
  assert.equal(left.length, 1, `应该只留最近那条，实际剩 ${left.length} 条`);
  assert.equal(left[0].date_key, d(1));
});

test('定时清理：没绑 D1 时不崩', async () => {
  await worker.scheduled({}, {});
  await worker.scheduled({}, undefined);
});

test('不认识的路径直接 404，不暴露别的东西', async () => {
  const env = { DB: makeDB() };
  for (const p of ['/admin', '/api/presence', '/sight/extra']) {
    const r = await worker.fetch(new Request(`https://sight.test${p}`), env);
    assert.equal(r.status, 404, `${p} 应该 404`);
  }
});

test('预检请求放行，跨域头在', async () => {
  const env = { DB: makeDB() };
  const r = await worker.fetch(new Request(BASE, { method: 'OPTIONS' }), env);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('每日硬顶按「行」换算，不按「次」—— 单位搞错会超额度 4 倍', async () => {
  /*
   * D1 免费额度的单位是**行**（10 万行写入/天），不是请求数。
   * 一次上报要写 4 行：presence 一条 + rate 三条。
   *
   * 第一版直接拿「8 万次」当上限 —— 那是旧版 `COUNT(*) FROM presence` 的口径，
   * 一次只写 1 行。换成计数表后每次写 4 行，同样 8 万次就是 32 万行，超三倍。
   *
   * 这条钉住换算结果：8 万行预算 ÷ 4 行/次 = 2 万次。
   */
  const db = makeDB();
  const env = { DB: db };
  const day = new Date().toISOString().slice(0, 10);
  const expSec = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + 86_400;

  // 19999 次已用 → 还能再写一次
  db.exec(`INSERT INTO rate (key, n, exp) VALUES ('d:${day}', 19999, ${expSec})`);
  assert.equal((await worker.fetch(post(rec({ uid: '1'.repeat(32) })), env)).status, 200,
    '第 20000 次该放行');

  // 到了 2 万 → 挡住
  assert.equal((await worker.fetch(post(rec({ uid: '2'.repeat(32) })), env)).status, 503,
    '第 20001 次该被硬顶挡住');
});

test('没绑 D1 时给 500，而不是崩', async () => {
  const r = await worker.fetch(post(rec()), {});
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error, 'server error');
});

/* ---------- 管理接口（只读） ---------- */

const ADMIN_KEY = 'k'.repeat(40);

test('没配 ADMIN_KEY 时管理接口整个不存在（默认关闭）', async () => {
  const env = { DB: makeDB() };   // 没有 ADMIN_KEY
  for (const p of ['/admin/stats', '/admin/list']) {
    const r = await worker.fetch(new Request(`https://sight.test${p}?key=${ADMIN_KEY}`), env);
    assert.equal(r.status, 404, `${p} 在没配密钥时不该可达`);
  }
});

test('密钥不对就 401，比对用恒定时间', async () => {
  const env = { DB: makeDB(), ADMIN_KEY };
  const r = await worker.fetch(
    new Request(`https://sight.test/admin/stats?key=${'x'.repeat(40)}`), env,
  );
  assert.equal(r.status, 401);
  // 长度不同也走同一条路，不能因为「长度不对」就短路返回不同的错
  const r2 = await worker.fetch(new Request('https://sight.test/admin/stats?key=short'), env);
  assert.equal(r2.status, 401);
});

test('密钥对了，stats 给出今天的量', async () => {
  const db = makeDB();
  const env = { DB: db, ADMIN_KEY };
  // stats 默认查「今天」，所以测试数据也得写到今天 —— 写死 2026-11-05 会查不到
  const day = new Date().toISOString().slice(0, 10);
  await worker.fetch(post(rec({ uid: 'a'.repeat(24), pet: '大肥鱼', date: day })), env);
  await worker.fetch(post(rec({ uid: 'b'.repeat(24), pet: '小满', city: 'lanzhou', date: day })), env);

  const r = await worker.fetch(
    new Request(`https://sight.test/admin/stats?key=${ADMIN_KEY}`), env,
  );
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.today.posts, 2, '今天两次上报');
  assert.equal(body.today.uids, 2, '两只宠物');
  assert.ok(body.cities.length >= 1, '城市分布为空');
  assert.ok(body.budget.cap > 0);
  assert.equal(body.day, day);
});

test('明细里 uid 是打码的 —— 截图发出去也不泄露完整标识', async () => {
  const db = makeDB();
  const env = { DB: db, ADMIN_KEY };
  const full = 'abcdef0123456789abcdef01';
  const day = new Date().toISOString().slice(0, 10);
  await worker.fetch(post(rec({ uid: full, date: day })), env);

  const r = await worker.fetch(
    new Request(`https://sight.test/admin/list?key=${ADMIN_KEY}`), env,
  );
  const body = await r.json();
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].uid, 'abcd…ef01', `打码不对：${body.rows[0].uid}`);
  assert.ok(!JSON.stringify(body).includes(full), '返回里出现了完整 uid');
});

test('管理接口只读，POST 一律 405', async () => {
  const env = { DB: makeDB(), ADMIN_KEY };
  const r = await worker.fetch(new Request('https://sight.test/admin/stats', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json' },
    body: '{}',
  }), env);
  assert.equal(r.status, 405);
});

test('密钥也能走 header，不用挂 URL 上（不会留在日志里）', async () => {
  const env = { DB: makeDB(), ADMIN_KEY };
  const r = await worker.fetch(new Request('https://sight.test/admin/stats', {
    headers: { 'x-admin-key': ADMIN_KEY },
  }), env);
  assert.equal(r.status, 200);
});

/* ---------- 宠物名 / 在干嘛 的清洗 ---------- */

test('正常名字一个都不许误伤', async () => {
  /*
   * 这条比「能不能挡住广告」更重要。中文没有词边界，用包含匹配查脏话，
   * 词越短误伤越大（「沙」撞「长沙」）。误伤一个真实用户，比漏掉一个广告名糟糕得多 ——
   * 前者会让人以为功能坏了，后者只是别人看到一条广告。
   */
  const env = { DB: makeDB() };
  const fine = [
    '大肥鱼', '小满', '团子', '阿黄', '胖头', '豆豆', '阿七', '铁牛',
    '鱼鱼', '小鱼干', '咸鱼', '三文鱼', '沧海一粟', '山高水长', '长沙',
    '旺财', '一只叫旺财的狗', 'Mochi', 'Biscuit', '小鱼2026', '茶茶',
  ];
  for (const pet of fine) {
    const r = await worker.fetch(post(rec({ uid: pet.length.toString(16).padStart(24, '0'), pet, city: 'xian' })), env);
    assert.equal(r.status, 200, `「${pet}」被拒了`);
    const body = await (await worker.fetch(get('city=xian&date=2026-11-05&slot=evening'), env)).json();
    const hit = body.list.find((x) => x.pet === pet);
    assert.ok(hit, `「${pet}」被改掉了，正常名字不该动`);
  }
});

test('广告和联系方式换成中性名 —— 换掉，不是拒绝', async () => {
  /*
   * 拒绝的话那只鱼会从别人屏幕上彻底消失，用户不知道为什么，只会以为碰面坏了。
   * 换个名字她还在。
   */
  const env = { DB: makeDB() };
  const bads = [
    '加微信abc123', 'www.abc.com', 'https://x.cn', 'vx:hello',
    '联系我', '扫码返利', '13800138000', '123456789',
  ];
  for (const pet of bads) {
    const r = await worker.fetch(post(rec({ uid: pet.length.toString(16).padStart(24, '0'), pet })), env);
    assert.equal(r.status, 200, `「${pet}」应该是换掉而不是拒绝`);
    const body = await (await worker.fetch(get('city=xian&date=2026-11-05&slot=evening'), env)).json();
    assert.ok(!body.list.some((x) => x.pet === pet), `「${pet}」原样漏出去了`);
  }
});

test('换掉的名字是「一只鱼」，而且入库的就是它', async () => {
  const db = makeDB();
  const env = { DB: db };
  await worker.fetch(post(rec({ uid: 'a'.repeat(24), pet: '加微信 abc123' })), env);

  const rows = db.query('SELECT pet FROM presence');
  assert.equal(rows[0].pet, '一只鱼', `库里存的还是脏名字：${rows[0].pet}`);
});

test('「在干嘛」也洗 —— 它同样会出现在别人屏幕上', async () => {
  const env = { DB: makeDB() };
  await worker.fetch(post(rec({ uid: 'b'.repeat(24), pet: '好鱼', doing: '加微信 abc123 领优惠券' })), env);
  const body = await (await worker.fetch(get('city=xian&date=2026-11-05&slot=evening'), env)).json();
  assert.equal(body.list[0].doing, '', `脏动作没被清掉：${body.list[0].doing}`);
});

test('更早写进去的脏数据，读的时候也拦得住', async () => {
  /*
   * 过滤是后加的 —— 库里可能有升级前写进去的脏名字。
   * 只在写入时过滤是不够的，读的时候也要过一道。
   */
  const db = makeDB();
  const env = { DB: db };
  /*
   * `at` 必须落在活跃窗口里（2026-11-10 起邻居按 `at` 划 2 小时窗口，不再按 date_key）。
   * 写成固定日期会让它落在窗口外，测的就不再是「脏名字被拦」而是「查不到人」。
   */
  const fresh = new Date().toISOString();
  db.exec(`INSERT INTO presence (uid,pet,city,date_key,slot,doing,at,ip_hash)
           VALUES ('${'c'.repeat(24)}','看片加微信abc','xian','2026-11-05','evening','私聊我','${fresh}','')`);

  const body = await (await worker.fetch(get('city=xian&date=2026-11-05&slot=evening'), env)).json();
  assert.equal(body.list[0].pet, '一只鱼', '历史脏名字漏出去了');
  assert.equal(body.list[0].doing, '', '历史脏动作漏出去了');
});

test('BANNED_WORDS 环境变量能加词，不用改代码', async () => {
  const env = { DB: makeDB(), BANNED_WORDS: '大鱼号,某某品牌' };
  await worker.fetch(post(rec({ uid: 'd'.repeat(24), pet: '大鱼号官方' })), env);
  const body = await (await worker.fetch(get('city=xian&date=2026-11-05&slot=evening'), env)).json();
  assert.equal(body.list[0].pet, '一只鱼', '自定义词表没生效');

  // 没配的时候「大鱼号」是正常名字
  const env2 = { DB: makeDB() };
  await worker.fetch(post(rec({ uid: 'e'.repeat(24), pet: '大鱼号官方' })), env2);
  const body2 = await (await worker.fetch(get('city=xian&date=2026-11-05&slot=evening'), env2)).json();
  assert.equal(body2.list[0].pet, '大鱼号官方', '没配词表却被误伤');
});

test('刷屏式名字挡掉（啊啊啊啊、!!!!!）', async () => {
  const env = { DB: makeDB() };
  for (const pet of ['aaaaaaaa', '!!!!!!', '。。。。。。']) {
    await worker.fetch(post(rec({ uid: pet.charCodeAt(0).toString(16).padStart(24, '0'), pet })), env);
  }
  const body = await (await worker.fetch(get('city=xian&date=2026-11-05&slot=evening'), env)).json();
  const names = body.list.map((x) => x.pet);
  assert.ok(!names.includes('aaaaaaaa'), '连续重复没挡住');
  assert.ok(!names.includes('!!!!!!'), '连续符号没挡住');
});

/* ---------- 邀约：让她自己发起「有没有人一起去」 ---------- */

const INV = 'https://sight.test/sight/invite';
const ACC = 'https://sight.test/sight/accept';

const inviteReq = (method, body) => new Request(INV, {
  method,
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.1.1.1' },
  body: body ? JSON.stringify(body) : undefined,
});
const acceptReq = (body) => new Request(ACC, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.1.1.1' },
  body: JSON.stringify(body),
});
const mk = (o = {}) => ({ uid: 'a'.repeat(24), pet: '大肥鱼', from: 'xian', to: 'dali', days: 3, note: '', ...o });
const day = () => new Date().toISOString().slice(0, 10);

test('发一条，同城的人能收到', async () => {
  const env = { DB: makeDB() };
  const r = await worker.fetch(inviteReq('POST', mk({ note: '走滇藏线，慢一点' })), env);
  assert.equal(r.status, 200);
  const { id } = await r.json();
  assert.match(id, /^[a-f0-9]{16}$/, `id 形状不对：${id}`);

  const res = await worker.fetch(new Request(
    `${INV}?city=xian&uid=${'b'.repeat(24)}`,
  ), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.list.length, 1);
  assert.equal(body.list[0].pet, '大肥鱼');
  assert.equal(body.list[0].to, 'dali');
  assert.equal(body.list[0].days, 3);
  assert.equal(body.list[0].note, '走滇藏线，慢一点');
});

test('邀约是全服可见的 —— 同城不再把外地的挤出窗口', async () => {
  const env = { DB: makeDB() };
  /*
   * 2026-11-25 之前是 `ORDER BY near DESC LIMIT 3`：同城三条一满，
   * 外地的邀约**永远轮不进这个窗口**，用户看到的就是「只能同城看见」。
   * 这条用例专门盯着那个回归 —— 造四条同城的，再放一条外地的。
   */
  /* uid 必须是 hex —— `okUid` 会挡掉 g/z 这种字母，POST 直接 400。 */
  const uids = ['1', '2', '3', '4'];
  for (let i = 0; i < uids.length; i++) {
    const r = await worker.fetch(inviteReq('POST', mk({
      uid: uids[i].repeat(24), pet: `同城${i + 1}`, from: 'xian', to: 'dali',
    })), env);
    assert.equal(r.status, 200, `同城那条没发出去：${await r.text()}`);
    await new Promise((res) => setTimeout(res, 2));   // 让 `at` 分出先后
  }
  const farRes = await worker.fetch(inviteReq('POST', mk({
    uid: 'e'.repeat(24), pet: '外地鱼', from: 'haerbin', to: 'sanya',
  })), env);
  assert.equal(farRes.status, 200, `外地那条没发出去：${await farRes.text()}`);

  const body = await (await worker.fetch(new Request(
    `${INV}?city=xian&uid=${'b'.repeat(24)}`,
  ), env)).json();
  assert.equal(body.ok, true);
  const names = body.list.map((x) => x.pet);
  assert.ok(names.includes('外地鱼'), `外地邀约被同城挤掉了：${names.join('/')}`);
  assert.equal(body.list.length, 5, `五条都该在，实际 ${body.list.length}`);

  const far = body.list.find((x) => x.pet === '外地鱼');
  assert.equal(far.from, 'haerbin', '出发城要带出来 —— 接的人得知道先往哪儿去');
  assert.equal(far.near, false, '外地的 near 应该是 false');
  assert.equal(body.list.find((x) => x.pet === '同城1').near, true, '同城的 near 是 true');
});

test('邀约列表最多六条，按发布时间新的在前', async () => {
  const env = { DB: makeDB() };
  const hexes = ['a', 'b', 'c', 'd', 'e', 'f', '1', '2'];
  for (let i = 0; i < hexes.length; i++) {
    const r = await worker.fetch(inviteReq('POST', mk({
      uid: hexes[i].repeat(24), pet: `鱼${i}`, from: 'xian', to: 'dali',
    })), env);
    assert.equal(r.status, 200, `第 ${i} 条没发出去：${await r.text()}`);
    await new Promise((res) => setTimeout(res, 2));
  }
  const body = await (await worker.fetch(new Request(
    `${INV}?city=xian&uid=${'b'.repeat(24)}`,
  ), env)).json();
  assert.equal(body.list.length, 6, `该截到六条，实际 ${body.list.length}`);
  assert.equal(body.list[0].pet, '鱼7', `最新的该排最前：${body.list.map((x) => x.pet).join('/')}`);
});

test('邀约返回里没有发起者的 uid —— 和碰面同一条线：看得见，摸不着', async () => {
  const env = { DB: makeDB() };
  const mine = 'abcdef0123456789abcdef01';
  await worker.fetch(inviteReq('POST', mk({ uid: mine })), env);

  const raw = await (await worker.fetch(new Request(
    `${INV}?city=xian&uid=${'b'.repeat(24)}`,
  ), env)).text();
  assert.ok(!raw.includes(mine), `uid 漏出去了：${raw}`);
  assert.ok(!/uid/.test(raw), '返回体里出现了 uid 字段');
});

test('全球都能收到（同城优先），就是不收自己的', async () => {
  /*
   * 2026-11-05 改口径：原来只给同城看。
   *
   * 池子只有几十个人的时候，「只给同城」等于永远没人接 —— 功能在，用不上。
   * 现在**全球可见、同城排前面**：她发的「想去拉萨」在兰州也看得见，
   * 而恰好在同一个城的人还是最先看到。
   */
  const env = { DB: makeDB() };
  const me = 'a'.repeat(24);
  await worker.fetch(inviteReq('POST', mk({ uid: me })), env);

  const other = await (await worker.fetch(new Request(
    `${INV}?city=lanzhou&uid=${'b'.repeat(24)}`,
  ), env)).json();
  assert.equal(other.list.length, 1, '别的城市也该看见了');

  const self = await (await worker.fetch(new Request(
    `${INV}?city=xian&uid=${me}`,
  ), env)).json();
  assert.equal(self.list.length, 0, '不该收到自己发的');
});

test('接受：拿到「和谁、去哪、几天」', async () => {
  const env = { DB: makeDB() };
  const { id } = await (await worker.fetch(inviteReq('POST', mk()), env)).json();

  const r = await worker.fetch(acceptReq({ uid: 'b'.repeat(24), id }), env);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.with, '大肥鱼');
  assert.equal(body.to, 'dali');
  assert.equal(body.days, 3);
});

test('五个人能接同一条邀约，第六个被挡', async () => {
  /*
   * **2026-11-05 改了语义。** 原来一条邀约只能有一个人接（第二个 409 taken），
   * 于是三只鱼同城时，A 和 B 走了、C 没位置可去 —— 用户原话
   * 「两两配对总有一个鱼会单出来」。
   *
   * 现在最多 MAX_PARTY - 1 个接单人（含发起者一共 MAX_PARTY 只）。
   * 2026-11-06 从 4 提到 6：Mr.Q 两只鱼（两台电脑）撞上了「本机的满了、另一台进不来」，
   * 而四条鱼一车本来就是他提过的场景。不再和「同城可见 4 只」绑在一起。
   */
  const env = { DB: makeDB() };
  const { id } = await (await worker.fetch(inviteReq('POST', mk()), env)).json();

  const uids = ['1', '2', '3', '4', '5'].map((c) => c.repeat(24));
  const got = [];
  for (const [i, uid] of uids.entries()) {
    const r = await worker.fetch(acceptReq({ uid, id, pet: `鱼${i + 1}` }), env);
    got.push(r.status);
  }
  assert.deepEqual(got, [200, 200, 200, 200, 200], `五个人没能一起接：${got}`);

  const r6 = await worker.fetch(acceptReq({ uid: '6'.repeat(24), id }), env);
  assert.equal(r6.status, 409, '第六个人也接上了 —— 队伍超过六只');
  assert.equal((await r6.json()).error, 'full', '拒绝原因不是 full');
});

test('同一个人重复接同一条：幂等成功，不重复计数', async () => {
  /*
   * 网络抖一下、或者她说两遍「接」，客户端会重发。
   * 第二遍回 409 会让她以为「没接上」，其实第一次就成功了。
   */
  const env = { DB: makeDB() };
  const { id } = await (await worker.fetch(inviteReq('POST', mk()), env)).json();
  const u = '9'.repeat(24);

  assert.equal((await worker.fetch(acceptReq({ uid: u, id }), env)).status, 200);
  const again = await worker.fetch(acceptReq({ uid: u, id }), env);
  assert.equal(again.status, 200, '重试一次就报错');
  assert.equal((await again.json()).already, true, '没标成「已经接过了」');

  const n = env.DB.query('SELECT COUNT(*) AS n FROM invite_takers WHERE id = ?', id)[0].n;
  assert.equal(Number(n), 1, '同一个人被记了两次');
});

test('发起者一次拿到所有接单人（一个人一行）', async () => {
  /*
   * 三只鱼接了同一条，发起者要能一次知道「小满、小汐、阿澈都来了」——
   * 而不是收到三条互相不知道对方存在的事件。
   */
  const env = { DB: makeDB() };
  const me = 'c'.repeat(24);
  const { id } = await (await worker.fetch(inviteReq('POST', mk({ uid: me })), env)).json();

  for (const [i, uid] of ['1', '2', '3'].entries()) {
    await worker.fetch(acceptReq({ uid: uid.repeat(24), id, pet: `鱼${i + 1}` }), env);
  }

  const r = await worker.fetch(
    new Request(`${BASE}/invite?uid=${me}&mine=1`, { headers: { 'cf-connecting-ip': '1.1.1.1' } }),
    env,
  );
  const list = (await r.json()).list ?? [];
  assert.equal(list.length, 3, `只回了 ${list.length} 个接单人`);
  assert.deepEqual(list.map((x) => x.pet).sort(), ['鱼1', '鱼2', '鱼3']);

  /* 认领一次就勾掉，第二次问应当没有可认领的了。 */
  const again = await worker.fetch(
    new Request(`${BASE}/invite?uid=${me}&mine=1`, { headers: { 'cf-connecting-ip': '1.1.1.1' } }),
    env,
  );
  assert.equal(((await again.json()).list ?? []).length, 0, '同一批被认领了两次');
});

test('自己的邀约不能接、过期不能接、不存在给 404', async () => {
  const env = { DB: makeDB() };
  const me = 'a'.repeat(24);
  const { id } = await (await worker.fetch(inviteReq('POST', mk({ uid: me })), env)).json();

  assert.equal((await worker.fetch(acceptReq({ uid: me, id }), env)).status, 400, '自己接自己的该拒');

  const db = env.DB;
  db.exec(`UPDATE invites SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = '${id}'`);
  assert.equal((await worker.fetch(acceptReq({ uid: 'b'.repeat(24), id }), env)).status, 410, '过期该拒');

  assert.equal((await worker.fetch(acceptReq({ uid: 'b'.repeat(24), id: 'f'.repeat(16) }), env)).status, 404);
});

test('一天最多发 3 条邀约', async () => {
  const env = { DB: makeDB() };
  const uid = 'c'.repeat(24);
  for (let i = 0; i < 3; i += 1) {
    const r = await worker.fetch(inviteReq('POST', mk({ uid, to: `city${i}` })), env);
    assert.equal(r.status, 200, `第 ${i + 1} 条该放行`);
  }
  assert.equal((await worker.fetch(inviteReq('POST', mk({ uid, to: 'toomuch' })), env)).status, 429);
});

test('一天最多接 1 条 —— 接多了是赶场，不是一起玩', async () => {
  const env = { DB: makeDB() };
  const { id: id1 } = await (await worker.fetch(inviteReq('POST', mk({ uid: 'd'.repeat(24) })), env)).json();
  const { id: id2 } = await (await worker.fetch(inviteReq('POST', mk({ uid: 'e'.repeat(24), to: 'lasa' })), env)).json();

  const me = 'f'.repeat(24);
  assert.equal((await worker.fetch(acceptReq({ uid: me, id: id1 }), env)).status, 200);
  assert.equal((await worker.fetch(acceptReq({ uid: me, id: id2 }), env)).status, 429);
});

test('邀约里的那句话也过滤 —— 它是整个系统唯一的自由文本', async () => {
  const env = { DB: makeDB() };
  await worker.fetch(inviteReq('POST', mk({ note: '加微信 abc123 领优惠券' })), env);
  const body = await (await worker.fetch(new Request(
    `${INV}?city=xian&uid=${'b'.repeat(24)}`,
  ), env)).json();
  assert.equal(body.list[0].note, '', `广告句漏出去了：${body.list[0].note}`);
});

test('「怎么去」是独立一列 —— 发文带上去，列表和接单都读得到', async () => {
  const env = { DB: makeDB() };
  const { id } = await (await worker.fetch(inviteReq('POST', mk({ note: '一起去看雪山', mode: '火车' })), env)).json();

  const pool = await (await worker.fetch(new Request(
    `${INV}?city=xian&uid=${'b'.repeat(24)}`,
  ), env)).json();
  assert.equal(pool.list[0].mode, '火车');
  assert.equal(pool.list[0].note, '一起去看雪山', '正文里不该混进走法');

  /* `/sight/status` 是客户端真正在用的那一条，别只测另一条。 */
  const st = await (await worker.fetch(new Request(
    `${BASE}/status?city=xian&uid=${'b'.repeat(24)}`,
  ), env)).json();
  assert.equal(st.list[0].mode, '火车');

  /* 接的人也得知道 —— 否则这个字段只是公告栏上的装饰。 */
  const acc = await (await worker.fetch(acceptReq({ uid: 'c'.repeat(24), id }), env)).json();
  assert.equal(acc.mode, '火车');
});

test('「怎么去」和正文一样过内容过滤，长度也截', async () => {
  const env = { DB: makeDB() };
  await worker.fetch(inviteReq('POST', mk({ uid: 'a'.repeat(24), mode: '加微信 abc123 领优惠券' })), env);
  await worker.fetch(inviteReq('POST', mk({ uid: 'd'.repeat(24), to: 'lasa', mode: '火车' + '慢一点'.repeat(20) })), env);
  const body = await (await worker.fetch(new Request(
    `${INV}?city=xian&uid=${'b'.repeat(24)}`,
  ), env)).json();
  const byTo = Object.fromEntries(body.list.map((x) => [x.to, x.mode]));
  assert.equal(byTo.dali, '', `广告词漏进走法了：${byTo.dali}`);
  assert.equal(byTo.lasa.length, 40, `没截到 40：${byTo.lasa.length}`);
});

test('邀约里的名字也过滤', async () => {
  const env = { DB: makeDB() };
  await worker.fetch(inviteReq('POST', mk({ pet: 'www.abc.com' })), env);
  const body = await (await worker.fetch(new Request(
    `${INV}?city=xian&uid=${'b'.repeat(24)}`,
  ), env)).json();
  assert.equal(body.list[0].pet, '一只鱼');
});

test('过期邀约在清理时被删掉，按「过期」不按日期', async () => {
  const db = makeDB();
  const env = { DB: db };
  const { id } = await (await worker.fetch(inviteReq('POST', mk()), env)).json();
  // 一条昨天发、还没过期的（按日期删会误伤）
  db.exec(`INSERT INTO invites (id,uid,pet,from_city,to_city,days,note,date_key,at,expires_at)
           VALUES ('${'0'.repeat(16)}','${'b'.repeat(24)}','小满','chengdu','lasa',2,'',  '2000-01-01','2000-01-01T00:00:00Z',
                   '${new Date(Date.now() + 3_600_000).toISOString()}')`);
  // 一条已经过期的
  db.exec(`UPDATE invites SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = '${id}'`);

  await worker.scheduled({}, env);

  const left = db.query('SELECT id FROM invites');
  assert.equal(left.length, 1, `应该只剩还没过期那条，实际 ${left.length}`);
  assert.equal(left[0].id, '0'.repeat(16));
});

test('邀请路径的尾斜杠也认', async () => {
  const env = { DB: makeDB() };
  const r = await worker.fetch(new Request(`https://sight.test/sight/invite/?city=xian&uid=${'b'.repeat(24)}`), env);
  assert.equal(r.status, 200);
});

/* ---------- 2026-11-05：全球可见 + 发起者也认领（两条鱼一起去） ---------- */

test('按发布时间排：后发的在前，同城只标一句、不插队', async () => {
  const env = { DB: makeDB() };
  /*
   * 2026-11-25 之前这条叫「同城的排前面」，断言的是 `ORDER BY near DESC`。
   * 那个排序配 `LIMIT 3` 就是把外地的挤出窗口的原因（用户看到的现象是
   * 「邀约只看得见同城的」）。现在按时间排，同城只剩一个标记。
   */
  await worker.fetch(inviteReq('POST', mk({ uid: 'c'.repeat(24), pet: '同城鱼', from: 'xian' })), env);
  await new Promise((res) => setTimeout(res, 3));
  await worker.fetch(inviteReq('POST', mk({ uid: 'd'.repeat(24), pet: '外地鱼', from: 'lasa' })), env);

  const body = await (await worker.fetch(new Request(
    `${INV}?city=xian&uid=${'b'.repeat(24)}`,
  ), env)).json();
  assert.equal(body.list.length, 2, '两个人发的都该在');
  assert.equal(body.list[0].pet, '外地鱼', `新的该在前（同城不插队），实际 ${body.list[0].pet}`);
  assert.equal(body.list[0].near, false);
  assert.equal(body.list[1].near, true, '同城那条仍然是 near');
});

test('接的人的名字要写下来 —— 发起者靠它知道「谁接了」', async () => {
  const env = { DB: makeDB() };
  const me = 'a'.repeat(24);
  const { id } = await (await worker.fetch(inviteReq('POST', mk({ uid: me })), env)).json();

  await worker.fetch(acceptReq({ uid: 'b'.repeat(24), id, pet: '小银鱼' }), env);

  const mine = await (await worker.fetch(new Request(
    `${INV}?uid=${me}&mine=1`,
  ), env)).json();
  assert.equal(mine.list.length, 1, '发起者该看到「有人接了」');
  assert.equal(mine.list[0].pet, '小银鱼', '没把接的人的名字带回来');
  assert.equal(mine.list[0].to, 'dali');

  // 只返回一次：认领过就勾掉，不会每次排表都重建约定
  const again = await (await worker.fetch(new Request(
    `${INV}?uid=${me}&mine=1`,
  ), env)).json();
  assert.equal(again.list.length, 0, '同一条被返回了两次');
});

/* ---------- 2026-11-05：浏览器打开根路径不能回 not found ---------- */

test('根路径给人看：说明页 + 今天的池子数量', async () => {
  const env = { DB: makeDB() };
  /*
   * 「今天」必须跟着真实日期走。
   *
   * `landingPage` 里是 `new Date().toISOString().slice(0,10)`。原来这里写死
   * `rec()` 默认的 `2026-11-05` —— 写这条测试的那天是绿的，第二天必然变红，
   * 而红的原因跟代码一点关系都没有（2026-11-06 早上就是这么红的）。
   */
  const today = new Date().toISOString().slice(0, 10);
  await worker.fetch(post(rec({ date: today })), env);   // 先塞一条，池子该是 1

  const r = await worker.fetch(new Request('https://sight.test/', {
    headers: { 'cf-connecting-ip': '1.1.1.1' },
  }), env);
  assert.equal(r.status, 200, '根路径该是 200，不是 404');
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  const html = await r.text();
  assert.match(html, /碰面服务器/);
  assert.ok(html.includes('https://sight.test'), '没把该填的地址写出来');
  assert.ok(!html.includes('not found'), '还在回 not found');
  const at = html.indexOf('今天这个池子'); assert.ok(html.includes('>1<'), `没显示池子数量：${at < 0 ? '连这句都没有' : html.slice(at, at + 90)}`);
});

test('未知子路径仍然是 404 —— 不给扫描器留探测面', async () => {
  const env = { DB: makeDB() };
  const r = await worker.fetch(new Request('https://sight.test/wp-admin', {
    headers: { 'cf-connecting-ip': '1.1.1.1' },
  }));
  assert.equal(r.status, 404);
});

test('五个人接满之后，这条邀约从别人的列表里消失', async () => {
  /*
   * 不然第四只鱼会一直看见一条点进去就 409 的邀约 —— 那比看不见更烦。
   */
  const env = { DB: makeDB() };
  const owner = 'f'.repeat(24);
  const { id } = await (await worker.fetch(inviteReq('POST', mk({ uid: owner })), env)).json();

  const viewer = 'e'.repeat(24);
  const listFor = async () => {
    const r = await worker.fetch(
      new Request(`${BASE}/invite?uid=${viewer}&city=xian`, { headers: { 'cf-connecting-ip': '9.9.9.9' } }),
      env,
    );
    return (await r.json()).list ?? [];
  };

  assert.equal((await listFor()).some((x) => x.id === id), true, '还没人接就看不见了');

  for (const c of ['1', '2', '3', '4', '5']) {
    await worker.fetch(acceptReq({ uid: c.repeat(24), id, pet: `鱼${c}` }), env);
  }
  assert.equal((await listFor()).some((x) => x.id === id), false, '接满五条还挂在列表里');
});

test('定时清理会带走孤儿接单记录，但不动还挂着的邀约', async () => {
  /*
   * 加了表就必须加清理：邀约过期被删、takers 留着，表会一直长。
   * 但**不能按时间删 takers** —— 一条还没过期的邀约，它的接单记录一条都不能动。
   */
  const env = { DB: makeDB() };
  const { id: live } = await (await worker.fetch(inviteReq('POST', mk({ uid: '1'.repeat(24) })), env)).json();
  const { id: dead } = await (await worker.fetch(inviteReq('POST', mk({ uid: '2'.repeat(24) })), env)).json();

  await worker.fetch(acceptReq({ uid: '3'.repeat(24), id: live, pet: '活鱼' }), env);
  await worker.fetch(acceptReq({ uid: '4'.repeat(24), id: dead, pet: '死鱼' }), env);

  // 把 dead 那条弄成过期，再手动删掉邀约本身（模拟清理先跑过一轮）
  env.DB.exec(`UPDATE invites SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = '${dead}'`);
  env.DB.exec(`DELETE FROM invites WHERE id = '${dead}'`);

  await worker.scheduled({}, env);

  const left = env.DB.query('SELECT id, pet FROM invite_takers ORDER BY pet');
  assert.deepEqual(left.map((x) => x.pet), ['活鱼'], `孤儿没清干净或误删了活记录：${JSON.stringify(left)}`);
});

/* ---------- 2026-11-06：扩展市场索引的国内镜像 ---------- */

test('市场镜像：索引文件原样反代，且只放行索引仓那几类路径', async () => {
  /*
   * 宿主读索引的超时是硬编码的 3 秒 / 5 秒，国内直连 raw 要 2.2 秒 —— 一抖就整片市场读不出来。
   * 这个 worker 在 Cloudflare 上，反代一遍最省事。**不能做成开放式反代**：那样会被人当免费代理用。
   */
  const env = { DB: makeDB() };
  const orig = globalThis.fetch;
  let hit = '';
  globalThis.fetch = async (u) => {
    hit = String(u);
    return new Response(JSON.stringify({ ok: true, version: '0.7.12' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const r = await worker.fetch(new Request('https://sight.test/market2/catalog.json'), env);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /application\/json/);
    assert.equal(r.headers.get('access-control-allow-origin'), '*', '缺 CORS，宿主那边是另外的来源');
    const body = await r.json();
    assert.equal(body.version, '0.7.12', '内容没原样带回来');
    assert.match(hit, /raw\.githubusercontent\.com\/Pal-AI-Lab\/cortico-extensions\/main\/catalog\.json$/);

    // 不在白名单里的路径一律 404，不去打上游
    hit = '';
    for (const bad of ['/market/package.json', '/market/../secrets', '/market/packages/a/b.json']) {
      const r2 = await worker.fetch(new Request(`https://sight.test${bad}`), env);
      assert.equal(r2.status, 404, `放行了不该反代的路径：${bad}`);
    }
    assert.equal(hit, '', '拒掉的请求居然真的打到了上游');
  } finally { globalThis.fetch = orig; }
});

/* ---------- 见面城与流速（2026-11-07） ---------- */

test('见面城：存得下、四处都回得出来，老客户端不发也照旧能用', async () => {
  /*
   * Mr.Q：「约好在哪个城市见面，然后一起走，最后从哪个城市一起分开」。
   * 协议里只多一个字段 —— 「分开的城」就是 `to`。
   *
   * 这条测的是**四个出口都要带上它**：发完之后看列表、发起者认领（mine=1）、
   * /status、以及接的那一下。少一处，那一侧的人就永远不知道要先去哪儿会合。
   */
  const env = { DB: makeDB() };
  const me = 'a'.repeat(24);
  const other = 'b'.repeat(24);

  const { id } = await (await worker.fetch(
    inviteReq('POST', mk({ uid: me, from: 'xian', to: 'lasa', meet: 'chengdu', pace: 6 })),
    env,
  )).json();

  // ① 池子列表
  const list = await (await worker.fetch(new Request(`${INV}?city=xian&uid=${other}`), env)).json();
  assert.equal(list.list[0].meet, 'chengdu', `列表没回见面城：${JSON.stringify(list.list[0])}`);
  assert.equal(list.list[0].pace, 6, `列表没回流速：${JSON.stringify(list.list[0])}`);

  // ② /status
  const st = await (await worker.fetch(new Request(`${BASE}/status?city=xian&uid=${other}`), env)).json();
  assert.equal(st.list[0].meet, 'chengdu', '/status 没回见面城 —— 那半边永远不知道去哪儿会合');
  assert.equal(st.list[0].pace, 6);

  // ③ 接的那一下
  const acc = await (await worker.fetch(acceptReq({ uid: other, id, pet: '小满' }), env)).json();
  assert.equal(acc.meet, 'chengdu', `accept 没回见面城：${JSON.stringify(acc)}`);
  assert.equal(acc.to, 'lasa', '接完就分不清「一起去哪儿」了');

  // ④ 发起者认领
  const mine = await (await worker.fetch(true
    ? new Request(`${INV}?uid=${me}&mine=1`, { headers: { 'cf-connecting-ip': '1.1.1.1' } })
    : new Request(`${INV}?uid=${me}&mine=1`), env)).json();
  assert.equal(mine.list[0].meet, 'chengdu', 'mine=1 没回见面城 —— 发起者会以为直接去拉萨');
  assert.equal(mine.list[0].pace, 6);

  // 老客户端：不发 meet / pace，两列落默认值，接口照常
  const old = await worker.fetch(inviteReq('POST', mk({ uid: other, from: 'xian', to: 'dali' })), env);
  assert.equal(old.status, 200, '老客户端（不带 meet）被拒了');
  const db = env.DB;
  const row = db.query(`SELECT meet_city, pace FROM invites WHERE uid = '${other}'`)[0];
  assert.equal(row.meet_city, '', '没发 meet 时该落空串');
  assert.equal(row.pace, 0, '没发 pace 时该落 0（= 没报）');
});

test('见面城只校验形状，不校验「是不是真有这座城」', async () => {
  /*
   * **这是一个刻意的边界，不是漏了。**
   *
   * 城市表在客户端（128 座，随版本变），服务端不认识它 —— 让服务端去校验成员资格，
   * 就意味着一改城市表就得同时部署服务端，而且新旧版本会打架。
   *
   * 所以这里只守两件事：形状不对的字符串进不来（会污染别人的界面上那一行），
   * 空串是合法的（= 老口径：就在目的地见）。
   * 「这座城市到底有没有」由客户端在发送前查表，`inviteSomeone` 里就这么做的。
   */
  const env = { DB: makeDB() };
  const bad = await worker.fetch(inviteReq('POST', mk({ meet: '成都 拉萨' })), env);
  assert.equal(bad.status, 400, `形状不对的见面城被收下了：${bad.status}`);
  const cn = await worker.fetch(inviteReq('POST', mk({ uid: 'e'.repeat(24), meet: '成都' })), env);
  assert.equal(cn.status, 400, '中文名不该当城市 id 收下（id 是 latin 的 slug）');
  // 空串是合法的
  const ok = await worker.fetch(inviteReq('POST', mk({ meet: '' })), env);
  assert.equal(ok.status, 200, '空字符串该被当成「没有这一级」');
});

test('流速钳在 0–240，负数和离谱的数值不写进库', async () => {
  const env = { DB: makeDB() };
  await worker.fetch(inviteReq('POST', mk({ uid: 'c'.repeat(24), pace: -5 })), env);
  await worker.fetch(inviteReq('POST', mk({ uid: 'd'.repeat(24), pace: 9999 })), env);
  const rows = env.DB.query('SELECT pace FROM invites ORDER BY pace');
  assert.deepEqual(rows.map((r) => r.pace), [0, 240], `钳位不对：${JSON.stringify(rows)}`);
});

/* ==================================================================
 * 同行卡（2026-11-11，Discussion #586）
 *
 * 用户来信：「约到一起的那几天里，让同行的伙伴能留下一个号，
 * 或者留一句话。不用多复杂，能让我在别处说一句『我在』就够了。」
 *
 * 这一组守四件事：只给同一段同行的人看、看不见是谁留的、
 * 号能留进去但链接留不进去、改自己的卡不扣额度。
 * ================================================================== */

const CARD = 'https://sight.test/sight/card';
const cardReq = (method, body, q) => new Request(
  method === 'GET' ? `${CARD}?${q}` : CARD,
  {
    method,
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.1.1.1' },
    body: body ? JSON.stringify(body) : undefined,
  },
);

/** 造一段「A 发起、B 接了」的真实同行关系，返回邀约编号。 */
async function party(env, uidA = 'a'.repeat(24), uidB = 'b'.repeat(24)) {
  const r = await worker.fetch(inviteReq('POST', mk({ uid: uidA, pet: '发起的那只' })), env);
  const { id } = await r.json();
  const a = await worker.fetch(acceptReq({ uid: uidB, id, pet: '接的那只' }), env);
  assert.equal(a.status, 200, '接单没成功，后面的场景就不成立了');
  return id;
}

test('同行卡：一起走过的人留了，对方取得到', async () => {
  const env = { DB: makeDB() };
  const uidA = 'a'.repeat(24);
  const uidB = 'b'.repeat(24);
  const id = await party(env, uidA, uidB);

  const put = await worker.fetch(cardReq('POST', {
    uid: uidB, id, pet: '接的那只', note: '大理那三天，谢谢你半夜陪我找药店', contact: '微信号 dali_2026',
  }), env);
  assert.equal(put.status, 200);

  const got = await (await worker.fetch(cardReq('GET', null, `id=${id}&uid=${uidA}`), env)).json();
  assert.equal(got.ok, true);
  assert.equal(got.cards.length, 1);
  assert.equal(got.cards[0].pet, '接的那只');
  assert.match(got.cards[0].note, /找药店/);
  assert.match(got.cards[0].contact, /dali_2026/);
});

test('同行卡：自己那张单独放 mine，不混进「别人留了什么」', async () => {
  const env = { DB: makeDB() };
  const uidA = 'a'.repeat(24);
  const uidB = 'b'.repeat(24);
  const id = await party(env, uidA, uidB);
  await worker.fetch(cardReq('POST', { uid: uidA, id, pet: '发起的那只', note: '我先留一句' }), env);

  const got = await (await worker.fetch(cardReq('GET', null, `id=${id}&uid=${uidA}`), env)).json();
  assert.equal(got.cards.length, 0, '别人的列表里不该出现自己');
  assert.equal(got.mine.note, '我先留一句', '自己留的话要能拿回来回填，否则改不了');
});

test('同行卡：还没留过的时候 mine 是 null', async () => {
  const env = { DB: makeDB() };
  const id = await party(env);
  const got = await (await worker.fetch(cardReq('GET', null, `id=${id}&uid=${'a'.repeat(24)}`), env)).json();
  assert.equal(got.mine, null);
});

test('同行卡：不是这段同行的人，猜对 id 也拿不到', async () => {
  const env = { DB: makeDB() };
  const id = await party(env);
  const outsider = 'c'.repeat(24);
  const r = await worker.fetch(cardReq('GET', null, `id=${id}&uid=${outsider}`), env);
  assert.equal(r.status, 403, '这是这套东西的底线：没一起走过就看不见别人留的号');
});

test('同行卡：局外人留不进去', async () => {
  const env = { DB: makeDB() };
  const id = await party(env);
  const r = await worker.fetch(cardReq('POST', {
    uid: 'c'.repeat(24), id, pet: '路过的', note: '我也来留一张',
  }), env);
  assert.equal(r.status, 403);
});

test('同行卡：号能留进去 —— 这就是这个功能的字面诉求', async () => {
  const env = { DB: makeDB() };
  const uidA = 'a'.repeat(24);
  const uidB = 'b'.repeat(24);
  const id = await party(env, uidA, uidB);

  // 三种常见的写法，都不能被 AD_PATTERNS 当成广告清掉
  for (const contact of ['微信号 dali_2026', 'QQ 12345678', '13800138000']) {
    const r = await worker.fetch(cardReq('POST', { uid: uidB, id, pet: '接的那只', contact }), env);
    assert.equal(r.status, 200, `「${contact}」被拦了，那这个功能就没意义了`);
    const got = await (await worker.fetch(cardReq('GET', null, `id=${id}&uid=${uidA}`), env)).json();
    assert.equal(got.cards[0].contact, contact, `「${contact}」存进去之后又变了`);
  }
});

test('同行卡：链接留不进去 —— 号是给认识的人用的，链接是给陌生人用的', async () => {
  const env = { DB: makeDB() };
  const uidA = 'a'.repeat(24);
  const uidB = 'b'.repeat(24);
  const id = await party(env, uidA, uidB);

  const r = await worker.fetch(cardReq('POST', {
    uid: uidB, id, pet: '接的那只', contact: 'https://example.com/abc',
  }), env);
  assert.equal(r.status, 400, '只留链接等于一张空卡，应该拒掉');

  // 一句话加链接：话留下、链接扔掉
  const r2 = await worker.fetch(cardReq('POST', {
    uid: uidB, id, pet: '接的那只', note: '路上慢点', contact: 'www.spam.cn',
  }), env);
  assert.equal(r2.status, 200);
  const got = await (await worker.fetch(cardReq('GET', null, `id=${id}&uid=${uidA}`), env)).json();
  assert.equal(got.cards[0].contact, '', '链接那格必须清空');
  assert.equal(got.cards[0].note, '路上慢点');
});

test('同行卡：什么都没有的卡不写 —— 别在别人相册里塞一张空白', async () => {
  const env = { DB: makeDB() };
  const uidB = 'b'.repeat(24);
  const id = await party(env, 'a'.repeat(24), uidB);
  const r = await worker.fetch(cardReq('POST', { uid: uidB, id, pet: '接的那只' }), env);
  assert.equal(r.status, 400);
});

test('同行卡：改自己那张不扣额度，改十次也还能改', async () => {
  const env = { DB: makeDB() };
  const uidB = 'b'.repeat(24);
  const id = await party(env, 'a'.repeat(24), uidB);
  for (let i = 0; i < 8; i += 1) {
    const r = await worker.fetch(cardReq('POST', {
      uid: uidB, id, pet: '接的那只', note: `第 ${i} 版`,
    }), env);
    assert.equal(r.status, 200, `第 ${i + 1} 次改写被限流挡了 —— 改一个字就重发是正常动作`);
  }
});

test('同行卡：接口不回 uid —— 名字够了，uid 一旦出去就能串起这个人的所有行程', async () => {
  const env = { DB: makeDB() };
  const uidA = 'a'.repeat(24);
  const uidB = 'b'.repeat(24);
  const id = await party(env, uidA, uidB);
  await worker.fetch(cardReq('POST', { uid: uidB, id, pet: '接的那只', note: '留一句' }), env);

  const got = await (await worker.fetch(cardReq('GET', null, `id=${id}&uid=${uidA}`), env)).json();
  assert.deepEqual(Object.keys(got.cards[0]).sort(), ['at', 'contact', 'note', 'pet']);
});

/* ==================================================================
 * 名片（2026-11-11，Discussion #586 后半段）
 *
 * chloveln 提的是「简介 + 请求同意」。这一版把「同意」换成了
 * 「真的一起走过」—— 因为没有通知通道，一个要等见面才生效的同意
 * 比不给更难受。这组测试守的就是那条可见性边界。
 * ================================================================== */

const PROF = 'https://sight.test/sight/profile';
const profReq = (method, body, q) => new Request(
  method === 'GET' ? `${PROF}?${q}` : PROF,
  {
    method,
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.1.1.1' },
    body: body ? JSON.stringify(body) : undefined,
  },
);

test('名片：陌生人看不见 —— 这是整套东西的底线', async () => {
  const env = { DB: makeDB() };
  const uidA = 'a'.repeat(24);
  const uidC = 'c'.repeat(24);
  await worker.fetch(profReq('POST', { uid: uidC, pet: '路过的', text: '我的名片' }), env);

  const got = await (await worker.fetch(profReq('GET', null, `uid=${uidA}`), env)).json();
  assert.equal(got.others.length, 0, '没一起走过就看不见别人的名片');
});

test('名片：发起者看得见接单的人，接单的人看得见发起者', async () => {
  const env = { DB: makeDB() };
  const uidA = 'a'.repeat(24);
  const uidB = 'b'.repeat(24);
  const id = await party(env, uidA, uidB);
  await worker.fetch(profReq('POST', { uid: uidA, pet: '发起的那只', text: '常驻成都' }), env);
  await worker.fetch(profReq('POST', { uid: uidB, pet: '接的那只', text: '花语乡 id: xiaoman' }), env);

  const forA = await (await worker.fetch(profReq('GET', null, `uid=${uidA}`), env)).json();
  assert.equal(forA.others.length, 1);
  assert.equal(forA.others[0].pet, '接的那只');

  const forB = await (await worker.fetch(profReq('GET', null, `uid=${uidB}`), env)).json();
  assert.equal(forB.others.length, 1);
  assert.equal(forB.others[0].pet, '发起的那只');
});

test('名片：同一段同行里的两个接单人也互相看得见 —— 少算这一种就会有一半人看不见', async () => {
  const env = { DB: makeDB() };
  const uidA = 'a'.repeat(24);
  const uidB = 'b'.repeat(24);
  const uidC = 'c'.repeat(24);
  const r = await worker.fetch(inviteReq('POST', mk({ uid: uidA, pet: '发起的那只' })), env);
  const { id } = await r.json();
  for (const [u, p] of [[uidB, '接的一'], [uidC, '接的二']]) {
    await worker.fetch(acceptReq({ uid: u, id, pet: p }), env);
  }
  await worker.fetch(profReq('POST', { uid: uidB, pet: '接的一', text: '我是接的一' }), env);

  const got = await (await worker.fetch(profReq('GET', null, `uid=${uidC}`), env)).json();
  assert.equal(got.others.length, 1, '同一条邀约的两个接单人是一起走过的');
  assert.equal(got.others[0].pet, '接的一');
});

test('名片：自己的那张单独放 mine，可以拿回来改', async () => {
  const env = { DB: makeDB() };
  const uidA = 'a'.repeat(24);
  await worker.fetch(profReq('POST', { uid: uidA, pet: '我', text: '第一版' }), env);
  const got = await (await worker.fetch(profReq('GET', null, `uid=${uidA}`), env)).json();
  assert.equal(got.mine.text, '第一版');
  assert.equal(got.others.length, 0, '自己不算「别人」');
});

test('名片：留空就是撤回 —— 想收回不该只能等 30 天', async () => {
  const env = { DB: makeDB() };
  const uidA = 'a'.repeat(24);
  await worker.fetch(profReq('POST', { uid: uidA, pet: '我', text: '写过' }), env);
  const r = await worker.fetch(profReq('POST', { uid: uidA, pet: '我', text: '' }), env);
  assert.equal(r.status, 200);
  const got = await (await worker.fetch(profReq('GET', null, `uid=${uidA}`), env)).json();
  assert.equal(got.mine, null, '撤回之后就不该还挂着一张');
});

test('名片：外部 id 能写进去，链接写不进去', async () => {
  const env = { DB: makeDB() };
  const uidA = 'a'.repeat(24);

  for (const text of ['花语乡 id: xiaoman；星邮：m@2026', '微信号 dali_2026', 'QQ 12345678']) {
    const r = await worker.fetch(profReq('POST', { uid: uidA, pet: '我', text }), env);
    assert.equal(r.status, 200, `「${text}」被拦了 —— 名片的意义就是让人找到你`);
    const got = await (await worker.fetch(profReq('GET', null, `uid=${uidA}`), env)).json();
    assert.equal(got.mine.text, text);
  }

  const r2 = await worker.fetch(profReq('POST', { uid: uidA, pet: '我', text: '看这个 https://x.test' }), env);
  assert.equal(r2.status, 200);
  const got2 = await (await worker.fetch(profReq('GET', null, `uid=${uidA}`), env)).json();
  assert.equal(got2.mine, null, '整段只有链接，洗完成空 → 等于撤回');
});

test('名片：过期就看不见了', async () => {
  const env = { DB: makeDB() };
  const uidA = 'a'.repeat(24);
  const uidB = 'b'.repeat(24);
  await party(env, uidA, uidB);
  await worker.fetch(profReq('POST', { uid: uidB, pet: '接的那只', text: '到期测试' }), env);
  // 手动把 exp 拨到过去
  env.DB.exec("UPDATE profiles SET exp = '2000-01-01T00:00:00Z' WHERE uid = '" + uidB + "'");

  const got = await (await worker.fetch(profReq('GET', null, `uid=${uidA}`), env)).json();
  assert.equal(got.others.length, 0, '过期的名片不该还被列出来');
});

/* ---------------- 错误计数（2026-11-14） ---------------- */

test('DB 挂了时，错误记账不能把请求再搞挂一次', async () => {
  /*
   * 记账本身失败必须静默 —— 否则「一个错误」会变成「两个错误」，
   * 而且第二个是在处理第一个的过程中抛的，堆栈会指错地方。
   *
   * 11-12 那次全站 500 没有任何落库线索，所以补了 errors 表；
   * 但补法不能是「每处 catch 里同步写一行」—— 那会双向放大。
   */
  const brokenDb = {
    prepare() { throw new Error('D1 quota exceeded'); },
    query() { return []; },
  };
  const env = { DB: brokenDb };
  const r = await worker.fetch(
    new Request(`${BASE}/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid: UID_A, pet: '大肥鱼', text: '测试', contact: '' }),
    }),
    env,
  );
  assert.equal(r.status, 500, '应该正常返回 500，不该把异常抛出去');
});

test('同类错误落一行，后到的累加 count 并更新 last_msg', async () => {
  /*
   * 错误风暴时每次请求都报错，每次都写一行的话，一次事故就烧掉整月写额度。
   * 进程内闸（同 tag 一分钟一次）拦在前面，之后靠 upsert 累加。
   *
   * 单测造不出「两个不同 isolate」，所以这里只验 SQL 那一半：
   * 同键重复写必须是 count+1，而不是多一行。
   */
  const env = { DB: makeDB() };
  const iso = '2026-11-14T19:00:00.000Z';
  const stmt = (n) => env.DB.prepare(
    `INSERT INTO errors (day, hour, path, tag, count, last_msg, last_at)
     VALUES (?1,?2,?3,?4,1,?5,?6)
     ON CONFLICT(day, hour, path, tag) DO UPDATE SET
       count = errors.count + 1, last_msg = excluded.last_msg, last_at = excluded.last_at`,
  ).bind(iso.slice(0, 10), iso.slice(0, 13), '/sight/status', '[sight status]', `msg${n}`, iso);
  stmt(1).run();
  stmt(2).run();
  stmt(3).run();
  const rows = env.DB.query('SELECT count, last_msg FROM errors');
  assert.equal(rows.length, 1, `应该只有一行：${JSON.stringify(rows)}`);
  assert.equal(rows[0].count, 3, 'count 没累加');
  assert.equal(rows[0].last_msg, 'msg3', 'last_msg 没更新成最新那条');
});

/* ---------------- 条件写入（2026-11-15） ---------------- */

test('内容没变就不写，变了必须写', async () => {
  /*
   * 2026-11-15：D1 一天 18,776 次写查询、80,141 行写入，而 presence 只有 1,351 行。
   * 差在「每次心跳都原样写一遍」—— 1 行表 + 5 个索引，平均 4.3 行/次。
   *
   * 加 WHERE 之后：内容变了立刻写；没变就等 25 分钟兜底（`online` 判定窗口是 30 分钟，
   * 25 分钟留 5 分钟余量给时钟漂移和请求排队）。
   */
  const db = makeDB();
  const env = { DB: db };
  assert.equal((await worker.fetch(post(rec({ doing: '吃面' })), env)).status, 200);
  const first = db.query('SELECT at, doing FROM presence')[0];

  // 同一内容再报一次：被 WHERE 挡掉，at 不该动
  assert.equal((await worker.fetch(post(rec({ doing: '吃面' })), env)).status, 200);
  const second = db.query('SELECT at, doing FROM presence')[0];
  assert.equal(second.at, first.at, '内容一个字没变，却又写了一次');

  // 内容变了：必须写，否则「她在干嘛」就永远停在旧的那句
  assert.equal((await worker.fetch(post(rec({ doing: '还在回民街' })), env)).status, 200);
  const third = db.query('SELECT at, doing FROM presence')[0];
  assert.equal(third.doing, '还在回民街', '内容变了却没写进去');
});

test('内容没变也要在 25 分钟内写一次 —— 否则在线会被判成离线', async () => {
  /*
   * `online`（此刻在线多少只）按「最近 30 分钟有上报」算。
   * 如果内容没变就永远不写，`at` 会一直停在第一次，人就"永远在线"或"突然全部离线"。
   *
   * 这里把 at 往前拨 30 分钟再报一次同样的内容，应该被兜底条件放行。
   */
  const db = makeDB();
  const env = { DB: db };
  assert.equal((await worker.fetch(post(rec({ doing: '吃面' })), env)).status, 200);

  // 手动把 at 拨回 30 分钟前，模拟"内容没变但过了很久"
  db.exec(`UPDATE presence SET at = datetime('now', '-30 minutes')`);
  const old = db.query('SELECT at FROM presence')[0].at;

  assert.equal((await worker.fetch(post(rec({ doing: '吃面' })), env)).status, 200);
  const now = db.query('SELECT at FROM presence')[0].at;
  assert.notEqual(now, old, '超过 25 分钟了还不写，online 会算错');
});

test('换了 IP 不算内容变化 —— 移动网络天天换', async () => {
  /*
   * 2026-11-15 深夜：条件写入上线后 24 小时只跳过 5%，白做。
   *
   * 查线上数据才发现：414 只鱼对应 **963 个不同 ip_hash**。移动网络、代理、
   * IPv6 轮换每换一次，`ip_hash <> excluded.ip_hash` 就成立一次 ——
   * 而我把这个字段也放进了「变了才写」的条件里。
   *
   * `ip_hash` 只是记录（风控看「同一 IP 几只鱼」），不是她的状态。
   */
  const db = makeDB();
  const env = { DB: db };
  const send = (ip, doing) => new Request(`${BASE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify(rec({ doing })),
  });

  assert.equal((await worker.fetch(send('1.1.1.1', '吃面'), env)).status, 200);
  const first = db.query('SELECT at FROM presence')[0].at;

  // 内容一个字没变，只有 IP 换了 —— 不该重写整行
  assert.equal((await worker.fetch(send('2.2.2.2', '吃面'), env)).status, 200);
  const second = db.query('SELECT at FROM presence')[0].at;
  assert.equal(second, first, '只是换了个 IP 就重写整行，条件写入等于没做');
});

test('window 参数：默认 2h 不变；传 24h 可见 8h 前上报的伴，超 24h 钳位', async () => {
  const db = makeDB();
  const env = { DB: db };
  assert.equal((await worker.fetch(post(rec({ uid: UID_B, pet: '潮信', city: 'shenyang', slot: 'night', doing: '逛中街' })), env)).status, 200);

  // 拨回 8 小时前（00:00 上报 → 08:00 查询）
  const at8h = new Date(Date.now() - 8 * 3600_000).toISOString();
  db.exec(`UPDATE presence SET at = '${at8h}' WHERE uid = '${UID_B}'`);

  const defBody = await (await worker.fetch(get('city=shenyang&slot=night'), env)).json();
  assert.equal(defBody.list.length, 0, '默认 2h 窗口下 8 小时前记录不应返回');

  const win24 = await (await worker.fetch(get(`city=shenyang&slot=night&window=${24 * 3600_000}&limit=20`), env)).json();
  assert.equal(win24.list.length, 1, '传 24h 窗口时应看见 8 小时前上报的同伴');
  assert.equal(win24.list[0].pet, '潮信');

  // 拨回 25 小时前，就算传 48h 也要被钳死在 24h 上限内
  const at25h = new Date(Date.now() - 25 * 3600_000).toISOString();
  db.exec(`UPDATE presence SET at = '${at25h}' WHERE uid = '${UID_B}'`);
  const win48 = await (await worker.fetch(get(`city=shenyang&slot=night&window=${48 * 3600_000}`), env)).json();
  assert.equal(win48.list.length, 0, 'window 参数必须封顶 24 小时');
});

test('24h 窗口按 uid 去重：倍速鱼跨多个 date_key 不占满同城名额', async () => {
  const db = makeDB();
  const env = { DB: db };
  // UID_A 开 24x 写了 4 个不同 date_key 的 night 行；UID_B 写 1 行
  const dates = ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23'];
  for (let i = 0; i < dates.length; i += 1) {
    const d = dates[i];
    assert.equal((await worker.fetch(post(rec({
      uid: UID_A, pet: '倍速鱼', city: 'shenyang', date: d, slot: 'night', doing: `第${d}天`,
    })), env)).status, 200);
    const ts = new Date(Date.now() - (5 - i) * 3600_000).toISOString();
    db.exec(`UPDATE presence SET at = '${ts}' WHERE uid = '${UID_A}' AND date_key = '${d}'`);
  }
  assert.equal((await worker.fetch(post(rec({
    uid: UID_B, pet: '潮信', city: 'shenyang', date: '2026-11-20', slot: 'night', doing: '等同伴',
  })), env)).status, 200);

  // 让倍速鱼的 4 行时间戳全部晚于潮信，看按 uid 去重后 limit=2 能否保留潮信
  const tOld = new Date(Date.now() - 6 * 3600_000).toISOString();
  db.exec(`UPDATE presence SET at = '${tOld}' WHERE uid = '${UID_B}'`);

  const body = await (await worker.fetch(get(`city=shenyang&slot=night&window=${24 * 3600_000}&limit=2`), env)).json();
  assert.deepEqual(
    body.list.map((x) => x.pet).sort(),
    ['倍速鱼', '潮信'],
    `倍速鱼占了多个坑把潮信挤掉了：${JSON.stringify(body.list)}`,
  );
  assert.equal(body.list.find((x) => x.pet === '倍速鱼')?.doing, '第2026-11-23天', '按 uid 去重应保留最新那条 doing');
});
