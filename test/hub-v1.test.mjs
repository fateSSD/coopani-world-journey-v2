import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { ensureHubAuth, readHubAuth, writeHubAuthAtomic } = await import('../src/hub-client.ts');
const { StateStore, initialState } = await import('../src/state.ts');
const {
  acceptInvite,
  fetchCards,
  fetchFootprints,
  fetchProfiles,
  fetchStatus,
  findNeighbors,
  putCard,
  putProfile,
  reportFootprint,
  reportSignpost,
  sendInvite,
} = await import('../src/meet.ts');

function mkDir() {
  return mkdtempSync(join(tmpdir(), 'journey-hub-v1-'));
}

function makeSilentHost(pushed = []) {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => {
      pushed.push(e);
      return e;
    },
    store: {},
    drainPendingEvents: async () => [],
  };
}

function startMockHub(opts = {}) {
  const state = {
    registerCalls: [],
    presencePosts: [],
    presenceQueries: [],
    footprintPosts: [],
    signpostPosts: [],
    invitesSent: [],
    acceptHeaders: [],
    ackedInviteIds: [],
    ackPayloads: [],
    cardsPut: [],
    profilesPut: [],
    myProfileText: '慢慢走看日落',
    extProfilePuts: [],
    legacyPresenceCalls: [],
    mineList: [
      {
        id: '0123456789abcdef',
        pet: '小满',
        from: 'suzhou',
        to: 'chengdu',
        days: 3,
        note: '去宽窄巷子喝茶',
        meet: 'xian',
        pace: 1,
        mode: '火车',
        near: false,
        at: new Date().toISOString(),
      },
    ],
  };

  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      const path = u.pathname;
      const method = req.method || 'GET';
      const body = raw ? JSON.parse(raw) : {};
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (typeof opts.custom === 'function' && opts.custom({ method, path, body, state, send })) {
        return;
      }

      if (path === '/v1/core/pets/register' && method === 'POST') {
        state.registerCalls.push(body);
        if (opts.conflict409) {
          send(409, { ok: false, error: { code: 'LEGACY_UID_CLAIMED', message: '已被认领' } });
          return;
        }
        send(201, {
          ok: true,
          data: {
            petId: 'pet_journey_self',
            displayName: body.displayName || '大肥鱼',
            legacyUid: body.legacyUid ?? null,
            token: 'chub_mock_journey_token_01',
          },
        });
        return;
      }

      if (path === '/v1/core/pets/me/ext/journey' && method === 'PUT') {
        state.extProfilePuts.push(body);
        send(200, { ok: true, data: { updated: true } });
        return;
      }

      if (path === '/v1/journey/presence' && method === 'POST') {
        state.presencePosts.push(body);
        send(200, { ok: true, data: { cityId: body.cityId, slot: body.slot, updatedAt: new Date().toISOString() } });
        return;
      }

      if (path === '/v1/journey/presence' && method === 'GET') {
        state.presenceQueries.push({
          city: u.searchParams.get('city'),
          slot: u.searchParams.get('slot'),
          limit: u.searchParams.get('limit'),
        });
        send(200, {
          ok: true,
          data: {
            list: [
              { pet: '阿青', doing: '古城散步' },
              { pet: '老周', doing: '骑车看海' },
              { pet: '阿明', doing: '吃饵丝' },
              { pet: '小橘', doing: '晒太阳' },
            ],
            pool: 18,
            here: 5,
          },
        });
        return;
      }

      if (path === '/v1/journey/footprints' && method === 'POST') {
        state.footprintPosts.push(body.cityId);
        send(200, { ok: true, data: { recorded: true, cityId: body.cityId } });
        return;
      }

      if (path === '/v1/journey/footprints' && method === 'GET') {
        send(200, {
          ok: true,
          data: {
            places: [{ city: 'dali', first: '2026-11-20T00:00:00Z', last: '2026-11-27T00:00:00Z', visits: 2 }],
          },
        });
        return;
      }

      if (path === '/v1/journey/signposts' && method === 'POST') {
        state.signpostPosts.push(body);
        send(200, { ok: true, data: { saved: true, cityId: body.cityId } });
        return;
      }

      if (path === '/v1/journey/signposts' && method === 'GET') {
        send(200, { ok: true, data: { list: [{ pet: '阿青', text: '人民路夜宵摊挺暖和' }] } });
        return;
      }

      if (path === '/v1/journey/status' && method === 'GET') {
        send(200, {
          ok: true,
          data: {
            pool: 22,
            mineTaken: state.mineList.length,
            list: [
              {
                id: 'abcdef0123456789',
                pet: '阿青',
                from: 'dali',
                to: 'chengdu',
                days: 3,
                note: '去看滚滚',
                meet: '',
                pace: 1,
                mode: '火车',
                near: true,
                at: new Date().toISOString(),
              },
            ],
          },
        });
        return;
      }

      if (path === '/v1/journey/invites' && method === 'GET') {
        if (u.searchParams.get('mine') === '1') {
          send(200, { ok: true, data: { list: state.mineList } });
          return;
        }
        send(200, { ok: true, data: { list: [] } });
        return;
      }

      if (path === '/v1/journey/invites' && method === 'POST') {
        state.invitesSent.push(body);
        send(201, { ok: true, data: { id: 'fedcba9876543210', expiresAt: new Date(Date.now() + 86_400_000).toISOString() } });
        return;
      }

      if (path === '/v1/journey/invites/ack' && method === 'POST') {
        const ids = Array.isArray(body.inviteIds) ? body.inviteIds : [];
        const pairs = Array.isArray(body.pairs) ? body.pairs : [];
        state.ackPayloads.push({ inviteIds: ids, pairs });
        state.ackedInviteIds.push(...ids, ...pairs.map((p) => p.inviteId));
        state.mineList = state.mineList.filter((x) => {
          if (ids.includes(x.id)) return false;
          if (pairs.some((p) => p.inviteId === x.id && (!x.petId || p.memberPetId === x.petId))) return false;
          return true;
        });
        send(200, { ok: true, data: { ackedCount: ids.length + pairs.length } });
        return;
      }

      const accMatch = path.match(/^\/v1\/journey\/invites\/([^/]+)\/accept$/);
      if (accMatch && method === 'POST') {
        state.acceptHeaders.push(req.headers['idempotency-key'] || '');
        send(200, {
          ok: true,
          data: {
            with: '阿青',
            to: 'chengdu',
            days: 3,
            note: '去看滚滚',
            meet: '',
            pace: 1,
            mode: '火车',
            at: new Date().toISOString(),
          },
        });
        return;
      }

      if (path === '/v1/journey/cards' && method === 'POST') {
        state.cardsPut.push(body);
        send(200, { ok: true, data: { saved: true } });
        return;
      }

      if (path === '/v1/journey/cards' && method === 'GET') {
        send(200, {
          ok: true,
          data: {
            cards: [{ pet: '阿青', note: '一路顺风', contact: 'vx:aqing', at: new Date().toISOString() }],
            mine: { note: '我也留了言', contact: '' },
          },
        });
        return;
      }

      if (path === '/v1/journey/profile' && method === 'PUT') {
        state.profilesPut.push(body);
        state.myProfileText = String(body.text ?? '');
        send(200, { ok: true, data: { cleared: !body.text, saved: Boolean(body.text) } });
        return;
      }

      if (path === '/v1/journey/profile' && method === 'GET') {
        send(200, {
          ok: true,
          data: {
            mine: state.myProfileText ? { text: state.myProfileText } : null,
            others: [{ pet: '阿青', text: '爱逛菜市场', at: new Date().toISOString() }],
          },
        });
        return;
      }

      if (path.startsWith('/sight')) {
        state.legacyPresenceCalls.push({ method, path });
        send(200, { ok: true, list: [], pool: 3, here: 1 });
        return;
      }

      send(404, { ok: false, error: { code: 'NOT_FOUND', message: `Unhandled ${method} ${path}` } });
    });
  });

  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        state,
        close: () => new Promise((done) => srv.close(() => done())),
      });
    });
  });
}

test('Journey Hub v1 身份认领与复用 + 409 LEGACY_UID_CLAIMED 诚实报错透出至 uiSnapshot', async () => {
  const dir1 = mkDir();
  const dir2 = mkDir();
  const mock1 = await startMockHub();
  const mock409 = await startMockHub({ conflict409: true });
  try {
    const legacyUid = 'aabbccddeeff001122334455';
    writeFileSync(join(dir1, 'meet-uid.txt'), `${legacyUid}\n`, 'utf8');

    const w1 = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, hubUrl: mock1.url, homeCity: 'lanzhou' },
      dataDir: dir1,
      botName: '大肥鱼',
    });
    // 通过 signposts/reportHere 等触发异步鉴权
    await w1.start(makeSilentHost());
    await w1.signpost('中山桥夜风正好', 'lanzhou');
    assert.equal(mock1.state.registerCalls.length, 1);
    assert.equal(mock1.state.registerCalls[0].legacyUid, legacyUid);

    const auth = readHubAuth(dir1);
    assert.ok(auth);
    assert.equal(auth.petId, 'pet_journey_self');
    assert.equal(auth.token, 'chub_mock_journey_token_01');

    // 二次启动必须复用本地 coopanion-hub-auth.json，不重新 register
    const w1b = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, hubUrl: mock1.url, homeCity: 'lanzhou' },
      dataDir: dir1,
      botName: '大肥鱼',
    });
    await w1b.start(makeSilentHost());
    await w1b.signpost('早饭吃牛肉面', 'lanzhou');
    assert.equal(mock1.state.registerCalls.length, 1);
    await w1.stop();
    await w1b.stop();

    // 409 LEGACY_UID_CLAIMED 防裂号：不写入 coopanion-hub-auth.json 并在 uiSnapshot().social.authError 透出
    writeFileSync(join(dir2, 'meet-uid.txt'), `${legacyUid}\n`, 'utf8');
    const w2 = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, hubUrl: mock409.url, homeCity: 'lanzhou' },
      dataDir: dir2,
      botName: '大肥鱼',
    });
    await w2.start(makeSilentHost());
    const signRes = await w2.signpost('测试阻断', 'lanzhou');
    assert.match(signRes, /已被 Hub 认领|tokens\/reset/);
    assert.equal(existsSync(join(dir2, 'coopanion-hub-auth.json')), false);

    const snap = w2.uiSnapshot();
    assert.ok(snap.social);
    assert.equal(snap.social.hubMode, true);
    assert.equal(snap.social.online, false);
    assert.match(snap.social.authError || '', /已被 Hub 认领/);
    await w2.stop();
  } finally {
    await mock1.close();
    await mock409.close();
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('Journey Hub v1 全链路路由：presence(limit/slot=all)、footprints、signposts、invites/ack、cards、profiles 与 ext 切片', async () => {
  const dir = mkDir();
  const mock = await startMockHub();
  const pushed = [];
  try {
    const store = new StateStore(dir);
    const st = initialState('lanzhou');
    st.phase = 'staying';
    st.hereId = 'dali';
    st.arrivedAt = new Date().toISOString();
    store.save(st);

    const world = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, hubUrl: mock.url, homeCity: 'lanzhou', withUser: true },
      dataDir: dir,
      botName: '大肥鱼',
    });
    await world.start(makeSilentHost(pushed));
    // 等待非阻塞 syncHubJourneyProfile 微任务完成
    await new Promise((r) => setTimeout(r, 30));

    // start() 已触发 reportHere + ext profile 上报
    assert.ok(mock.state.presencePosts.some((p) => p.cityId === 'dali'));
    assert.ok(mock.state.extProfilePuts.some((e) => e.payload?.cityId === 'dali' && e.payload?.withUser === true));

    const meet = await world.meetOptionsAsync();
    assert.ok(meet && meet.mode === 'hub' && meet.token);

    // findNeighbors 透传 limit 与 slot=all
    const board = await findNeighbors(meet, 'dali', 'all', 4, 24 * 3_600_000);
    assert.equal(board.ok, true);
    assert.equal(board.list.length, 4);
    assert.equal(board.pool, 18);
    const lastQ = mock.state.presenceQueries.at(-1);
    assert.equal(lastQ?.slot, 'all');
    assert.equal(lastQ?.limit, '4');

    // 足迹 + 路标
    assert.equal(await reportFootprint(meet, 'dali'), true);
    const fp = await fetchFootprints(meet);
    assert.equal(fp[0].city, 'dali');
    assert.equal(await reportSignpost(meet, 'dali', '苍山脚下晴'), true);
    assert.equal(mock.state.signpostPosts[0].text, '苍山脚下晴');

    // status + 发约 + accept(Idempotency-Key) + claimTakenInvite 显式 ack
    const status = await fetchStatus(meet, 'dali');
    assert.equal(status.ok, true);
    assert.equal(status.pool, 22);
    const sent = await sendInvite(meet, { from: 'dali', to: 'chengdu', days: 3, note: '去看滚滚', mode: '火车' });
    assert.equal(sent.ok, true);
    assert.match(sent.id, /^[a-f0-9]{16}$/);

    const acc = await acceptInvite(meet, 'abcdef0123456789');
    assert.equal(acc.ok, true);
    assert.equal(acc.withPet, '阿青');
    assert.ok(mock.state.acceptHeaders[0].startsWith('accept-abcdef0123456789-'));

    await world.claimTakenInvite(meet, new Date());
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(mock.state.ackedInviteIds.includes('0123456789abcdef'));

    // 留言卡与名片
    assert.equal(await putCard(meet, '0123456789abcdef', '大理见', 'vx:dfy'), true);
    const cb = await fetchCards(meet, '0123456789abcdef');
    assert.equal(cb.cards.length, 1);
    assert.equal((await putProfile(meet, '喜欢逛早市')).ok, true);
    const pb = await fetchProfiles(meet);
    assert.equal(pb.mine?.text, '喜欢逛早市');
    assert.equal(pb.others.length, 1);

    await world.stop();
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Journey Hub v1 热清空 hubUrl 回退老服 meetUrl 与 webui 无头渲染 Hub 状态', async () => {
  const dir = mkDir();
  const mock = await startMockHub();
  const prevDoc = globalThis.document;
  try {
    const store = new StateStore(dir);
    const st = initialState('lanzhou');
    st.phase = 'staying';
    st.hereId = 'lanzhou';
    st.arrivedAt = new Date().toISOString();
    store.save(st);

    const cfg = { ...JOURNEY_DEFAULTS(), enabled: true, hubUrl: mock.url, meetUrl: mock.url, homeCity: 'lanzhou' };
    const world = new JourneyWorld({ cfg, dataDir: dir, botName: '大肥鱼' });
    await world.start(makeSilentHost());
    assert.equal(world.isHubMode(), true);

    const snapHub = world.uiSnapshot();
    assert.equal(snapHub.social?.hubMode, true);
    assert.equal(snapHub.social?.hubPetId, 'pet_journey_self');

    // 验证 dist/webui.js 可在无头 DOM 下正确渲染 Hub 模式总服芯片与推荐地址
    const uiMod = await import(`../dist/webui.js?hubtest=${Date.now()}`);
    class Node {
      constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.className = ''; this.textContent = ''; this.dataset = {}; this.handlers = {}; this.style = {}; this.hidden = false; }
      append(...ns) { for (const n of ns) if (n != null) this.children.push(typeof n === 'string' ? new Node('#text') : n); }
      appendChild(n) { this.append(n); return n; }
      replaceChildren(...ns) { this.children = []; this.append(...ns); }
      setAttribute(k, v) { this[k] = v; }
      addEventListener(t, f) { (this.handlers[t] ??= []).push(f); }
      get text() { return this.children.length === 0 ? this.textContent : this.children.map((c) => c.text ?? '').join(''); }
    }
    globalThis.document = {
      createElement: (t) => new Node(t),
      createTextNode: (s) => { const n = new Node('#text'); n.textContent = String(s); return n; },
    };

    const root = new Node('div');
    let handler;
    await uiMod.default.panels.now.mount({
      root,
      language: 'zh',
      invoke: async (m) => { if (m === 'snapshot') return snapHub; return {}; },
      on: (_ev, fn) => { handler = fn; },
      interval: () => 0,
      signal: new AbortController().signal,
    });
    if (handler) handler(snapHub);
    assert.match(root.text, /Hub v1 共享身份/);

    // 热清空 hubUrl 后回退老服 meetUrl
    cfg.hubUrl = '';
    await world.tick();
    assert.equal(world.isHubMode(), false);
    await world.reportHere();
    assert.ok(mock.state.legacyPresenceCalls.some((c) => c.path === '/sight'));

    await world.stop();
  } finally {
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureHubAuth 遇 409 LEGACY_UID_CLAIMED 自动重读兄弟扩展落盘凭据 + uiSnapshot 磁盘自愈', async () => {
  const dirRace = mkDir();
  const dirMiss = mkDir();
  const mock409 = await startMockHub({ conflict409: true });
  try {
    const legacyUid = '78797e520011223344556677';
    writeFileSync(join(dirRace, 'meet-uid.txt'), `${legacyUid}\n`, 'utf8');

    // 模拟兄弟扩展在短暂延迟后才将共享凭据写入磁盘
    setTimeout(() => {
      writeHubAuthAtomic(dirRace, {
        schema: 1,
        hubUrl: mock409.url,
        petId: 'pet_sister_life',
        token: 'chub_from_sister_life',
        legacyUid,
        displayName: '大肥鱼',
        updatedAt: new Date().toISOString(),
      });
    }, 60);

    const raced = await ensureHubAuth({
      hubUrl: mock409.url,
      dataDir: dirRace,
      displayName: '大肥鱼',
      conflictRetryDelaysMs: [0, 100, 200],
    });
    assert.equal(raced.ok, true);
    assert.equal(raced.created, false);
    assert.equal(raced.auth?.petId, 'pet_sister_life');
    assert.equal(raced.auth?.token, 'chub_from_sister_life');

    // 即使 Journey 内存中曾短暂残留 409 错误，一旦磁盘上出现合法凭据，uiSnapshot 应立即自愈
    const store = new StateStore(dirRace);
    store.save(initialState('lanzhou'));
    const w = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, hubUrl: mock409.url, homeCity: 'lanzhou' },
      dataDir: dirRace,
      botName: '大肥鱼',
    });
    w.hubAuth = null;
    w.hubAuthError = '老服 uid 已被认领';
    w.lastMeetOk = false;
    const healed = w.uiSnapshot();
    assert.equal(healed.social?.hubPetId, 'pet_sister_life');
    assert.equal(healed.social?.authError, undefined);

    // 磁盘始终没有凭据时仍诚实返回 409 阻断，绝不重建新号
    writeFileSync(join(dirMiss, 'meet-uid.txt'), `${legacyUid}\n`, 'utf8');
    const callsBefore = mock409.state.registerCalls.length;
    const missed = await ensureHubAuth({
      hubUrl: mock409.url,
      dataDir: dirMiss,
      displayName: '大肥鱼',
      conflictRetryDelaysMs: [0, 25],
    });
    assert.equal(missed.ok, false);
    assert.equal(missed.code, 'LEGACY_UID_CLAIMED');
    assert.equal(existsSync(join(dirMiss, 'coopanion-hub-auth.json')), false);
    assert.equal(mock409.state.registerCalls.length, callsBefore + 1);
  } finally {
    await mock409.close();
    rmSync(dirRace, { recursive: true, force: true });
    rmSync(dirMiss, { recursive: true, force: true });
  }
});

test('P0-5/P1 综合回归：并发单飞锁、409退避不刷register、多服凭据保留、mine=1超6条与parties冷启动', async () => {
  const dir1 = mkDir();
  const dir2 = mkDir();
  const mockOk = await startMockHub();
  const mock409 = await startMockHub({ conflict409: true });
  try {
    // 1) 并发 meetOptionsAsync 单飞锁：只触发 1 次 /register
    new StateStore(dir1).save(initialState('lanzhou'));
    const w1 = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, hubUrl: mockOk.url, homeCity: 'lanzhou' },
      dataDir: dir1,
      botName: '大肥鱼',
    });
    const settled = await Promise.all([
      w1.meetOptionsAsync(),
      w1.meetOptionsAsync(),
      w1.meetOptionsAsync(),
      w1.meetOptionsAsync(),
    ]);
    assert.equal(mockOk.state.registerCalls.length, 1, '并发鉴权必须合并成单飞请求');
    assert.equal(settled.filter(Boolean).length, 4);

    // 2) 多服凭据隔离：写第二个服务器后仍能找回 mockOk.url 的原凭据
    writeHubAuthAtomic(dir1, {
      schema: 1,
      hubUrl: 'https://second-hub.example.org',
      petId: 'pet_second',
      token: 'tok_second',
      legacyUid: null,
      displayName: '大肥鱼',
      updatedAt: new Date().toISOString(),
    });
    assert.equal(readHubAuth(dir1, mockOk.url)?.petId, 'pet_journey_self');
    assert.equal(readHubAuth(dir1, 'https://second-hub.example.org')?.petId, 'pet_second');

    // 2b) 多服 byHub 下 uiSnapshot 磁盘自愈精准命中 hubFix.base
    w1.hubAuth = null;
    w1.hubAuthError = 'temp err';
    const selfHealed = w1.uiSnapshot();
    assert.equal(selfHealed.social?.hubPetId, 'pet_journey_self');
    assert.equal(w1.hubAuthError, '');

    // 2c) hubAckTakenInvites 混合批次同时保留 inviteIds 与 pairs
    const { hubAckTakenInvites } = await import('../src/hub-client.ts');
    const mixedAckOk = await hubAckTakenInvites(
      mockOk.url,
      settled[0].token,
      ['aa11bb22cc33dd44'],
      [{ inviteId: '0123456789abcdef', memberPetId: 'pet_mate_0' }],
    );
    assert.equal(mixedAckOk, true);
    assert.deepEqual(mockOk.state.ackPayloads.at(-1), {
      inviteIds: ['aa11bb22cc33dd44'],
      pairs: [{ inviteId: '0123456789abcdef', memberPetId: 'pet_mate_0' }],
    });

    // 3) parties 面板冷启动直接调用：应走 meetOptionsAsync() 并返回 ready: true
    w1.hubAuth = null;
    w1.partyLog.add({ id: '0123456789abcdef', pets: ['阿青'], days: 3, at: new Date().toISOString(), city: '成都' });
    const partiesRes = await w1.panelInvoke('mates', 'parties', []);
    assert.equal(partiesRes.ready, true);
    assert.equal(partiesRes.parties.length, 1);

    // 4) mine=1 返回超过 6 条时不截断，且对已 seen 旧邀约自动补 ack
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `${String(i + 1).padStart(2, '0')}23456789abcdef`,
      petId: `pet_mate_${i}`,
      pet: `旅伴${i}`,
      from: 'suzhou',
      to: 'chengdu',
      days: 2,
      note: '同行',
      meet: '',
      pace: 1,
      mode: '火车',
      near: false,
      at: new Date().toISOString(),
    }));
    mockOk.state.mineList = many;
    const { hubMyTakenInvites } = await import('../src/hub-client.ts');
    const mineRes = await hubMyTakenInvites(mockOk.url, settled[0].token);
    assert.equal(mineRes.ok, true);
    assert.equal(mineRes.list.length, 8, 'mine=1 不应被硬截断到 6 条');

    // 第 1 条已在 seen 里，仍应补发 ack 将其清出 mineList
    w1.st = { ...w1.st, claimedInvites: [many[0].id] };
    await w1.claimTakenInvite(settled[0], new Date());
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(mockOk.state.ackedInviteIds.includes(many[0].id), '已 seen 邀约也应补 ack 清理');
    await w1.stop();

    // 5) 409 故障退避：多探针连续调用加两轮 tick，只打 1 次 /register（不会每分钟狂刷）
    writeFileSync(join(dir2, 'meet-uid.txt'), '78797e52aabbccdd11223344\n', 'utf8');
    new StateStore(dir2).save(initialState('lanzhou'));
    const wErr = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, hubUrl: mock409.url, homeCity: 'lanzhou' },
      dataDir: dir2,
      botName: '大肥鱼',
    });
    await wErr.start(makeSilentHost());
    const now = new Date();
    await Promise.all([
      wErr.syncHubJourneyProfile(),
      wErr.probeStatus(now),
      wErr.probeNearby(now),
      wErr.refreshMeetIfDown(now),
    ]);
    await wErr.probeStatus(now);
    await wErr.probeNearby(now);
    await wErr.refreshMeetIfDown(now);
    assert.equal(mock409.state.registerCalls.length, 1, '409 退避期间所有探针不得重复打 /register');
    await wErr.stop();

    // 6) ensureHubAuth 写盘失败返回 AUTH_WRITE_FAILED 而不抛未捕获异常
    const badDataFile = join(dir1, 'not-a-dir-file');
    writeFileSync(badDataFile, 'block-mkdir', 'utf8');
    const writeFailRes = await ensureHubAuth({
      hubUrl: mockOk.url,
      dataDir: badDataFile,
      displayName: '大肥鱼',
    });
    assert.equal(writeFailRes.ok, false);
    assert.equal(writeFailRes.code, 'AUTH_WRITE_FAILED');

    // 7) 非法 hubUrl 禁穿透至 meetUrl + uiSnapshot 保持 hubMode:true + 热切清理探测缓存
    const wBadHub = new JourneyWorld({
      cfg: {
        ...JOURNEY_DEFAULTS(),
        enabled: true,
        hubUrl: 'ftp://bad',
        meetUrl: 'http://127.0.0.1:9999',
        homeCity: 'lanzhou',
      },
      dataDir: dir1,
      botName: '大肥鱼',
    });
    await wBadHub.start(makeSilentHost());
    assert.equal(wBadHub.meetUsable(), false, '非法 hubUrl 不得穿透降级到 meetUrl');
    const badSnap = wBadHub.uiSnapshot();
    assert.equal(badSnap.social?.hubMode, true);
    assert.equal(badSnap.social?.online, false);
    assert.ok(Boolean(badSnap.social?.urlIssue), '非法 hubUrl 应在 uiSnapshot().social.urlIssue 透出原因');

    wBadHub.lastHubUrl = mockOk.url;
    wBadHub.poolProbe = { at: Date.now(), value: 5, taken: 0 };
    wBadHub.nearbyProbe = { at: Date.now(), here: 2, n: 1, cityId: 'lanzhou', day: '2026-11-27' };
    wBadHub.cfg.hubUrl = '';
    wBadHub.cfg.meetUrl = '';
    await wBadHub.tick();
    assert.equal(wBadHub.poolProbe, null, '热切 hubUrl 必须清理 poolProbe');
    assert.equal(wBadHub.nearbyProbe, null, '热切 hubUrl 必须清理 nearbyProbe');
    await wBadHub.stop();
  } finally {
    await mockOk.close();
    await mock409.close();
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('Journey P2 回归：冷启动跨扩展锁与运行期 401/403 亮「总服」红灯及换新令牌自愈', async () => {
  const dirLock = mkDir();
  const dirWorld = mkDir();
  let failStatus = 200;
  let failCode = '';
  let failMsg = '';
  const mockP2 = await startMockHub({
    custom: ({ method, path, send }) => {
      if (path === '/v1/journey/presence' && method === 'POST' && (failStatus === 401 || failStatus === 403)) {
        send(failStatus, { ok: false, error: { code: failCode, message: failMsg } });
        return true;
      }
      return false;
    },
  });

  try {
    // 1) 冷启动跨扩展文件锁：并发 ensureHubAuth 只触发 1 次 /register 且自动清理 .lock
    const [a1, a2] = await Promise.all([
      ensureHubAuth({ hubUrl: mockP2.url, dataDir: dirLock, displayName: '大肥鱼' }),
      ensureHubAuth({ hubUrl: mockP2.url, dataDir: dirLock, displayName: '大肥鱼' }),
    ]);
    assert.equal(a1.ok, true);
    assert.equal(a2.ok, true);
    assert.equal(mockP2.state.registerCalls.length, 1);
    assert.equal(existsSync(join(dirLock, 'coopanion-hub-auth.lock')), false, '认证结束后必须清理锁文件');

    // 2) 运行期 403 RENAME_REQUIRED / 403 ACCOUNT_BANNED / 401 INVALID_TOKEN 触发总服红灯与报错，且换新令牌后自愈
    new StateStore(dirWorld).save({ ...initialState('lanzhou'), phase: 'staying', hereId: 'chengdu' });
    const wP2 = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, hubUrl: mockP2.url, homeCity: 'lanzhou' },
      dataDir: dirWorld,
      botName: '大肥鱼',
    });
    await wP2.start(makeSilentHost());
    await wP2.meetOptionsAsync();
    assert.equal(wP2.worldLamps().find((l) => l.label === '总服')?.state, 'online');

    failStatus = 403;
    failCode = 'RENAME_REQUIRED';
    failMsg = '请先改名';
    await wP2.reportHere();
    assert.equal(wP2.worldLamps().find((l) => l.label === '总服')?.state, 'error');
    assert.match(wP2.uiSnapshot().social?.authError ?? '', /改名/);

    failStatus = 403;
    failCode = 'ACCOUNT_BANNED';
    failMsg = '违规封禁';
    await wP2.reportHere();
    assert.equal(wP2.worldLamps().find((l) => l.label === '总服')?.state, 'error');
    assert.match(wP2.uiSnapshot().social?.authError ?? '', /封禁/);

    failStatus = 401;
    failCode = 'INVALID_TOKEN';
    failMsg = 'token revoked';
    await wP2.reportHere();
    assert.equal(wP2.worldLamps().find((l) => l.label === '总服')?.state, 'error');
    // 旧盘还是同一个失效 token 时，uiSnapshot 不得误清报错
    assert.match(wP2.uiSnapshot().social?.authError ?? '', /INVALID_TOKEN/);

    // 写入管理端重置后的新 token，uiSnapshot 立即自愈且总服灯恢复绿灯
    failStatus = 200;
    writeHubAuthAtomic(dirWorld, {
      schema: 1,
      hubUrl: mockP2.url,
      petId: 'pet_journey_self',
      token: 'chub_healed_journey_tok',
      legacyUid: null,
      displayName: '大肥鱼',
      updatedAt: new Date().toISOString(),
    });
    const healedSnap = wP2.uiSnapshot();
    assert.equal(healedSnap.social?.authError ?? '', '');
    assert.equal(healedSnap.social?.hubPetId, 'pet_journey_self');
    assert.equal(wP2.worldLamps().find((l) => l.label === '总服')?.state, 'online');
    await wP2.stop();
  } finally {
    await mockP2.close();
    rmSync(dirLock, { recursive: true, force: true });
    rmSync(dirWorld, { recursive: true, force: true });
  }
});
