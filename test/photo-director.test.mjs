/**
 * 方案 A + 方案 B（内核主导生图与硬事实底座）专项测试。
 *
 * 覆盖：
 * 1. `buildPhotoFacts`：太阳高度/昼夜边界、真实气温穿衣档、室内外、参考图与同伴约束；
 * 2. 方案 A（主会话 `journey_photo({ prompt })`）：跳过 3415 行规则模板，保留画风/参考图/去字护栏；
 * 3. 方案 A 事件搭便车：`imageDirector='auto'` 且无 `cognition` 时，到景点与长途中段将可留影实况挂进事件，不背着模型瞎出图；拍完或切换 `'template'` 时自动收敛；
 * 4. 方案 B（`WorldHost.cognition`）：宿主支持 cognition 时自动在后台调内核写生图词，报错/超时/拒答时优雅降级回 `photoPrompt()`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { cityById } = await import('../src/geo/cities.ts');
const {
  buildPhotoFacts,
  compileDirectorPrompt,
  buildCognitionPromptBrief,
  sanitizeDirectorText,
} = await import('../src/photo-facts.ts');

async function fakeImageApi() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(JSON.parse(body || '{}'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    api: `http://127.0.0.1:${server.address().port}/v1`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

function fakeHost(cognition) {
  const events = [];
  const deferred = [];
  const warns = [];
  return {
    events,
    deferred,
    warns,
    host: {
      log: {
        trace() {},
        debug() {},
        info() {},
        warn: (m) => warns.push(String(m)),
        error: (m) => warns.push(String(m)),
      },
      pushEvent: async (e) => {
        const env = { ...e, cursor: events.length + 1, blobs: (e.blobs ?? []).map((b, i) => ({ handle: `log:d-${events.length}-${i}.png`, mime: b.mime, name: b.name })) };
        events.push(env);
        return env;
      },
      pushDeferred: (spec, opts) => {
        deferred.push({ spec, opts });
      },
      store: {},
      drainPendingEvents: async () => [],
      modelFacts: { accepts: () => true },
      ...(cognition ? { cognition } : {}),
    },
  };
}

test('buildPhotoFacts：天津 11 月 14:31 6℃ 瓷房子判为白昼并拆净生图护栏；日落后 17.6 点天气与夜温同源切换', () => {
  const tianjin = cityById('tianjin');
  const f1 = buildPhotoFacts({
    city: tianjin,
    hour: 14.52,
    month: 11,
    day: 24,
    spot: '瓷房子',
    weather: { dateKey: '2026-11-24', dayWeather: '晴', nightWeather: '晴', dayTemp: 6, nightTemp: -2, dayWind: '北', dayPower: '3' },
    castOn: true,
    personRefActive: true,
    lang: 'zh',
  });
  assert.equal(f1.sun.daylit, true);
  assert.equal(f1.nightShot, false);
  assert.equal(f1.indoor, false);
  assert.match(f1.daylightGuard, /大白天.*非黄昏、非夜景/);
  assert.doesNotMatch(f1.daylightGuard, /大白天.*大白天/);
  assert.match(f1.clothingHint, /偏冷 6℃.*厚外套|勿穿短袖/);
  assert.match(f1.summaryLine, /瓷房子（室外）/);
  assert.match(f1.summaryLine, /大白天阳光充足/);
  assert.match(f1.summaryLine, /带参考图出镜/);
  assert.doesNotMatch(f1.summaryLine, /｜|prompt语言:|勿出现大主角|非黄昏|大白天.*大白天/);
  assert.doesNotMatch(f1.nowTag, /｜|写prompt用|大白天.*大白天/);

  // 底层生图简报仍保留完整防黄昏、不亮路灯与参考图护栏
  const brief = buildCognitionPromptBrief(f1);
  assert.match(brief, /大白天/);
  assert.match(brief, /非黄昏、非夜景，不亮路灯/);

  // 冬天 11 月 24 日 17:36（17.6 < 19 点但已过日落）天气和温度须同步切到夜间档
  const fSunset = buildPhotoFacts({
    city: tianjin,
    hour: 17.6,
    month: 11,
    day: 24,
    spot: '五大道',
    weather: { dateKey: '2026-11-24', dayWeather: '晴', nightWeather: '多云', dayTemp: 8, nightTemp: -1, dayWind: '北', dayPower: '3' },
    castOn: false,
    lang: 'zh',
  });
  assert.equal(fSunset.sun.daylit, false);
  assert.equal(fSunset.weatherText, '多云');
  assert.equal(fSunset.tempC, -1);

  const dunhuang = cityById('dunhuang');
  const fIndoor = buildPhotoFacts({
    city: dunhuang,
    hour: 15,
    month: 11,
    day: 24,
    spot: '敦煌博物馆',
    castOn: false,
    lang: 'en',
  });
  assert.equal(fIndoor.indoor, true);
  assert.match(fIndoor.summaryLine, /室内/);
});

test('方案 A（journey_photo prompt）：直接按自写完整画面词生图，跳过规则模板并补齐参考图与去字底线', async () => {
  const api = await fakeImageApi();
  const dir = mkdtempSync(join(tmpdir(), 'jr-dir-a-'));
  try {
    const w = new JourneyWorld({
      cfg: {
        ...JOURNEY_DEFAULTS(),
        enabled: true,
        homeCity: '兰州',
        imageApi: api.api,
        imageKey: 'sk-test',
        imageModel: 'gpt-image-1',
        imageStyle: '电影感',
        imagePromptLang: 'zh',
      },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => new Date('2026-11-24T06:31:00Z'), // 北京/天津 14:31
    });
    const { host, events } = fakeHost();
    await w.start(host);
    w.st = { ...w.st, phase: 'staying', hereId: 'tianjin', stayStartedAt: '2026-11-24T00:00:00Z' };
    w.plan = {
      cityId: 'tianjin',
      dateKey: '2026-11-24',
      sunriseHour: 7.0,
      sunsetHour: 16.9,
      weather: { dateKey: '2026-11-24', dayWeather: '晴', nightWeather: '晴', dayTemp: 6, nightTemp: -1, dayWind: '北', dayPower: '3' },
      lodging: { name: '天津小筑', tier: 'budget', kind: '快捷连锁', price: 220, feel: '暖气挺足' },
      beats: [{ at: 14, kind: 'activity', what: '下午，瓷房子', spot: '瓷房子', until: 17 }],
    };

    // nowSummary 应带上白天温度与紧凑留影参考，不含叠词/黑话且末尾仍保持 NOW_TAIL
    const summary = w.nowSummary();
    assert.match(summary, /白天 6℃/);
    assert.match(summary, /此刻留影参考：天津·瓷房子（室外）/);
    assert.doesNotMatch(summary, /大白天.*大白天|写prompt用/);
    assert.match(summary.trim().split('\n').at(-1), /不用一条条报/);

    const photoTool = w.tools().find((t) => t.name === 'journey_photo');
    const authored = '站在天津瓷房子洋楼前阳光下，穿着米色厚毛呢大衣围着格纹围巾，浅浅笑着回头看镜头，大白天日光清晰照亮青花瓷碎片墙面。';
    const res = await photoTool.handler({ prompt: authored });
    assert.match(res.text, /拍好了/);
    assert.equal(api.seen.length, 1);
    const sentPrompt = api.seen[0].prompt;
    assert.match(sentPrompt, /^电影感：站在天津瓷房子洋楼前阳光下/);
    assert.match(sentPrompt, /没有可读文字，没有水印/);
    // 绝不混入旧模板拼接词（如 胶片颗粒 / 轻微过曝 / 远处散着几个很小的行人）
    assert.doesNotMatch(sentPrompt, /胶片颗粒|轻微过曝|很小的行人/);
    assert.equal(events.filter((e) => e.type === 'journey.photo').length, 1);
    const book = JSON.parse(readFileSync(join(dir, 'photos.json'), 'utf8'));
    assert.equal(book.items[0].prompt, sentPrompt);
  } finally {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('方案 A 事件搭便车：imageDirector=auto 且无 cognition 时，到景点与途中把留影实况挂进事件而不背着模型瞎出图；拍完后再次渲染自动消去', async () => {
  const api = await fakeImageApi();
  const dir = mkdtempSync(join(tmpdir(), 'jr-dir-offer-'));
  try {
    const clock = new Date('2026-11-24T06:31:00Z'); // 天津 14:31
    const w = new JourneyWorld({
      cfg: {
        ...JOURNEY_DEFAULTS(),
        enabled: true,
        homeCity: '兰州',
        imageApi: api.api,
        imageKey: 'sk-test',
        imageModel: 'gpt-image-1',
        imagePromptLang: 'zh',
        imageDirector: 'auto',
      },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => clock,
    });
    const { host, deferred, events } = fakeHost(); // 无 cognition
    await w.start(host);
    const tianjin = cityById('tianjin');
    w.st = { ...w.st, phase: 'staying', hereId: 'tianjin', lastBeatKey: '' };
    w.plan = {
      cityId: 'tianjin',
      dateKey: '2026-11-24',
      sunriseHour: 7.0,
      sunsetHour: 16.9,
      weather: { dateKey: '2026-11-24', dayWeather: '晴', nightWeather: '晴', dayTemp: 6, nightTemp: -1, dayWind: '北', dayPower: '3' },
      lodging: { name: '天津小筑', tier: 'budget', kind: '快捷连锁', price: 220, feel: '安静' },
      beats: [{ at: 14, kind: 'activity', what: '下午，瓷房子', spot: '瓷房子', until: 17 }],
    };

    await w.advanceBeats(clock, tianjin, 14.52, '2026-11-24');
    // 1. 不应背着主模型私自调生图接口
    assert.equal(api.seen.length, 0, 'imageDirector=auto 且无 cognition 时不应背着模型自动出图');
    assert.equal(events.filter((e) => e.type === 'journey.photo').length, 0);

    // 2. deferred journey.beat 渲染正文里应附带纯观察留影实况（无祈使句、管道符或工程参数词）
    const beatDef = deferred.find((d) => d.spec.type === 'journey.beat');
    assert.ok(beatDef, '应入队 journey.beat');
    const renderedBefore = beatDef.spec.render()?.text ?? '';
    assert.match(renderedBefore, /此刻留影实况：天津·瓷房子（室外）/);
    assert.doesNotMatch(renderedBefore, /｜|prompt语言:|大白天.*大白天|调 journey_photo|不用拍就略过/);

    // 3. 主模型调 journey_photo 拍完当天这张后，若 deferred 此时才渲染，不再重复附留影实况
    const photoTool = w.tools().find((t) => t.name === 'journey_photo');
    await photoTool.handler({ prompt: '天津瓷房子阳光斜照，大白天外景。' });
    assert.equal(api.seen.length, 1);
    const renderedAfter = beatDef.spec.render()?.text ?? '';
    assert.doesNotMatch(renderedAfter, /此刻留影实况|天津·瓷房子（室外）|调 journey_photo/, '当天拍完之后 deferredRender 不应再附留影实况');
  } finally {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('默认配置回归：imageDirector 默认应为 template，无 cognition 时到景点自动后台出图不漏拍', async () => {
  assert.equal(JOURNEY_DEFAULTS().imageDirector, 'template');
  const api = await fakeImageApi();
  const dir = mkdtempSync(join(tmpdir(), 'jr-dir-def-'));
  try {
    const clock = new Date('2026-11-24T06:31:00Z');
    const w = new JourneyWorld({
      cfg: {
        ...JOURNEY_DEFAULTS(),
        enabled: true,
        homeCity: '兰州',
        imageApi: api.api,
        imageKey: 'sk-test',
        imageModel: 'gpt-image-1',
        imagePromptLang: 'zh',
      },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => clock,
    });
    const { host, deferred } = fakeHost();
    await w.start(host);
    const tianjin = cityById('tianjin');
    w.st = { ...w.st, phase: 'staying', hereId: 'tianjin', lastBeatKey: '' };
    w.plan = {
      cityId: 'tianjin',
      dateKey: '2026-11-24',
      sunriseHour: 7.0,
      sunsetHour: 16.9,
      weather: { dateKey: '2026-11-24', dayWeather: '晴', nightWeather: '晴', dayTemp: 6, nightTemp: -1, dayWind: '北', dayPower: '3' },
      lodging: { name: '天津小筑', tier: 'budget', kind: '快捷连锁', price: 220, feel: '安静' },
      beats: [{ at: 14, kind: 'activity', what: '下午，瓷房子', spot: '瓷房子', until: 17 }],
    };

    await w.advanceBeats(clock, tianjin, 14.52, '2026-11-24');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(api.seen.length, 1, '默认 template 模式下到景点必须自动在后台调生图接口');
    const beatDef = deferred.find((d) => d.spec.type === 'journey.beat');
    assert.ok(beatDef);
    const rendered = beatDef.spec.render()?.text ?? '';
    assert.doesNotMatch(rendered, /此刻留影实况|调 journey_photo/, '默认 template 后台直出不应再把留影实况塞进事件正文');
  } finally {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('方案 B（WorldHost.cognition）：宿主开放 cognition 时自动在后台编导生图词；失败/超时/空答优雅退回规则模板', async () => {
  const api = await fakeImageApi();
  const dir = mkdtempSync(join(tmpdir(), 'jr-dir-b-'));
  try {
    const requests = [];
    const clock = new Date('2026-11-24T06:31:00Z');
    const cog = {
      request: async (req) => {
        requests.push(req);
        return { text: '```text\n大白天阳光斜照在天津瓷房子青花瓷外立面上，天空晴朗无灯，真实街拍\n```' };
      },
    };
    const w = new JourneyWorld({
      cfg: {
        ...JOURNEY_DEFAULTS(),
        enabled: true,
        homeCity: '兰州',
        imageApi: api.api,
        imageKey: 'sk-test',
        imageModel: 'gpt-image-1',
        imagePromptLang: 'zh',
        imageDirector: 'auto',
      },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => clock,
    });
    const { host } = fakeHost(cog);
    await w.start(host);
    const tianjin = cityById('tianjin');
    w.st = { ...w.st, phase: 'staying', hereId: 'tianjin', lastBeatKey: '' };
    w.plan = {
      cityId: 'tianjin',
      dateKey: '2026-11-24',
      sunriseHour: 7.0,
      sunsetHour: 16.9,
      weather: { dateKey: '2026-11-24', dayWeather: '晴', nightWeather: '晴', dayTemp: 6, nightTemp: -1, dayWind: '北', dayPower: '3' },
      lodging: { name: '天津小筑', tier: 'budget', kind: '快捷连锁', price: 220, feel: '安静' },
      beats: [{ at: 14, kind: 'activity', what: '下午，瓷房子', spot: '瓷房子', until: 17 }],
    };

    // 1. 宿主存在 cognition 时，maybePhoto 不再依赖硬编码正文，直接由 cognition 编导
    const r = await w.maybePhoto(tianjin, 14.52, '2026-11-24', '瓷房子', w.plan.weather, true);
    assert.equal(r.ok, true);
    assert.equal(requests.length, 1);
    assert.match(requests[0].brief, /大白天.*非黄昏、非夜景/);
    assert.equal(requests[0].hint?.rounds, 1);
    assert.match(api.seen[0].prompt, /大白天阳光斜照在天津瓷房子青花瓷外立面上/);
    assert.doesNotMatch(api.seen[0].prompt, /```|提示词：/);

    // 2. cognition 返回错误/拒答时，无缝退回 photoPrompt 兜底而不炸流程
    const failCog = {
      request: async () => ({ error: 'model overloaded' }),
    };
    w.host = fakeHost(failCog).host;
    const r2 = await w.maybePhoto(tianjin, 14.52, '2026-11-24', '瓷房子', w.plan.weather, true);
    assert.equal(r2.ok, true);
    assert.match(api.seen[1].prompt, /瓷房子/);
    assert.match(api.seen[1].prompt, /白天充足日光/);

    const refuseCog = {
      request: async () => ({ text: '抱歉，我无法生成这个内容' }),
    };
    w.host = fakeHost(refuseCog).host;
    assert.equal(sanitizeDirectorText('抱歉，我无法生成这个内容'), '');
    const r3 = await w.maybePhoto(tianjin, 14.52, '2026-11-24', '瓷房子', w.plan.weather, true);
    assert.equal(r3.ok, true);
    assert.match(api.seen[2].prompt, /瓷房子/);

    // 3. compileDirectorPrompt 保留英文与 none 风格、参考图防冲突守卫
    const enFacts = buildPhotoFacts({
      city: tianjin,
      hour: 14.52,
      month: 11,
      day: 24,
      spot: '瓷房子',
      castOn: true,
      personRefActive: true,
      style: 'none',
      lang: 'en',
    });
    const compiledEn = compileDirectorPrompt('A girl wearing a wool coat standing in front of Porcelain House in bright daylight', enFacts);
    assert.doesNotMatch(compiledEn, /^none/i);
    assert.match(compiledEn, /reference image/i);
    assert.match(compiledEn, /no readable text/i);
    assert.ok(buildCognitionPromptBrief(enFacts).includes('Output ONLY the prompt itself'));
  } finally {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('途中中段与模式切换：imageDirector=auto 递出窗外实况、imageDirector=template 静默直接生图、AbortController 及时截断', async () => {
  const api = await fakeImageApi();
  const dir = mkdtempSync(join(tmpdir(), 'jr-dir-road-'));
  try {
    // 中段出发 4 小时 / 8 小时
    const clock = new Date('2026-11-24T06:00:00Z'); // 北京 14:00
    const w = new JourneyWorld({
      cfg: {
        ...JOURNEY_DEFAULTS(),
        enabled: true,
        homeCity: '兰州',
        imageApi: api.api,
        imageKey: 'sk-test',
        imageModel: 'gpt-image-1',
        imagePromptLang: 'zh',
        imageDirector: 'auto',
      },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => clock,
    });
    const { host, deferred } = fakeHost();
    await w.start(host);
    w.st = {
      ...w.st,
      phase: 'traveling',
      hereId: 'lanzhou',
      leg: {
        id: 'leg-road-1',
        fromId: 'lanzhou',
        toId: 'chengdu',
        modeId: 'train',
        km: 980,
        durationWorldHours: 8,
        departedAt: '2026-11-24T02:00:00Z',
        arriveAt: '2026-11-24T10:00:00Z',
        speed: 1,
        seat: '二等座',
        viaIds: [],
        createdAt: '2026-11-24T02:00:00Z',
      },
      roadBeatsDone: [0],
    };

    // 触发 idx === 1 中段节点（进度 50%）
    await w.travelTick(clock);
    assert.equal(api.seen.length, 0, 'imageDirector=auto 无 cognition 时途中中段不应背着模型盲拍');
    const roadDef = deferred.find((d) => d.spec.type === 'journey.road');
    assert.ok(roadDef, '应入队 journey.road');
    const roadRendered = roadDef.spec.render()?.text ?? '';
    assert.match(roadRendered, /此刻留影实况：在火车上往外看（前往成都途中）/);
    assert.doesNotMatch(roadRendered, /在在|｜|prompt语言:|大白天.*大白天|（在途车窗外）|调 journey_photo|不用拍就略过/);

    // 切回 template 模式直接触发 triggerAutoPhoto 时应直出后台生图
    w.cfg.imageDirector = 'template';
    const chengdu = cityById('chengdu');
    w.triggerAutoPhoto(chengdu, 14, '2026-11-24', '', null, true, '火车');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(api.seen.length, 1, 'template 模式应直接静默调用生图接口');
    assert.match(api.seen[0].prompt, /在火车上往外看/);

    // AbortSignal 提前取消时 draftPromptWithCognition 不应等也不应误发图
    const ac = new AbortController();
    ac.abort();
    const slowCog = { request: async () => new Promise(() => {}) };
    w.host = fakeHost(slowCog).host;
    const cancelRes = await w.maybePhoto(chengdu, 14, '2026-11-24', '宽窄巷子', null, true, false, '', 'ground', 'ground', '', '', undefined, ac.signal);
    assert.equal(cancelRes.ok, false);
    assert.equal(api.seen.length, 1, '提前取消后不应继续请求生图 API');
  } finally {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('开关真生效（imageDirector=template）：即便宿主存在 cognition 也绝不调用后台 cognition', async () => {
  const api = await fakeImageApi();
  const dir = mkdtempSync(join(tmpdir(), 'jr-dir-tmpl-'));
  try {
    let cogCalls = 0;
    const clock = new Date('2026-11-24T06:31:00Z');
    const cog = {
      request: async () => {
        cogCalls += 1;
        return { text: 'should never be used in template mode' };
      },
    };
    const w = new JourneyWorld({
      cfg: {
        ...JOURNEY_DEFAULTS(),
        enabled: true,
        homeCity: '兰州',
        imageApi: api.api,
        imageKey: 'sk-test',
        imageModel: 'gpt-image-1',
        imagePromptLang: 'zh',
        imageDirector: 'template',
      },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => clock,
    });
    const { host } = fakeHost(cog);
    await w.start(host);
    const tianjin = cityById('tianjin');
    w.st = { ...w.st, phase: 'staying', hereId: 'tianjin', lastBeatKey: '' };
    w.plan = {
      cityId: 'tianjin',
      dateKey: '2026-11-24',
      sunriseHour: 7.0,
      sunsetHour: 16.9,
      weather: { dateKey: '2026-11-24', dayWeather: '晴', nightWeather: '晴', dayTemp: 6, nightTemp: -1, dayWind: '北', dayPower: '3' },
      lodging: { name: '天津小筑', tier: 'budget', kind: '快捷连锁', price: 220, feel: '安静' },
      beats: [{ at: 14, kind: 'activity', what: '下午，瓷房子', spot: '瓷房子', until: 17 }],
    };

    const r = await w.maybePhoto(tianjin, 14.52, '2026-11-24', '瓷房子', w.plan.weather, true);
    assert.equal(r.ok, true);
    assert.equal(cogCalls, 0, 'imageDirector=template 时不得调用宿主 cognition');
    assert.match(api.seen[0].prompt, /瓷房子/);
  } finally {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('在途表达、前半程出发/目的地与零循环引用：消除「在自驾上/在步行上/在海景阳台房上」「前往出发地」及「（在途车窗外）」', async () => {
  const photoSrc = readFileSync(new URL('../src/photo.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(photoSrc, /from '\.\/photo-facts\.ts'/, 'photo.ts 不得反向重导 photo-facts.ts 形成循环引用');

  const dir = mkdtempSync(join(tmpdir(), 'jr-road-tag-'));
  try {
    // 进度 25%（前半程）：出发地兰州 -> 目的地成都
    const clock = new Date('2026-11-24T04:00:00Z'); // 北京 12:00
    const w = new JourneyWorld({
      cfg: {
        ...JOURNEY_DEFAULTS(),
        enabled: true,
        homeCity: '兰州',
        imageApi: 'http://127.0.0.1:9999/v1',
        imageKey: 'sk-test',
        imageModel: 'gpt-image-1',
        imagePromptLang: 'zh',
      },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => clock,
    });
    const { host } = fakeHost();
    await w.start(host);

    for (const [modeId, seatId, seat, expected] of [
      ['car', 'standard-car', '普通自驾', '开车沿路往外看（兰州出发前往成都途中）'],
      ['walk', undefined, '', '沿路步行看风景（兰州出发前往成都途中）'],
      ['ship', 'ocean-balcony', '海景阳台房', '站在客轮海景阳台房往外看（兰州出发前往成都途中）'],
    ]) {
      w.st = {
        ...w.st,
        phase: 'traveling',
        hereId: 'lanzhou',
        leg: {
          id: `leg-${modeId}`,
          fromId: 'lanzhou',
          toId: 'chengdu',
          modeId,
          km: 980,
          durationWorldHours: 8,
          departedAt: '2026-11-24T02:00:00Z',
          arriveAt: '2026-11-24T10:00:00Z',
          speed: 1,
          seat,
          ...(seatId ? { seatId } : {}),
          viaIds: [],
          createdAt: '2026-11-24T02:00:00Z',
        },
      };
      const tag = w.currentNowPhotoTag();
      assert.ok(tag.includes(expected), `${modeId}/${seat} 预期含「${expected}」，实际：${tag}`);
      assert.doesNotMatch(tag, /在自驾上|在步行上|在海景阳台房上|前往兰州途中|（在途车窗外）/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
