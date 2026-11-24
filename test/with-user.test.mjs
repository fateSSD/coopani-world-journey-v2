/**
 * 回归测试：开启「让你跟着一块走（withUser）」时的配置声明、前缀渲染、事件正文与运行中热切换。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS, journeyConfigGroups } = await import('../src/config.ts');
const { cityById } = await import('../src/geo/cities.ts');
const { buildCognitionPromptBrief } = await import('../src/photo-facts.ts');

function makeHost() {
  const events = [];
  return {
    events,
    host: {
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e) => {
        const env = { ...e, cursor: events.length + 1, blobs: [] };
        events.push(env);
        return env;
      },
      store: {},
      drainPendingEvents: async () => [],
      modelFacts: { accepts: () => true },
    },
  };
}

test('1. 配置项 worlds.journey.withUser 声明 x-hot: true 且不含 markdown 星号', () => {
  const groups = journeyConfigGroups();
  const life = groups.find((g) => g.id === 'journey.life');
  assert.ok(life, '应包含 journey.life 配置组');
  const prop = life.schema.properties['worlds.journey.withUser'];
  assert.ok(prop, '应包含 worlds.journey.withUser 配置项');
  assert.equal(prop['x-hot'], true, 'withUser 必须声明 x-hot: true 以便热切换立即生效');
  assert.doesNotMatch(prop.description ?? '', /\*/, '设置页描述不解析 markdown，禁用星号');
});

test('2. withUser=true 时 envPromptVars 强化我们表述，且 ENV_PROMPT 无病句嵌套', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-wu-env-'));
  try {
    const w = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', withUser: true },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => new Date('2026-11-24T04:00:00Z'),
    });
    const { host } = makeHost();
    await w.start(host);
    const vars = w.envPromptVars();
    assert.match(vars['journey.withUser'], /我们/);
    assert.match(vars['journey.withUser'], /一起/);

    const tpl = readFileSync(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8');
    const rendered = tpl.replace('{{journey.withUser}}', vars['journey.withUser']);
    assert.doesNotMatch(rendered, /即使\s*.*也只是叙事同行/, 'ENV_PROMPT 不得再用「即使 {{journey.withUser}} 也只是叙事同行」形成病句');
    assert.match(rendered, /即便开启「一块走」，也只是叙事上的结伴同行/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('3. nowSummary 在 home / traveling / staying 三阶段均根据 withUser 透出或隐藏同行状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-wu-now-'));
  try {
    const now = new Date('2026-11-24T06:00:00Z');
    const w = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', withUser: true },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => now,
    });
    const { host } = makeHost();
    await w.start(host);

    // home 阶段
    assert.match(w.nowSummary(), /同行状态：这一趟你和他一起走/);

    // traveling 阶段
    w.st = {
      ...w.st,
      phase: 'traveling',
      hereId: 'lanzhou',
      leg: {
        id: 'leg-1',
        fromId: 'lanzhou',
        toId: 'xian',
        modeId: 'train',
        km: 600,
        durationWorldHours: 5,
        departedAt: '2026-11-24T04:00:00Z',
        arriveAt: '2026-11-24T09:00:00Z',
        speed: 1,
        seat: '二等座',
        viaIds: [],
        createdAt: '2026-11-24T04:00:00Z',
      },
    };
    assert.match(w.nowSummary(), /同行状态：这一趟你和他一起走/);

    // staying 阶段
    w.st = { ...w.st, phase: 'staying', hereId: 'xian', leg: null, stayDateKey: '2026-11-24' };
    assert.match(w.nowSummary(), /同行状态：这一趟你和他一起走/);

    // 关闭时三阶段均不输出该行
    w.cfg.withUser = false;
    assert.doesNotMatch(w.nowSummary(), /同行状态：这一趟你和他一起走/);
    w.st = { ...w.st, phase: 'home' };
    assert.doesNotMatch(w.nowSummary(), /同行状态：这一趟你和他一起走/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('4. withUser=true 时 depart / arrive / day 三个主干事件都携带同行提示', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-wu-ev-'));
  try {
    let cur = new Date('2026-11-24T04:00:00Z');
    const w = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', withUser: true },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => cur,
    });
    const { host, events } = makeHost();
    await w.start(host);

    const xian = cityById('xian');
    await w.depart(cur, true, { to: xian });
    const departEv = events.find((e) => e.type === 'journey.depart');
    assert.ok(departEv, '应推送 journey.depart');
    assert.match(departEv.text, /一块/);
    assert.match(departEv.text, /我们/);

    const leg = w.st.leg;
    assert.ok(leg, '出发后应有在途 leg');
    cur = new Date(Date.parse(leg.arriveAt) + 60_000);
    await w.arrive(cur, leg);
    const arriveEv = events.find((e) => e.type === 'journey.arrive');
    assert.ok(arriveEv, '应推送 journey.arrive');
    assert.match(arriveEv.text, /一块/);
    assert.match(arriveEv.text, /我们/);

    cur = new Date(cur.getTime() + 24 * 3_600_000);
    await w.stayTick(cur);
    const dayEv = events.find((e) => e.type === 'journey.day');
    assert.ok(dayEv, '跨天后应推送 journey.day');
    assert.match(dayEv.text, /一块/);
    assert.match(dayEv.text, /我们/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('5. 运行中热切换 withUser 时，tick() 推送一次状态更新事件覆盖旧前缀且不重复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-wu-hot-'));
  try {
    let cur = new Date('2026-11-24T06:00:00Z');
    const w = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', withUser: false },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => cur,
    });
    const { host, events } = makeHost();
    await w.start(host);
    w.st = {
      ...w.st,
      phase: 'staying',
      hereId: 'xian',
      stayDateKey: '2026-11-24',
      decidedOn: '2026-11-24',
      lastBeatKey: '2026-11-24|activity|14',
    };
    w.plan = {
      cityId: 'xian',
      dateKey: '2026-11-24',
      sunriseHour: 7.2,
      sunsetHour: 17.5,
      weather: { dateKey: '2026-11-24', dayWeather: '晴', nightWeather: '晴', dayTemp: 10, nightTemp: 2, dayWind: '东', dayPower: '2' },
      lodging: { name: '长安客栈', tier: 'comfort', kind: '舒适酒店', price: 240, feel: '安静' },
      beats: [{ at: 14, kind: 'activity', what: '下午，大雁塔', spot: '大雁塔', until: 17 }],
    };

    await w.tick();
    assert.equal(events.filter((e) => e.senderKey?.startsWith('with-user-')).length, 0, '初次 tick 不应误报切换');

    // 打开同行开关 -> 推送一次开启更新
    w.cfg.withUser = true;
    cur = new Date(cur.getTime() + 1000);
    await w.tick();
    let updates = events.filter((e) => e.senderKey?.startsWith('with-user-'));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].type, 'journey.beat');
    assert.match(updates[0].text, /同行状态更新/);
    assert.match(updates[0].text, /我们/);
    assert.doesNotMatch(updates[0].text, /覆盖此前一个人走的状态/);

    // withUser=true 时，拍照同伴标签与 cognition 简报必须写成「他（叙事同行）」而非「你（叙事同行）」
    assert.equal(w.photoCompanionLabel('xian'), '他（叙事同行）');
    const facts = w.buildSceneFacts({
      city: cityById('xian'),
      hour: 14,
      dateKey: '2026-11-24',
      spot: '大雁塔',
      weather: null,
      onRoad: false,
      mode: '',
      view: 'ground',
      subject: 'ground',
      doing: '',
      castOn: false,
      personRefActive: false,
      libraryHint: '',
      style: '',
    });
    assert.match(facts.summaryLine, /同行的有他（叙事同行）/);
    assert.doesNotMatch(facts.summaryLine, /同行的有你/);
    const brief = buildCognitionPromptBrief(facts);
    assert.match(brief, /在场同伴：他（叙事同行）/);
    assert.doesNotMatch(brief, /在场同伴：你/);

    // 未改变时不再重复推
    cur = new Date(cur.getTime() + 1000);
    await w.tick();
    updates = events.filter((e) => e.senderKey?.startsWith('with-user-'));
    assert.equal(updates.length, 1, '状态未变不得重复推送');

    // 切回 false -> 推送一次关闭更新
    w.cfg.withUser = false;
    cur = new Date(cur.getTime() + 1000);
    await w.tick();
    updates = events.filter((e) => e.senderKey?.startsWith('with-user-'));
    assert.equal(updates.length, 2);
    assert.match(updates[1].text, /一个人继续走/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
