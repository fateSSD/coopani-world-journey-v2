import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  slotOf, neighborLine, reportPresence, findNeighbors, MEET_MAX,
  sendInvite, listInvites, acceptInvite, inviteLine, agoText,
} = await import('../src/meet.ts');

test('时段四档：按钟点切，边界不能漏', () => {
  assert.equal(slotOf(0), 'night');
  assert.equal(slotOf(5), 'night');
  assert.equal(slotOf(6), 'morning');
  assert.equal(slotOf(11), 'morning');
  assert.equal(slotOf(12), 'afternoon');
  assert.equal(slotOf(17), 'afternoon');
  assert.equal(slotOf(18), 'evening');
  assert.equal(slotOf(21), 'evening');
  assert.equal(slotOf(22), 'night');
  assert.equal(slotOf(23), 'night');
});

test('把邻居揉成一句话：一/二/三个人都要读得通', () => {
  assert.equal(neighborLine([]), null, '没人就不该有这一句');

  const one = neighborLine([{ pet: '小满', doing: '吃面' }]);
  assert.match(one, /小满/, '名字丢了');
  assert.match(one, /吃面/, '在干嘛丢了');
  /*
   * 「一个」是并列用的量词，一个人身上读着像他有三个人。
   * 2026-11-04 端到端跑出来的原话是「大肥鱼也在这儿，一个在城墙上吹风。」
   */
  assert.doesNotMatch(one, /一个/, `一个人的时候不该说「一个」：${one}`);

  const two = neighborLine([{ pet: '小满', doing: '吃面' }, { pet: '阿七', doing: '逛夜市' }]);
  assert.match(two, /小满和阿七/, `两个人的名字没连起来：${two}`);
  assert.match(two, /吃面/, '第一个在干嘛丢了');
  assert.match(two, /逛夜市/, '第二个在干嘛丢了');

  const three = neighborLine([
    { pet: '小满', doing: '吃面' }, { pet: '阿七', doing: '逛夜市' }, { pet: '铁牛', doing: '坐着' },
  ]);
  assert.match(three, /小满、阿七和铁牛/, `三个人的顿号用法不对：${three}`);
  /*
   * 三个人时每个人都要说到。原来的实现只拼了 `who[0]` 和 `who[1]`，
   * 第三个人的事被静默丢掉 —— 而服务端一次正好回三个，
   * 三个人同城同时段是正常情况，不是边界。
   */
  for (const d of ['吃面', '逛夜市', '坐着']) {
    assert.ok(three.includes(d), `第三个人（或其中一个）的事被丢了：${three}`);
  }

  /*
   * 世界观那条线：不能说「用户」「服务器」「别人家」。
   * 她们只是碰巧在同一处，没有交流。
   */
  for (const line of [one, two, three]) {
    assert.doesNotMatch(line, /用户|服务器|玩家|网友|好友/, `这句话把世界观捅破了：${line}`);
    assert.doesNotMatch(line, /遇见|认识|聊/, `她们没有交流，不该用「遇见/认识」：${line}`);
  }
});

test('有人没写「在干嘛」时退回粗的说法，不硬凑', () => {
  // 一半有一半没有 —— 不能因为第一个人有就假装大家都有。
  const mixed = neighborLine([
    { pet: '小满', doing: '吃面' },
    { pet: '阿七', doing: '' },
  ]);
  assert.match(mixed, /也在这一带/, `混合情况该退回粗说法：${mixed}`);
  assert.doesNotMatch(mixed, /一个/, `不该硬凑并列：${mixed}`);
});

test('最多三个邻居 —— 加上她自己正好四个', () => {
  assert.equal(MEET_MAX, 4);
});

test('没配地址就一个请求都不发', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (...a) => { calls.push(a); throw new Error('不该被调到'); };
  try {
    const opt = { url: '', uid: 'u1', pet: '大肥鱼' };
    const r = await reportPresence(opt, 'xian', '2026-11-04', 'evening', '吃面');
    assert.equal(r.ok, false);
    assert.match(r.why, /没填碰面服务器地址/, '失败要说清是哪一层，不能只有一句「没回 200」');
    assert.deepEqual(await findNeighbors(opt, 'xian', 'evening'), { list: [], pool: 0, here: 0, ok: false });
    assert.equal(calls.length, 0, `没配地址还发了 ${calls.length} 个请求`);
  } finally { globalThis.fetch = orig; }
});

test('服务器挂了不抛错，当没碰见', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const opt = { url: 'https://example.test', uid: 'u1', pet: '大肥鱼' };
    const r = await reportPresence(opt, 'xian', '2026-11-04', 'evening', '吃面');
    assert.equal(r.ok, false);
    assert.match(r.why, /请求没发出去/, '断网要说成「请求没发出去」，和服务端回了 500 分清');
    assert.deepEqual(await findNeighbors(opt, 'xian', 'evening'), { list: [], pool: 0, here: 0, ok: false },
      '连不上就该给空列表，不能抛 —— ok: false 表示「不知道」，不是「没人」');
  } finally { globalThis.fetch = orig; }
});

test('拉回来的东西只留宠物名和在干嘛，多一个字都不要', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => ({
      list: [
        { pet: '小满', doing: '吃面', uid: '别人的id', ts: 123, money: 999 },
        { pet: '大肥鱼', doing: '发呆' },            // 自己，要剔掉
        { pet: '', doing: '空名' },                  // 空名，要剔掉
        { nope: 1 },                                 // 形状不对，要剔掉
        { pet: '阿七', doing: '逛夜市' },
        { pet: '铁牛', doing: '坐着' },
        { pet: '多余', doing: '第四个' },             // 超上限，要截掉
      ],
    }),
  });
  try {
    const board = await findNeighbors({ url: 'https://example.test', uid: 'u1', pet: '大肥鱼' },
      'xian', 'evening');
    const out = board.list;
    assert.equal(out.length, 3, `该截到三个，实际 ${out.length}`);
    assert.deepEqual(out[0], { pet: '小满', doing: '吃面' }, '别的字段漏进来了');
    assert.ok(!out.some((x) => x.pet === '大肥鱼'), '把自己也返回来了');
    assert.equal(board.pool, 0, '服务器没回 pool 时该是 0');
  } finally { globalThis.fetch = orig; }
});

test('地址两种填法都认：填根目录或填完整地址都行', async () => {
  /*
   * 2026-11-04 差点栽的坑：代码无条件拼 `/sight`，
   * 用户从控制台复制的是**完整地址**（带着 `/sight`），填进去就变成 `/sight/sight`。
   *
   * 人眼前只有一串东西，他复制哪个都合理 —— 所以两种都得认。
   */
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => { seen.push(String(url)); return { ok: true, json: async () => ({ list: [] }) }; };
  try {
    const root = 'https://x.app.tcloudbase.com';
    const full = 'https://x.app.tcloudbase.com/sight';

    await reportPresence({ url: root, uid: 'u1', pet: '大肥鱼' }, 'xian', '2026-11-04', 'evening', '吃面');
    await reportPresence({ url: full, uid: 'u1', pet: '大肥鱼' }, 'xian', '2026-11-04', 'evening', '吃面');
    await findNeighbors({ url: full, uid: 'u1', pet: '大肥鱼' }, 'xian', 'evening');

    assert.equal(seen[0], `${root}/sight`, `填根目录时拼错了：${seen[0]}`);
    assert.equal(seen[1], full, `填完整地址时重复拼了：${seen[1]}`);
    assert.ok(seen[2].startsWith(`${full}?`), `查询地址拼错了：${seen[2]}`);
    assert.ok(
      !seen[2].includes('date='),
      `邻居查询还带着 date：${seen[2]} —— 服务端已经不看了（各人游戏内日期对不上），`
      + '多传一个只会让下一个读代码的人以为它还在起作用',
    );
    assert.ok(!seen.some((u) => u.includes('/sight/sight')), `出现了 /sight/sight：${seen.join(' , ')}`);

    // 末尾多余的斜杠也要吃掉
    await reportPresence({ url: `${full}/`, uid: 'u1', pet: '大肥鱼' }, 'xian', '2026-11-04', 'evening', '吃面');
    assert.equal(seen[3], full, `末尾斜杠没处理：${seen[3]}`);
  } finally { globalThis.fetch = orig; }
});

/* ============================================================
 * 邀约（2026-11-05）
 *
 * 这一组测的不是「能不能发出去」，而是**发不出去的时候她能不能说清楚为什么**。
 * 2026-11-04 踩过的形态：旧版服务端只有 `/sight` 一个路由，填那个地址的人
 * 打到 `/sight/invite` 一律 404。如果客户端把它写成「操作失败」，
 * 用户唯一的结论是「这个功能坏了」，而实际只是他那台服务器没升级。
 * ============================================================ */

/** 20 位十六进制 —— 服务端的 uid 格式要求，不是随手编的。 */
const UID = 'a1b2c3d4e5f60718293a4b5c';
const OPT = { url: 'https://x.app.tcloudbase.com', uid: UID, pet: '大肥鱼' };

test('邀约：没配地址时一个请求都不发，而且说得出为什么', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (...a) => { calls.push(a); throw new Error('不该被调到'); };
  try {
    const none = { url: '', uid: UID, pet: '大肥鱼' };
    const send = await sendInvite(none, { from: 'xian', to: 'lhasa', days: 3, note: '想看雪山' });
    const list = await listInvites(none, 'xian');
    const take = await acceptInvite(none, '0123456789abcdef');
    for (const r of [send, list, take]) {
      assert.equal(r.ok, false);
      assert.match(r.reason, /碰面服务器/, `原因不像人话：${r.reason}`);
    }
    assert.equal(calls.length, 0, `没配地址还发了 ${calls.length} 个请求`);
  } finally { globalThis.fetch = orig; }
});

test('邀约：旧版服务端（404 + HTML）要说成「这台服务器还没这个功能」', async () => {
  /*
   * 这是这一组里最要紧的一条。云函数的路由只有 `/sight`，
   * `/sight/invite` 由网关直接 404，回来的是一段 HTML —— `res.json()` 会抛。
   * 抛了就当「没连上」，用户看到「没连上碰面服务器」，而他的网络一点问题都没有。
   */
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => { throw new SyntaxError('Unexpected token <'); },
  });
  try {
    const list = await listInvites(OPT, 'xian');
    assert.equal(list.ok, false);
    assert.match(list.reason, /还没有邀约功能/, `说成了别的原因：${list.reason}`);
    const take = await acceptInvite(OPT, '0123456789abcdef');
    assert.equal(take.ok, false);
    assert.match(take.reason, /还没有邀约功能/, `说成了别的原因：${take.reason}`);
  } finally { globalThis.fetch = orig; }
});

test('邀约：发一条 —— 地址拼对、字段对、天数夹在 1..30', async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ ok: true, id: 'abcdef0123456789' }) };
  };
  try {
    const r = await sendInvite(OPT, { from: 'xian', to: 'lhasa', days: 99, note: '想看雪山' });
    assert.equal(r.ok, true, '该发成功');
    assert.equal(r.id, 'abcdef0123456789');
    assert.equal(seen[0].url, `https://x.app.tcloudbase.com/sight/invite`,
      `地址拼错了：${seen[0].url}`);
    const body = JSON.parse(seen[0].init.body);
    assert.equal(body.days, 30, `天数没夹到上限：${body.days}`);
    assert.equal(body.from, 'xian');
    assert.equal(body.to, 'lhasa');
    assert.equal(body.uid, UID);
    assert.equal(body.pet, '大肥鱼');

    // 0 天 / 负数一律当 1，别让服务端去猜
    await sendInvite(OPT, { from: 'xian', to: 'lhasa', days: 0, note: '' });
    assert.equal(JSON.parse(seen[1].init.body).days, 1, '0 天没兜成 1');
  } finally { globalThis.fetch = orig; }
});

test('邀约：发太多（429）说「额度用完了」，不说「失败了」', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 429, json: async () => ({ ok: false, error: 'too many' }),
  });
  try {
    const r = await sendInvite(OPT, { from: 'xian', to: 'lhasa', days: 2, note: '' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /额度/, `说成了别的原因：${r.reason}`);
  } finally { globalThis.fetch = orig; }
});

test('邀约：列表只留约定的字段（含见面城、出发城），脏条目剔掉，最多六条', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      list: [
        { id: 'aaaaaaaaaaaaaaaa', pet: '小满', to: 'lhasa', days: 3, note: '想看雪山', uid: '别人的id', at: 1 },
        { id: 'bbbbbbbbbbbbbbbb', pet: '阿七', to: 'chengdu', days: '2' },   // days 是字符串
        { nope: 1 },                                                          // 形状不对
        { id: 'cccccccccccccccc', pet: '铁牛', to: 'xian', days: 1, note: '' },
        { id: 'dddddddddddddddd', pet: '多余', to: 'beijing', days: 1 },       // 第四个
        { id: 'eeeeeeeeeeeeeeee', pet: '五号', to: 'kunming', days: 2 },
        { id: 'ffffffffffffffff', pet: '六号', to: 'nanjing', days: 3 },
        { id: '1111111111111111', pet: '七号', to: 'suzhou', days: 1 },        // 第七个，该被截掉
      ],
    }),
  });
  try {
    const r = await listInvites(OPT, 'xian');
    assert.equal(r.ok, true);
    /* 2026-11-25 起窗口从三条放到六条：全服可见之后三条太窄。 */
    assert.equal(r.list.length, 6, `该截到六条，实际 ${r.list.length}`);
    /*
     * 2026-11-07 起多了 `meetCity` / `pace`，11-25 又多了 `mode`。
     * 服务端这行一个都没给 —— 所以这里断言的是「没给也要有默认值」：
     * 空串 = 就在目的地见（老口径）/ 没挑怎么去，0 = 对方没报流速。
     */
    assert.deepEqual(r.list[0],
      { id: 'aaaaaaaaaaaaaaaa', pet: '小满', to: 'lhasa', days: 3, note: '想看雪山', meetCity: '', pace: 0, mode: '', fromCity: '', near: false, postedAt: '' },
      '多带了字段，或者少了字段');
    assert.equal(r.list[1].days, 2, '字符串天数没转成数字');
  } finally { globalThis.fetch = orig; }
});

test('邀约：接下一条 —— 成功回「跟谁、去哪、几天」', async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, with: '小满', to: 'lhasa', days: 3, note: '想看雪山' }),
    };
  };
  try {
    const r = await acceptInvite(OPT, 'abcdef0123456789');
    assert.equal(r.ok, true);
    assert.equal(r.withPet, '小满');
    assert.equal(r.to, 'lhasa');
    assert.equal(r.days, 3);
    assert.equal(r.note, '想看雪山');
    assert.equal(seen[0].url, 'https://x.app.tcloudbase.com/sight/accept');
    // 2026-11-05：接的时候要带上自己的名字，服务端把它写进 taken_pet，
    // 发起者才知道「谁接了」（否则另一条鱼永远不知道有没有人应）。
    assert.deepEqual(JSON.parse(seen[0].init.body), { uid: UID, id: 'abcdef0123456789', pet: '大肥鱼' });
  } finally { globalThis.fetch = orig; }
});

test('邀约：接的三种失败要分得开 —— 被抢、自己发的、过期', async () => {
  const cases = [
    { status: 409, error: 'taken', want: /被别人接了/ },
    { status: 400, error: 'own invite', want: /自己发的/ },
    { status: 410, error: 'expired', want: /过期/ },
    { status: 404, error: 'gone', want: /不在服务器上/ },
  ];
  const orig = globalThis.fetch;
  try {
    for (const c of cases) {
      globalThis.fetch = async () => ({
        ok: false, status: c.status, json: async () => ({ ok: false, error: c.error }),
      });
      const r = await acceptInvite(OPT, 'abcdef0123456789');
      assert.equal(r.ok, false, `${c.error} 不该算成功`);
      assert.match(r.reason, c.want, `${c.error} 的原因说错了：${r.reason}`);
    }
  } finally { globalThis.fetch = orig; }
});

test('邀约：编号格式不对就在本地挡住，不发请求', async () => {
  let called = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { called += 1; throw new Error('不该被调到'); };
  try {
    for (const bad of ['', 'abc', 'ABCDEF0123456789'.toLowerCase().slice(0, 8), 'zzzzzzzzzzzzzzzz']) {
      const r = await acceptInvite(OPT, bad);
      assert.equal(r.ok, false, `「${bad}」不该过`);
      assert.match(r.reason, /编号/, `原因没说清编号不对：${r.reason}`);
    }
    assert.equal(called, 0, `编号不对还发了 ${called} 个请求`);
  } finally { globalThis.fetch = orig; }
});

test('邀约：服务器回的内容缺「跟谁、去哪」时不假装成功', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, days: 3 }) });
  try {
    const r = await acceptInvite(OPT, 'abcdef0123456789');
    assert.equal(r.ok, false, '缺字段却报了成功 —— 她会对着空气说「我答应了」');
    assert.match(r.reason, /跟谁|去哪/, `原因没说清缺什么：${r.reason}`);
  } finally { globalThis.fetch = orig; }
});

test('邀约：一句话里三件事都要在，而且不许写成命令', () => {
  assert.equal(inviteLine([]), null, '没人就不该有这一句');
  const one = inviteLine([{ pet: '小满', toName: '拉萨', days: 3, note: '想看雪山' }]);
  for (const must of ['小满', '拉萨', '3 天', '想看雪山']) {
    assert.ok(one.includes(must), `丢了一样东西（${must}）：${one}`);
  }
  /*
   * 事件是**事实**，不是命令。写成「快去接」就变成了给她的指令，
   * 而接不接本来就该她自己定。
   */
  assert.doesNotMatch(one, /快|必须|一定要/, `写成了命令：${one}`);
  assert.doesNotMatch(one, /用户|服务器/, `世界观被捅破了：${one}`);

  const two = inviteLine([
    { pet: '小满', toName: '拉萨', days: 3, note: '' },
    { pet: '阿七', toName: '成都', days: 2, note: '' },
  ]);
  for (const must of ['小满', '拉萨', '阿七', '成都', '2 天']) {
    assert.ok(two.includes(must), `两条时丢了（${must}）：${two}`);
  }
  assert.doesNotMatch(two, /（原话是「」）/, '空备注不该留一个空括号');
});

test('邀约：编号前后带别的东西也能认 —— 她从列表里整行抄过来是常事', async () => {
  /*
   * 她会把列表那一行连名带姓抄过来：「- 小满 想去拉萨，待 3 天　id=abcdef0123456789」。
   * 因为多几个字就拒掉，等于「我按你说的做了，你说不对」——
   * 那比放宽判定糟得多。
   */
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, with: '小满', to: 'lasa', days: 2, note: '' }) };
  };
  try {
    const messy = '- 小满 想去拉萨，待 3 天　id=ABCDEF0123456789';
    const r = await acceptInvite(OPT, messy);
    assert.equal(r.ok, true, `整行抄过来就接不了：${JSON.stringify(r)}`);
    assert.equal(seen[0].id, 'abcdef0123456789', '抠出来的编号不对（或者没转小写）');
  } finally { globalThis.fetch = orig; }
});

test('邀约：打到旧版服务端时，别把「服务器不认」说成「你填错了」', async () => {
  /*
   * 实测过的真实现象：腾讯云会把 `/sight/invite` 转给只实现了碰面的旧函数，
   * 它按「报我在哪」的规则验字段，于是回 400 `bad query` / `bad fields`。
   * 客户端自己先验过格式，所以这两种回执几乎只可能是「服务器没升级」。
   * 写成「字段不合规」，她会去改一个本来就对的参数。
   */
  const orig = globalThis.fetch;
  try {
    for (const [status, error] of [[400, 'bad query'], [400, 'bad fields']]) {
      globalThis.fetch = async () => ({
        ok: false, status, json: async () => ({ ok: false, error }),
      });
      const r = await listInvites(OPT, 'xian');
      assert.equal(r.ok, false);
      assert.match(r.reason, /旧版|没升级/, `没指向「服务器旧」这件事：${r.reason}`);
    }
  } finally { globalThis.fetch = orig; }
});

test('邀约：没有 id 的条目不进列表 —— 「看见了但接不上」比不显示更糟', async () => {
  /*
   * 老实现可能只回 `ok` 和名字。留着它，列表里就出现一行 `id=`，
   * 她照着念、照着传，永远接不上，而她自己不知道错在哪。
   */
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      ok: true,
      list: [
        { pet: '没有编号的', to: 'lasa', days: 2 },                    // 缺 id
        { id: '', pet: '空编号的', to: 'lasa', days: 2 },              // 空 id
        { id: 'not-a-hex-id', pet: '乱编号的', to: 'lasa', days: 2 },   // 不是 16 位十六进制
        { id: 'abcdef0123456789', pet: '正常的', to: 'lasa', days: 2 }, // 这条该留
      ],
    }),
  });
  try {
    const r = await listInvites(OPT, 'xian');
    assert.equal(r.ok, true);
    assert.equal(r.list.length, 1, `留下 ${r.list.length} 条，其中有不带编号的：${JSON.stringify(r.list)}`);
    assert.equal(r.list[0].pet, '正常的');
  } finally { globalThis.fetch = orig; }
});

test('邀约：那句话和名字里的换行要压平 —— 事件正文是一行', async () => {
  /*
   * 拉回来的东西会拼进 `journey.day` 那一句。一个换行就把那条正文劈成两段，
   * 读起来像两个人各说了一句；`\r\n` 还会在前端变成一行空白。
   * 服务端清过一道，这里是第二道 —— 旧版服务端不该让换行漏到她眼前。
   */
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      ok: true,
      list: [{
        id: 'abcdef0123456789',
        pet: '小\n满',
        to: 'lasa',
        days: 2,
        note: '第一行\r\n第二行\u0007第三行',
      }],
    }),
  });
  try {
    const r = await listInvites(OPT, 'xian');
    const one = r.list[0];
    assert.equal(one.pet, '小 满', `名字里的换行没压平：${JSON.stringify(one.pet)}`);
    assert.equal(one.note, '第一行 第二行 第三行', `备注没压平：${JSON.stringify(one.note)}`);
    assert.doesNotMatch(one.note, /[\r\n\u0007]/, '还有控制字符漏过去');
  } finally { globalThis.fetch = orig; }
});

test('邀约：发出去的那句话也压成一行', async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, id: 'abcdef0123456789' }) };
  };
  try {
    await sendInvite(OPT, { from: 'xian', to: 'lasa', days: 2, note: '想看雪山\n顺便吃面' });
    assert.equal(seen[0].note, '想看雪山 顺便吃面', `发出去的还带换行：${JSON.stringify(seen[0].note)}`);
  } finally { globalThis.fetch = orig; }
});

test('池子总数：服务器给了就带回来，没给就是 0', async () => {
  /*
   * 2026-11-05：面板要显示「这个池子今天一共多少只」。
   * 旧服务端不回这个字段、脏数据也可能是字符串 —— 一律按 0 处理，
   * 面板那边 0 就不显示这一行，不会冒出「今天一共 0 只」。
   */
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ list: [], pool: 37 }) });
    assert.equal((await findNeighbors({ url: 'https://example.test', uid: 'u1', pet: '大肥鱼' },
      'xian', 'evening')).pool, 37);

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ list: [] }) });
    assert.equal((await findNeighbors({ url: 'https://example.test', uid: 'u1', pet: '大肥鱼' },
      'xian', 'evening')).pool, 0, '旧服务端没这个字段');

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ list: [], pool: '37' }) });
    assert.equal((await findNeighbors({ url: 'https://example.test', uid: 'u1', pet: '大肥鱼' },
      'xian', 'evening')).pool, 0, '字符串不该被当成数字');

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ list: [], pool: -3 }) });
    assert.equal((await findNeighbors({ url: 'https://example.test', uid: 'u1', pet: '大肥鱼' },
      'xian', 'evening')).pool, 0, '负数不该透出去');
  } finally { globalThis.fetch = orig; }
});

/* ============ 再碰面认不认得出来（2026-11-11） ============ */

const { knownNeighborLine } = await import('../src/meet.ts');

test('熟人重逢：说得出走过几次、上次哪天、她写的印象', () => {
  const line = knownNeighborLine(
    [{ pet: '小满', doing: '在城墙上吹风' }],
    { 小满: { times: 2, warmth: 18, last: '2026-11-06', impression: '话不多，但半夜肯陪我找药店' } },
  );
  assert.match(line, /跟小满一起走过 2 次/);
  assert.match(line, /最近一次 11-06/, '年份在这个语境里没用，只要月日');
  assert.match(line, /话不多/, '印象是她自己写的，要原样带回去');
});

test('熟人重逢：不认识的人一个字都不说', () => {
  assert.equal(
    knownNeighborLine([{ pet: '陌生的鱼', doing: '在拍照' }], {}),
    null,
    '没记忆就是陌生人，别编「好像在哪儿见过」',
  );
});

test('熟人重逢：见过 0 次的不算熟人', () => {
  assert.equal(
    knownNeighborLine([{ pet: '小满', doing: '' }], { 小满: { times: 0, warmth: 0 } }),
    null,
    'times=0 是「记过但没一起走过」，不能当老朋友报',
  );
});

test('熟人重逢：同城好几个熟人时都说出来，但最多三个', () => {
  const list = ['a', 'b', 'c', 'd'].map((p) => ({ pet: p, doing: '' }));
  const known = Object.fromEntries(list.map((x) => [x.pet, { times: 1, last: '2026-11-01' }]));
  const line = knownNeighborLine(list, known);
  assert.match(line, /a/);
  assert.match(line, /c/);
  assert.doesNotMatch(line, /\bd\b/, '四个人一起报会把这条事实撑成一段话');
});

test('熟人重逢：印象和上次都没有时，只说次数', () => {
  const line = knownNeighborLine([{ pet: '小满', doing: '' }], { 小满: { times: 3 } });
  assert.match(line, /跟小满一起走过 3 次/);
  assert.doesNotMatch(line, /最近一次|印象/);
});

/* ============ 同行卡：网络层（2026-11-11） ============ */

const { putCard, fetchCards } = await import('../src/meet.ts');
const CARD_OPT = { url: 'https://sight.test', uid: 'a'.repeat(24), pet: '大肥鱼' };
const IID = 'ab12cd34ef56ab78';

test('同行卡：两个字段都空就不发请求 —— 别在别人那儿挂一张空白', async () => {
  const orig = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; return new Response('{}', { status: 200 }); };
  try {
    assert.equal(await putCard(CARD_OPT, IID, '', '   '), false);
    assert.equal(called, 0, '空卡应该在本地就挡掉，不该浪费一次请求');
  } finally { globalThis.fetch = orig; }
});

test('同行卡：编号不对不发请求', async () => {
  const orig = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; return new Response('{}', { status: 200 }); };
  try {
    assert.equal(await putCard(CARD_OPT, '不是编号', '一句话', ''), false);
    assert.equal(await putCard({ ...CARD_OPT, uid: '' }, IID, '一句话', ''), false, '没 uid 就没身份');
    assert.equal(called, 0);
  } finally { globalThis.fetch = orig; }
});

test('同行卡：留成功返回 true，请求体只带该带的', async () => {
  const orig = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (u, init) => {
    seen = { url: String(u), body: JSON.parse(init.body) };
    return new Response('{"ok":true}', { status: 200 });
  };
  try {
    assert.equal(await putCard(CARD_OPT, IID, '谢谢你半夜陪我找药店', '微信号 dali_2026'), true);
    assert.match(seen.url, /\/sight\/card$/);
    assert.equal(seen.body.id, IID);
    assert.equal(seen.body.note, '谢谢你半夜陪我找药店');
    assert.equal(seen.body.contact, '微信号 dali_2026');
    assert.equal('uid' in seen.body, true, '服务端要靠 uid 鉴权是不是这段同行的人');
  } finally { globalThis.fetch = orig; }
});

test('同行卡：服务器挂了返回 false，不抛', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    assert.equal(await putCard(CARD_OPT, IID, '一句话', ''), false);
    assert.deepEqual((await fetchCards(CARD_OPT, IID)).cards, [], '取不到就是空列表，不该让面板报错');
  } finally { globalThis.fetch = orig; }
});

test('同行卡：取回来只认四样，多给的字段一律丢掉', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    cards: [
      { pet: '小满', note: '大理那三天', contact: 'wx: xiaoman', at: '2026-11-10T12:00:00Z', uid: 'should-not-leak' },
      { pet: '', note: '没名字的丢掉', contact: '', at: '' },
      { pet: '空卡', note: '', contact: '', at: '2026-11-10T12:00:00Z' },
    ],
  }), { status: 200 });
  try {
    const got = await fetchCards(CARD_OPT, IID);
    assert.equal(got.cards.length, 1, '没名字的和全空的都不该留下');
    assert.deepEqual(Object.keys(got.cards[0]).sort(), ['at', 'contact', 'note', 'pet']);
    assert.equal(got.cards[0].pet, '小满');
    assert.equal(got.mine, null, '服务端没给 mine 就是还没留');
  } finally { globalThis.fetch = orig; }
});

/* ============ 名片：网络层（2026-11-11） ============ */

const { putProfile, fetchProfiles } = await import('../src/meet.ts');

test('名片：空串也能发 —— 那是撤回，不是错误', async () => {
  const orig = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (u, init) => { seen = JSON.parse(init.body); return new Response('{"ok":true}'); };
  try {
    assert.equal((await putProfile(CARD_OPT, '')).ok, true);
    assert.equal(seen.text, '', '撤回要真的发出去，不能在本地就拦掉');
  } finally { globalThis.fetch = orig; }
});

test('名片：超过 120 字被截断，不整段拒', async () => {
  const orig = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (u, init) => { seen = JSON.parse(init.body); return new Response('{"ok":true}'); };
  try {
    await putProfile(CARD_OPT, '字'.repeat(300));
    assert.equal(seen.text.length, 120);
  } finally { globalThis.fetch = orig; }
});

test('名片：存不上要说清是哪一种 —— 500 和超时不是一回事', async () => {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{"ok":false,"error":"server error"}', { status: 500 });
    const r = await putProfile(CARD_OPT, '你好');
    assert.equal(r.ok, false);
    /*
     * 2026-11-12 手书无愧报的「总说没连上」：原来四种失败压成同一句话，
     * 用户替我们查了一天。状态码必须带出来。
     */
    assert.match(String(r.reason), /500/, `500 被压成了「没连上」：${r.reason}`);

    globalThis.fetch = async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); };
    const t = await putProfile(CARD_OPT, '你好');
    assert.equal(t.ok, false);
    assert.match(String(t.reason), /没回话|超时/, `超时被说成了别的原因：${t.reason}`);
  } finally { globalThis.fetch = orig; }
});

test('名片：取回来只认 pet/text/at，空的整条丢掉', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    mine: { text: '我的' },
    others: [
      { pet: '小满', text: '花语乡 id: xiaoman', at: '2026-11-10T12:00:00Z', uid: 'leak' },
      { pet: '没写字的', text: '', at: 'x' },
    ],
  }));
  try {
    const got = await fetchProfiles(CARD_OPT);
    assert.equal(got.mine.text, '我的');
    assert.equal(got.others.length, 1, '没写字的整条不该出现');
    assert.deepEqual(Object.keys(got.others[0]).sort(), ['at', 'pet', 'text']);
  } finally { globalThis.fetch = orig; }
});

test('名片：服务器挂了就是空板，不抛', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('down'); };
  try {
    const got = await fetchProfiles(CARD_OPT);
    assert.equal(got.mine, null);
    assert.deepEqual(got.others, []);
  } finally { globalThis.fetch = orig; }
});

test('上报失败要说清是哪一层：服务端回了 500 和请求没发出去不是一件事', async () => {
  /*
   * 2026-11-23。这两天的日志里全是一句「碰面服务器没回 200」，而它底下压着
   * 两种完全不同的失败：服务器自己炸了（去查 Cloudflare 面板），和本机根本没连上
   * （查 DNS / 证书 / 网络）。用户拿着同一句话分不出来，我们也分不出来。
   */
  const orig = globalThis.fetch;
  const opt = { url: 'https://example.test', uid: 'u1', pet: '大肥鱼' };
  try {
    globalThis.fetch = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' });
    const r = await reportPresence(opt, 'xian', '2026-11-04', 'evening', '吃面');
    assert.equal(r.ok, false);
    assert.match(r.why, /503/, `服务端回了状态码就得写出来：${r.why}`);
    assert.match(r.why, /服务器回了/, '这是对面的事，措辞要指向「它回了」而不是「没连上」');

    // 成功时不该留下噪声
    globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK' });
    const ok = await reportPresence(opt, 'xian', '2026-11-04', 'evening', '吃面');
    assert.deepEqual(ok, { ok: true, why: '' });
  } finally { globalThis.fetch = orig; }
});

test('「多久之前发的」：四档边界与时钟差', () => {
  /*
   * 邀约只挂 24 小时，这一格直接影响「要不要现在动身」——
   * 所以边界要钉死，别让人看到「0 分钟前」或者「-1 天」。
   */
  const now = new Date('2026-11-25T10:00:00Z');
  const at = (iso) => agoText(iso, now);

  assert.equal(at(''), '', '没有时间就不写，不是写「刚刚」');
  assert.equal(at('不是时间'), '');
  assert.equal(at('2026-11-25T09:59:30Z'), '刚刚', '半分钟内算刚刚');
  assert.equal(at('2026-11-25T09:59:00Z'), '1 分钟前');
  assert.equal(at('2026-11-25T09:55:00Z'), '5 分钟前');
  assert.equal(at('2026-11-25T09:00:00Z'), '1 小时前');
  assert.equal(at('2026-11-25T07:00:00Z'), '3 小时前');
  assert.equal(at('2026-11-24T11:00:00Z'), '23 小时前', '23 小时还在「小时」档');
  assert.equal(at('2026-11-24T09:00:00Z'), '1 天前');
  /* 服务端比本机快几秒：说「刚刚」，不能说成负数。 */
  assert.equal(at('2026-11-25T10:02:00Z'), '刚刚', '时钟差不能写「-2 分钟前」');
  /* 时钟差很大也如实说 —— 不为了「看起来合理」掰回 24 小时内。 */
  assert.equal(at('2026-11-20T10:00:00Z'), '5 天前');
});
