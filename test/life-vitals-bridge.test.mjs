import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { pickMode } = await import('../src/plan/journey.ts');
const { planDay } = await import('../src/plan/dayplan.ts');
const { rollLodging } = await import('../src/plan/lodging.ts');
const { cityById } = await import('../src/geo/cities.ts');
const { purseMethods } = await import('../src/world-purse.ts');
const { planMethods } = await import('../src/world-plan.ts');
const { socialMethods } = await import('../src/world-social.ts');
const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

test('低精力（effective < 25）时 pickMode 自动避开步行与自行车', () => {
  const from = cityById('suzhou');
  const to = cityById('shanghai');
  for (let i = 0; i < 40; i++) {
    const m = pickMode(from, to, 85, () => (i + 0.5) / 40, false, false, undefined, false, 18);
    assert.ok(m && m.id !== 'walk' && m.id !== 'bike', `不应选到 ${m?.id}`);
  }
});

test('高体质时 dayplan 跳过「脚有点酸」与「走不动」抱怨', () => {
  const city = cityById('chengdu');
  for (let dayIdx = 0; dayIdx < 10; dayIdx++) {
    const plan = planDay({
      city,
      dateKey: `2026-11-${String(10 + dayIdx).padStart(2, '0')}`,
      shape: 'full',
      dayIdx,
      lodging: rollLodging(() => 0.2),
      highFitness: true,
    });
    for (const b of plan.beats) {
      assert.ok(!/脚有点酸|走不动/.test(b.what), `高体质不应出现脚酸文案：${b.what}`);
    }
  }
});

test('低精力放宽景区代步门槛（余钱 200 时低精力放行、正常精力拦住）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journey-vitals-'));
  try {
    const now = Date.parse('2026-11-18T08:00:00Z');
    const makePurse = () => ({
      opts: { dataDir: dir },
      cfg: { moneyEnabled: true, budget: 0 },
      st: { spent: 0, earned: 0 },
      realNow: () => new Date(now),
      lifeAllowance: () => 200,
      purseLeft: purseMethods.purseLeft,
      readLifeVitals: purseMethods.readLifeVitals,
      effectiveLifeEnergy: purseMethods.effectiveLifeEnergy,
      spotSpendOk: purseMethods.spotSpendOk,
    });
    writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
      updatedAt: new Date(now - 60_000).toISOString(),
      vitals: { energy: 80, fitness: 30 },
    }));
    assert.equal(makePurse().spotSpendOk(), false);

    writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
      updatedAt: new Date(now - 60_000).toISOString(),
      vitals: { energy: 20, fitness: 20 },
    }));
    assert.equal(makePurse().spotSpendOk(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queueLifeEffect 可在请客模式（amount=0）写五维与心情条子到 life-spend', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journey-effect-'));
  try {
    writeFileSync(join(dir, 'life-state.json'), '{}');
    const now = Date.parse('2026-11-18T08:00:00Z');
    const ctx = {
      opts: { dataDir: dir },
      realNow: () => new Date(now),
      log: null,
      cleanupSpendTickets: () => {},
      queueLifeSpend: purseMethods.queueLifeSpend,
      queueLifeEffect: purseMethods.queueLifeEffect,
    };
    ctx.queueLifeEffect('大巴过夜', {
      vitalsDelta: { energy: -18 },
      moodlet: { text: '大巴硬坐了一宿，腰背发僵', kind: 'bad', hours: 5 },
    });
    const files = readdirSync(join(dir, 'life-spend')).filter((n) => n.endsWith('.json'));
    assert.equal(files.length, 1);
    const ticket = JSON.parse(readFileSync(join(dir, 'life-spend', files[0]), 'utf8'));
    assert.equal(ticket.amount, 0);
    assert.equal(ticket.vitalsDelta.energy, -18);
    assert.equal(ticket.moodlet.kind, 'bad');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readSpendTickets(dir) {
  const spendDir = join(dir, 'life-spend');
  if (!existsSync(spendDir)) return [];
  return readdirSync(spendDir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(spendDir, n), 'utf8')));
}

function makePlanStub(dir, city, beat, pledge = null) {
  const now = Date.parse('2026-11-20T08:00:00Z');
  return {
    opts: { dataDir: dir },
    cfg: { moneyEnabled: true, budget: 0 },
    st: { hereId: city.id, phase: 'staying', lastBeatKey: null, rest: null, pledge },
    plan: { lodging: { tier: 'view' }, weather: null, beats: [beat] },
    host: null,
    pendingBeats: new Map(),
    realNow: () => new Date(now),
    persist() {},
    push: async () => {},
    purseRich: () => false,
    maybePhoto: async () => {},
    cleanupSpendTickets() {},
    queueLifeSpend: purseMethods.queueLifeSpend,
    queueLifeEffect: purseMethods.queueLifeEffect,
    advanceBeats: planMethods.advanceBeats,
  };
}

test('advanceBeats 在独行普通/互动景点及有旅伴（pledge）时均按真实口径反哺社交', async () => {
  const city = cityById('jiayuguan');
  const nowDate = new Date('2026-11-20T08:00:00Z');

  // 1. 独行普通景点 -> fun +14, social +3
  {
    const dir = mkdtempSync(join(tmpdir(), 'jr-beat-solo-'));
    try {
      writeFileSync(join(dir, 'life-state.json'), '{}');
      const stub = makePlanStub(dir, city, { kind: 'activity', at: 10, what: '城墙上走了一圈，看风吹沙子' });
      await stub.advanceBeats(nowDate, city, 10.5, '2026-11-20');
      const tickets = readSpendTickets(dir);
      assert.equal(tickets.length, 1);
      assert.equal(tickets[0].vitalsDelta.fun, 14);
      assert.equal(tickets[0].vitalsDelta.social, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // 2. 独行互动/讲解景点 -> social +6
  {
    const dir = mkdtempSync(join(tmpdir(), 'jr-beat-talk-'));
    try {
      writeFileSync(join(dir, 'life-state.json'), '{}');
      const stub = makePlanStub(dir, city, { kind: 'activity', at: 15, what: '在悬壁长城门口请了个讲解，一路听下来' });
      await stub.advanceBeats(nowDate, city, 15.2, '2026-11-20');
      const tickets = readSpendTickets(dir);
      assert.equal(tickets.length, 1);
      assert.equal(tickets[0].vitalsDelta.social, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // 3. 已到站同城旅伴（st.pledge.arrivedAt 非空且同城）-> social +16（回归修掉不存在字段 st.mate）
  {
    const dir = mkdtempSync(join(tmpdir(), 'jr-beat-mate-'));
    try {
      writeFileSync(join(dir, 'life-state.json'), '{}');
      const pledge = { cityId: city.id, days: 3, withPet: '大肥鱼', inviteId: 'abcdef0123456789', acceptedAt: nowDate.toISOString(), arrivedAt: nowDate.toISOString() };
      const stub = makePlanStub(dir, city, { kind: 'activity', at: 15, what: '一起上城楼逛' }, pledge);
      await stub.advanceBeats(nowDate, city, 15.2, '2026-11-20');
      const tickets = readSpendTickets(dir);
      assert.equal(tickets.length, 1);
      assert.equal(tickets[0].vitalsDelta.social, 16);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // 4. 早饭与正餐在独行与有旅伴时分别反哺小额社交
  for (const [kind, hasMate, expected] of [
    ['breakfast', false, 2],
    ['breakfast', true, 5],
    ['lunch', false, 2],
    ['lunch', true, 8],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'jr-beat-meal-'));
    try {
      writeFileSync(join(dir, 'life-state.json'), '{}');
      const pledge = hasMate
        ? { cityId: city.id, days: 2, withPet: '小满', inviteId: 'abcdef0123456789', acceptedAt: nowDate.toISOString(), arrivedAt: nowDate.toISOString() }
        : null;
      const stub = makePlanStub(dir, city, { kind, at: 12, what: '吃一顿当地特色' }, pledge);
      await stub.advanceBeats(nowDate, city, 12.5, '2026-11-20');
      const tickets = readSpendTickets(dir);
      assert.equal(tickets.length, 1);
      assert.equal(tickets[0].vitalsDelta.social, expected, `${kind} hasMate=${hasMate}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('socialMethods（留路标/发邀约/接邀约/被接认领）在装有 life 时发社交反哺，未装时不建目录', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (u.includes('/signposts') && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (u.includes('/invite') && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ ok: true, id: '1234567890abcdef' }) };
    }
    if (u.includes('/invite') && u.includes('mine=1')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          list: [{ id: 'fedcba9876543210', pet: '小汐', to: 'chengdu', days: 3, note: '', pace: 1 }],
        }),
      };
    }
    if (u.includes('/invite') && method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          list: [{ id: 'abcdef0123456789', pet: '小满', to: 'chengdu', days: 2, note: '去成都', pace: 1 }],
        }),
      };
    }
    if (u.includes('/accept') && method === 'POST') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, with: '小满', to: 'chengdu', days: 2, note: '去成都', pace: 1 }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false }) };
  };

  const makeSocialStub = (dir) => {
    const nowDate = new Date('2026-11-20T08:00:00Z');
    const here = cityById('jiayuguan');
    const home = cityById('lanzhou');
    return {
      opts: { dataDir: dir, botName: '大肥鱼' },
      cfg: { meetUrl: 'https://x.test', askBeforeDepart: false },
      st: {
        phase: 'staying',
        hereId: here.id,
        returning: false,
        work: null,
        pledge: null,
        claimedInvites: [],
        pets: {},
      },
      log: { info() {}, warn() {} },
      partyLog: { add() {} },
      realNow: () => nowDate,
      worldNow: () => nowDate,
      meetOptions: () => ({ url: 'https://x.test', uid: '0123456789abcdef01234567', pet: '大肥鱼' }),
      cityOrNull: (id) => cityById(id) ?? null,
      cityName: (id) => cityById(id)?.name ?? id,
      resolveHome: () => ({ city: home }),
      speedNow: () => 1,
      isTight: () => false,
      noFly: () => false,
      affordMode: () => undefined,
      rememberPet() {},
      persist() {},
      push: async () => {},
      reopenTodayDecision: () => 'later',
      activePledge: socialMethods.activePledge,
      nameOf: socialMethods.nameOf,
      whoOfPledge: socialMethods.whoOfPledge,
      cleanupSpendTickets() {},
      queueLifeSpend: purseMethods.queueLifeSpend,
      queueLifeEffect: purseMethods.queueLifeEffect,
      signpost: socialMethods.signpost,
      inviteSomeone: socialMethods.inviteSomeone,
      takeInvite: socialMethods.takeInvite,
      claimTakenInvite: socialMethods.claimTakenInvite,
    };
  };

  try {
    // 1. 装有 life 时四条社交行为均写入对应 social 反哺条子
    const dir = mkdtempSync(join(tmpdir(), 'jr-soc-life-'));
    try {
      writeFileSync(join(dir, 'life-state.json'), '{}');
      const stub = makeSocialStub(dir);
      await stub.signpost('城墙北门风大，带件风衣', '嘉峪关');
      await stub.inviteSomeone('成都', 2, '一起吃串串');
      await stub.takeInvite('abcdef0123456789');
      stub.st.pledge = null;
      await stub.claimTakenInvite(stub.meetOptions(), new Date('2026-11-20T08:00:00Z'));

      const tickets = readSpendTickets(dir);
      const socials = tickets.map((t) => t.vitalsDelta?.social).sort((a, b) => a - b);
      assert.deepEqual(socials, [4, 5, 12, 12], `预期写出 [4,5,12,12]，实际：${JSON.stringify(socials)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // 2. 未装 life（无 life-state.json）时绝不创建 life-spend 目录
    const dirNoLife = mkdtempSync(join(tmpdir(), 'jr-soc-nolife-'));
    try {
      const stub = makeSocialStub(dirNoLife);
      await stub.signpost('顺路留句话', '嘉峪关');
      await stub.inviteSomeone('成都', 2, '走一趟');
      await stub.takeInvite('abcdef0123456789');
      stub.st.pledge = null;
      await stub.claimTakenInvite(stub.meetOptions(), new Date('2026-11-20T08:00:00Z'));

      assert.equal(existsSync(join(dirNoLife, 'life-spend')), false, '未装 life 时不应创建 life-spend 目录');
    } finally {
      rmSync(dirNoLife, { recursive: true, force: true });
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('arrive 抵达约定目的地与旅伴碰头时写入社交 +20、娱乐 +10 与正面 moodlet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-arrive-mate-'));
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  const nowISO = '2026-11-20T08:00:00Z';
  const nowDate = new Date(nowISO);
  const leg = {
    id: 'leg-mate-1',
    fromId: 'lanzhou',
    toId: 'chengdu',
    modeId: 'train',
    grade: 'second',
    km: 800,
    fare: 200,
    startedAt: '2026-11-19T12:00:00Z',
    arrivesAt: nowISO,
    durationHours: 20,
  };
  writeFileSync(join(dir, 'life-state.json'), '{}');
  new StateStore(dir).save({
    ...initialState('lanzhou'),
    phase: 'traveling',
    hereId: 'lanzhou',
    leg,
    pledge: {
      cityId: 'chengdu',
      days: 3,
      withPet: '小满',
      inviteId: 'abcdef0123456789',
      acceptedAt: '2026-11-19T10:00:00Z',
      arrivedAt: null,
    },
  });
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => nowDate,
  });
  try {
    await world.start({
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e) => ({ ...e, blobs: [] }),
      pushDeferred() {},
      store: {},
      drainPendingEvents: async () => [],
    });
    await world.arrive(nowDate, leg);
    const tickets = readSpendTickets(dir);
    const meetTicket = tickets.find((t) => t.note === '和旅伴碰头');
    assert.ok(meetTicket, `应产生「和旅伴碰头」条子，实际条子：${JSON.stringify(tickets)}`);
    assert.equal(meetTicket.amount, 0);
    assert.equal(meetTicket.vitalsDelta.social, 20);
    assert.equal(meetTicket.vitalsDelta.fun, 10);
    assert.equal(meetTicket.moodlet?.kind, 'good');
  } finally {
    await world.stop?.();
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
