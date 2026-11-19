import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { photoPrompt, cleanDoing } = await import('../src/photo.ts');
const { JourneyWorld, JOURNEY_DESCRIBE } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { DiaryStore } = await import('../src/diary.ts');
const { cityById } = await import('../src/geo/cities.ts');
const { beatText } = await import('../src/helpers.ts');

const MIN_PNG_B64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]).toString('base64');

const shootDirect = (w, override, signal) => w.maybePhoto(
  cityById('xian'), 12, '2026-11-19', '大雁塔', null,
  true, false, '', 'ground', 'ground', '', '', override, signal,
);

test('极简 v2：覆盖全部 6 种 subject 与 onRoad（含在途 food/detail 分支），绝不混入画质杀手', () => {
  const cases = [
    { city: '嘉峪关', cityId: 'jiayuguan', spot: '嘉峪关关城', hour: 10, month: 11, subject: 'ground', minimal: true },
    { city: '西安', cityId: 'xian', hour: 23, month: 11, onRoad: true, mode: '汽车', subject: 'ground', minimal: true },
    { city: '西安', cityId: 'xian', hour: 12, month: 11, onRoad: true, mode: '动车', subject: 'food', dish: '肉夹馍', minimal: true },
    { city: '西安', cityId: 'xian', hour: 15, month: 11, onRoad: true, mode: '火车', subject: 'detail', minimal: true },
    { city: '成都', cityId: 'chengdu', hour: 19, month: 11, subject: 'food', dish: '担担面', minimal: true },
    { city: '成都', cityId: 'chengdu', spot: '宽窄巷子', hour: 16, month: 11, subject: 'street', minimal: true },
    { city: '成都', cityId: 'chengdu', spot: '宽窄巷子', hour: 16, month: 11, subject: 'detail', minimal: true },
    { city: '北京', cityId: 'beijing', spot: '故宫', hour: 14, month: 2, day: 5, subject: 'festival', minimal: true },
    { city: '大理', cityId: 'dali', hour: 22, month: 11, subject: 'sky', weather: '晴', minimal: true },
  ];

  const killers = /画面能看出这一点|以上面那句为准|不冷不热|手机夜拍，噪点明显|远处散着几个很小的行人/;
  const seen = new Set();
  for (const s of cases) {
    const out = photoPrompt(s);
    assert.doesNotMatch(out, killers, `存在画质杀手：${out}`);
    assert.ok(!/undefined|NaN/.test(out), `存在拼接异常：${out}`);
    assert.match(out, /没有人物，没有文字。$/);
    seen.add(out);
  }
  assert.equal(seen.size, cases.length);

  // J2：onRoad 下的 food 与 detail 不被车窗外看覆盖
  const roadFood = photoPrompt(cases[2]);
  assert.match(roadFood, /在动车上，肉夹馍特写/);
  assert.doesNotMatch(roadFood, /往外看/);
  const roadDetail = photoPrompt(cases[3]);
  assert.match(roadDetail, /在火车上，旅途小物近景，浅景深/);
  assert.doesNotMatch(roadDetail, /往外看/);
});

test('cleanDoing（J7）：滤除酒店入住与评价噪音，但保留正常室内/窗边作息；放宽 describe 到 120 字', () => {
  assert.equal(cleanDoing('在亚朵酒店办理入住，隔音不错床垫挺软'), '');
  assert.equal(cleanDoing('民宿房间很干净，性价比很高'), '');
  assert.equal(cleanDoing('傍晚坐在城墙根吹风'), '傍晚坐在城墙根吹风');
  assert.equal(
    cleanDoing('窗帘只拉开一半，坐在窗边听了一会儿楼下的声音'),
    '窗帘只拉开一半，坐在窗边听了一会儿楼下的声音',
  );
  assert.equal(
    cleanDoing('回住处洗了澡，靠在床头翻今天拍的照片'),
    '回住处洗了澡，靠在床头翻今天拍的照片',
  );

  const dayanta = photoPrompt({
    city: '西安',
    cityId: 'xian',
    spot: '大雁塔',
    hour: 22,
    month: 11,
    doing: '在亚朵酒店办理入住，隔音不错床垫挺软，性价比挺高',
    minimal: true,
  });
  assert.doesNotMatch(dayanta, /亚朵|隔音|床垫|入住|性价比/);

  const longDesc = '石板路在夜灯下微微反光，塔影落在广场南边水面上，一只三花猫坐在石阶角落歪着头看过来，远处的檐角垂着两盏旧灯笼，微风刚吹过檐铃';
  const outMin = photoPrompt({
    city: '西安',
    cityId: 'xian',
    spot: '大雁塔',
    hour: 22,
    describe: longDesc,
    minimal: true,
  });
  assert.ok(outMin.includes('檐角垂着'), `超过 60 字但在 120 字内的 describe 被过早截断：${outMin}`);

  const detailedRoad = photoPrompt({
    city: '西安',
    cityId: 'xian',
    hour: 23,
    onRoad: true,
    mode: '汽车',
    feel: '不冷不热，没什么特别的',
  });
  assert.doesNotMatch(detailedRoad, /不冷不热|远处散着几个很小的行人|画面能看出这一点|手机夜拍，噪点明显/);
  assert.match(detailedRoad, /画面里没有人物/);
});

test('libraryHint（J4/J5/J6）：支持 life-public.json 自定义 libraryDir、多条目精确匹配、有人出镜共存 scenes 与详细模式注入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-lib-'));
  const customLib = join(dir, 'custom-img-lib');
  mkdirSync(join(customLib, 'scenes', 'guancheng'), { recursive: true });
  writeFileSync(join(customLib, 'scenes', 'guancheng', 'entry.json'), JSON.stringify({
    id: 'guancheng',
    category: 'scenes',
    name: '嘉峪关关城',
    aliases: ['关城'],
    tags: [],
    appearance: '夯土高墙与三层飞檐箭楼，背后是连绵雪山轮廓',
    images: [],
  }));
  // 放入两个角色与两套服饰，验证不会盲取第一个不相关的条目
  mkdirSync(join(customLib, 'characters', 'a_passerby'), { recursive: true });
  writeFileSync(join(customLib, 'characters', 'a_passerby', 'entry.json'), JSON.stringify({
    id: 'a_passerby',
    category: 'characters',
    name: '路人甲',
    aliases: [],
    appearance: '灰衣路人甲外观',
  }));
  mkdirSync(join(customLib, 'characters', 'b_fish'), { recursive: true });
  writeFileSync(join(customLib, 'characters', 'b_fish', 'entry.json'), JSON.stringify({
    id: 'b_fish',
    category: 'characters',
    name: '大肥鱼',
    aliases: ['小鱼'],
    appearance: '蓝白发饰少女大肥鱼',
  }));
  mkdirSync(join(customLib, 'outfits', 'a_swim'), { recursive: true });
  writeFileSync(join(customLib, 'outfits', 'a_swim', 'entry.json'), JSON.stringify({
    id: 'a_swim',
    category: 'outfits',
    name: '泳装',
    aliases: [],
    appearance: '夏威夷花色泳装',
  }));
  mkdirSync(join(customLib, 'outfits', 'b_coat'), { recursive: true });
  writeFileSync(join(customLib, 'outfits', 'b_coat', 'entry.json'), JSON.stringify({
    id: 'b_coat',
    category: 'outfits',
    name: '防风冲锋衣',
    aliases: ['冲锋衣'],
    appearance: '米白色防风冲锋衣配围巾',
  }));
  writeFileSync(join(dir, 'life-public.json'), JSON.stringify({
    libraryDir: customLib,
    activity: { outfitHint: '防风冲锋衣' },
  }));

  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: dir,
    botName: '大肥鱼',
  });
  // 空镜场景命中自定义 libraryDir 下的嘉峪关
  assert.match(w.readLifeLibraryHint('ground', false, '嘉峪关关城'), /夯土高墙/);
  assert.equal(w.readLifeLibraryHint('sky', false, '嘉峪关关城'), '');

  // J6：castOn 为 true 时同时匹配大肥鱼（跳过排第一的路人甲）、防风冲锋衣（跳过排第一的泳装）与嘉峪关关城场景
  const castHint = w.readLifeLibraryHint('ground', true, '嘉峪关关城', '大肥鱼', '在城楼吹风');
  assert.match(castHint, /蓝白发饰少女大肥鱼/);
  assert.match(castHint, /米白色防风冲锋衣/);
  assert.match(castHint, /夯土高墙/);
  assert.doesNotMatch(castHint, /路人甲|泳装/);

  // J4：详细模式（minimal: false）同样消费 libraryHint
  const detailedGround = photoPrompt({
    city: '嘉峪关',
    cityId: 'jiayuguan',
    spot: '嘉峪关关城',
    hour: 10,
    month: 11,
    subject: 'ground',
    minimal: false,
    libraryHint: '夯土高墙与三层飞檐箭楼',
  });
  assert.match(detailedGround, /夯土高墙与三层飞檐箭楼/);
  const detailedStreet = photoPrompt({
    city: '嘉峪关',
    cityId: 'jiayuguan',
    spot: '嘉峪关关城',
    hour: 16,
    month: 11,
    subject: 'street',
    minimal: false,
    libraryHint: '夯土高墙与三层飞檐箭楼',
  });
  assert.match(detailedStreet, /夯土高墙与三层飞檐箭楼/);
});

test('Harness 原语（J1/J3）：storage.clear 内存同步、journey.road 延迟重算与 onHandoffEnded 实时快照', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-harness-'));
  const memDir = join(dir, 'sync-mem');
  mkdirSync(memDir, { recursive: true });
  let clockMs = Date.parse('2026-11-19T04:00:00Z');
  const pushed = [];
  const deferred = [];
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', memoryDir: memDir, beatGap: 2 },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(clockMs),
  });
  await w.start({
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e, opts) => {
      const env = { ...e, cursor: pushed.length + 1, opts };
      pushed.push(env);
      return env;
    },
    pushDeferred: (spec, opts) => {
      deferred.push({ spec, opts });
    },
    store: {},
    drainPendingEvents: async () => [],
  });

  const tools = w.tools();
  const photoTool = tools.find((t) => t.name === 'journey_photo');
  const nowDecl = JOURNEY_DESCRIBE.tools.find((t) => t.name === 'journey_now');
  const statsDecl = JOURNEY_DESCRIBE.tools.find((t) => t.name === 'journey_stats');
  assert.equal(photoTool?.interruptible, true);
  assert.ok(nowDecl?.tags.includes('snapshot'));
  assert.ok(statsDecl?.tags.includes('snapshot'));

  // J3：journey.road 经 maybeRoadBeat 真实入队，render() 随时间推进动态重算剩余时间，抵达后返回 null
  w.st = {
    ...w.st,
    phase: 'traveling',
    leg: {
      id: 'leg-real-1',
      fromId: 'lanzhou',
      toId: 'xian',
      modeId: 'train',
      km: 600,
      durationWorldHours: 8,
      departedAt: '2026-11-19T00:00:00Z',
      arriveAt: '2026-11-19T08:00:00Z',
      seat: '二等座',
      seatMult: 1,
      viaIds: [],
      createdAt: '2026-11-19T00:00:00Z',
    },
    roadMarks: [],
  };
  await w.roadBeats(w.worldNow(), w.st.leg);
  const roadDefer = deferred.find((d) => d.spec.type === 'journey.road');
  assert.ok(roadDefer, '应通过 pushDeferred 入队 journey.road');
  assert.deepEqual(roadDefer.spec.tags, ['snapshot']);
  const firstRender = roadDefer.spec.render()?.text ?? '';
  assert.match(firstRender, /4 小时/);
  // 时间推进 2 小时，render() 应实时重算为「2 小时」而非旧闭包文本
  clockMs = Date.parse('2026-11-19T06:00:00Z');
  const secondRender = roadDefer.spec.render()?.text ?? '';
  assert.match(secondRender, /2 小时/);
  // 抵达后（切换到 staying），render() 返回 null 撤下过时在途快照
  w.st = { ...w.st, phase: 'staying', hereId: 'xian', leg: null };
  assert.equal(roadDefer.spec.render(), null);

  // J3：onHandoffEnded 同步入队 journey.handoff，render() 反映投递当下的最新城市
  deferred.length = 0;
  w.onHandoffEnded();
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].spec.type, 'journey.handoff');
  assert.equal(deferred[0].opts.trigger, 'piggyback');
  assert.deepEqual(deferred[0].spec.tags, ['snapshot']);
  w.st = { ...w.st, phase: 'staying', hereId: 'chengdu', leg: null };
  assert.match(deferred[0].spec.render()?.text ?? '', /成都/);

  // J1：验证 4 个 storage.clear() 同步重置内存与磁盘，且后续操作不会把旧数据复活
  w.photos.add({
    handle: 'log:test1.png',
    cityId: 'chengdu',
    cityName: '成都',
    dateKey: '2026-11-19',
    title: '锦里夜色',
    spot: '锦里',
    at: '2026-11-19T05:00:00Z',
  });
  assert.equal(w.photos.count(), 1);
  w.diary.write({ dateKey: '2026-11-19', cityId: 'chengdu', cityName: '成都', body: '今天在成都吃面。' });
  assert.equal(w.diary.count(), 1);
  w.st = {
    ...w.st,
    everVisited: ['lanzhou', 'xian', 'chengdu'],
    wishes: ['lhasa'],
    spent: 880,
    earned: 200,
  };
  w.persist();

  const parts = w.webUi().storage ?? [];
  const pPhotos = parts.find((p) => p.key === 'journey.photos');
  const pDiary = parts.find((p) => p.key === 'journey.diary');
  const pMemory = parts.find((p) => p.key === 'journey.memory');
  const pState = parts.find((p) => p.key === 'journey.state');

  await pPhotos.clear();
  assert.equal(w.photos.count(), 0);
  w.photos.add({
    handle: 'log:test2.png',
    cityId: 'chengdu',
    cityName: '成都',
    dateKey: '2026-11-20',
    title: '新照片',
    spot: '',
    at: '2026-11-20T05:00:00Z',
  });
  assert.equal(w.photos.count(), 1, '新增照片不应复活已清空的旧照片');

  await pDiary.clear();
  assert.equal(w.diary.count(), 0);

  await pMemory.clear();
  assert.equal(w.st.everVisited.length, 0);
  assert.equal(w.st.wishes.length, 0);
  assert.equal(w.st.spent, 0);
  assert.equal(w.travelMemory.read(), null);

  await pState.clear();
  assert.equal(w.st.phase, 'home');
  assert.equal(w.st.hereId, 'lanzhou');
  assert.equal(existsSync(join(dir, 'state.json')), false);

  // describe.json 与 JOURNEY_DESCRIBE 一致性校验
  const onDisk = JSON.parse(readFileSync(new URL('../describe.json', import.meta.url), 'utf8'));
  assert.deepEqual(onDisk, JOURNEY_DESCRIBE);

  // J13：journey.beat / journey.road / journey.handoff 补齐 snapshot 标签
  for (const evType of ['journey.beat', 'journey.road', 'journey.handoff']) {
    const ev = onDisk.events.find((e) => e.type === evType);
    assert.ok(ev?.tags?.includes('snapshot'), `${evType} 缺少 snapshot tag`);
  }

  await w.stop();
});

test('第二轮复审（J6/J10/J11/J12/J14）：角色匹配不误兜底、日记清档跳过无关 md、beat 实时重算、生图返回遇取消不落盘、配置上限文案一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-r2-'));
  const syncDiary = join(dir, 'sync-diary');
  const libDir = join(dir, 'lib');
  const origFetch = globalThis.fetch;

  try {
    // J6：characters 只有唯一一条记录「路人甲」，但当前 botName / castHint 是「小满」，绝不能误兜底
    mkdirSync(join(libDir, 'characters', 'only_other'), { recursive: true });
    writeFileSync(join(libDir, 'characters', 'only_other', 'entry.json'), JSON.stringify({
      id: 'only_other',
      category: 'characters',
      name: '路人甲',
      aliases: [],
      appearance: '黑衣路人甲外观',
    }));
    writeFileSync(join(dir, 'life-public.json'), JSON.stringify({ libraryDir: libDir }));
    const w6 = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
      dataDir: dir,
      botName: '小满',
    });
    assert.equal(w6.readLifeLibraryHint('ground', true, '', '小满', ''), '');

    // J10：diary.clearAll 仅删除日记格式 .md，绝不误删同目录与 _bak 下的无关用户笔记 notes.md
    mkdirSync(join(syncDiary, '_bak', 'legacy'), { recursive: true });
    const diary = new DiaryStore(dir);
    diary.configure(syncDiary);
    diary.write({ dateKey: '2026-11-18', cityId: 'xian', cityName: '西安', body: '城墙散步。' });
    writeFileSync(join(syncDiary, '2026-11-01.md'), '---\ndate: 2026-11-01\ncity: 兰州\ncityId: lanzhou\n---\n旧日记\n', 'utf8');
    writeFileSync(join(syncDiary, 'notes.md'), '# 我的旅行备忘\n不要删我\n', 'utf8');
    writeFileSync(join(syncDiary, '_bak', 'readme.md'), '# 用户手写备份说明\n', 'utf8');
    writeFileSync(join(syncDiary, '_bak', 'legacy', '2026-10-31.md'), '---\ndate: 2026-10-31\ncity: 兰州\ncityId: lanzhou\n---\n历史\n', 'utf8');
    const removed = diary.clearAll();
    assert.ok(removed >= 2);
    assert.equal(existsSync(join(syncDiary, '2026-11.md')), false);
    assert.equal(existsSync(join(syncDiary, '2026-11-01.md')), false);
    assert.equal(existsSync(join(syncDiary, '_bak', 'legacy', '2026-10-31.md')), false);
    assert.equal(existsSync(join(syncDiary, 'notes.md')), true, '同目录无关 notes.md 不得被误删');
    assert.equal(existsSync(join(syncDiary, '_bak', 'readme.md')), true, '_bak 下无关 readme.md 不得被误删');

    // J23：文件名撞上月报/旧日报格式也不够，必须有扩展标题或可验证的日记 frontmatter。
    const userDir = join(dir, 'user-notes');
    mkdirSync(userDir, { recursive: true });
    const userDiary = new DiaryStore(join(dir, 'user-data'));
    userDiary.configure(userDir);
    writeFileSync(join(userDir, '2026-11.md'), '# 我的十一月笔记\n---\ndate: 2026-11-01\ncity: 私人行程\ncityId: private\n---\n不要删我\n', 'utf8');
    writeFileSync(join(userDir, '2026-11-01.md'), '# 普通Markdown笔记\n没有旅行日记 frontmatter\n', 'utf8');
    assert.equal(userDiary.clearAll(), 0, '无法验证为本扩展日记的文件一个都不能删');
    assert.equal(existsSync(join(userDir, '2026-11.md')), true, '同名用户月笔记必须保留');
    assert.equal(existsSync(join(userDir, '2026-11-01.md')), true, '同名用户日笔记必须保留');

    // J23：同月有一份真日记时，迁移也不得顺带挪走普通笔记或日期不匹配的文件。
    const migrationDir = join(dir, 'migration-notes');
    mkdirSync(migrationDir, { recursive: true });
    writeFileSync(join(migrationDir, '2026-11-01.md'), '---\ndate: 2026-11-01\ncity: 兰州\ncityId: lanzhou\n---\n真日记\n', 'utf8');
    writeFileSync(join(migrationDir, '2026-11-02.md'), '# 同月普通笔记\n不要挪我\n', 'utf8');
    writeFileSync(join(migrationDir, '2026-11-03.md'), '---\ndate: 2026-11-04\ncity: 私人行程\ncityId: private\n---\n文件名与内容不匹配\n', 'utf8');
    const migrationDiary = new DiaryStore(join(dir, 'migration-data'));
    migrationDiary.configure(migrationDir);
    assert.equal(existsSync(join(migrationDir, '2026-11.md')), true, '真日记应迁移到月文件');
    assert.equal(existsSync(join(migrationDir, '_bak', 'legacy', '2026-11-01.md')), true, '真旧日记应归档');
    assert.equal(existsSync(join(migrationDir, '2026-11-02.md')), true, '普通笔记不得被真日记顺带归档');
    assert.equal(existsSync(join(migrationDir, '2026-11-03.md')), true, '日期不匹配的文件不得迁移或归档');
    migrationDiary.clearAll();
    assert.equal(existsSync(join(migrationDir, '2026-11-02.md')), true, '迁移后清档仍须保留普通笔记');
    assert.equal(existsSync(join(migrationDir, '2026-11-03.md')), true, '迁移后清档仍须保留日期不匹配文件');

    // J11：journey.beat 通过 pushDeferred 入队后若当日作息被修改，render() 动态按最新 plan 重算
    const deferred = [];
    const pushed = [];
    const usages = [];
    const clock = new Date('2026-11-19T05:00:00Z'); // 西安当地 13:00
    const w = new JourneyWorld({
      cfg: {
        ...JOURNEY_DEFAULTS(),
        enabled: true,
        homeCity: '兰州',
        imageProtocol: 'openai',
        imageApi: 'https://img.test/v1/images/generations',
        imageKey: 'sk-test',
        imageModel: 'gpt-image-1',
        memoryDir: syncDiary,
      },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => clock,
    });
    await w.start({
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e) => {
        const env = { ...e, cursor: pushed.length + 1, blobs: [{ handle: 'log:mock.png' }] };
        pushed.push(env);
        return env;
      },
      pushDeferred: (spec, opts) => {
        deferred.push({ spec, opts });
      },
      reportUsage: (u, opts) => { usages.push({ u, opts }); },
      store: {},
      drainPendingEvents: async () => [],
    });

    const xian = cityById('xian');
    w.st = { ...w.st, phase: 'staying', hereId: 'xian', lastBeatKey: '' };
    w.plan = {
      cityId: 'xian',
      dateKey: '2026-11-19',
      sunriseHour: 7.2,
      lodging: { name: '古城小筑', tier: 'budget', kind: '快捷连锁', price: 240, feel: '屋里挺安静' },
      beats: [
        { at: 12.5, kind: 'lunch', what: '午饭，吃了一碗肉丸胡辣汤' },
      ],
    };
    await w.advanceBeats(clock, xian, 13.0, '2026-11-19');
    const beatDefer = deferred.find((d) => d.spec.type === 'journey.beat');
    assert.ok(beatDefer, '应通过 pushDeferred 入队 journey.beat');
    w.plan = {
      ...w.plan,
      beats: [{ at: 12.5, kind: 'lunch', what: '午饭，临时改去吃岐山臊子面' }],
    };
    const renderedBeat = beatDefer.spec.render()?.text ?? '';
    assert.match(renderedBeat, /岐山臊子面/, 'render() 应反映最新的 plan.beats 内容');
    assert.doesNotMatch(renderedBeat, /胡辣汤/, '不应返回入队时的旧闭包文本');

    // J12：生图刚返回就遇 signal.aborted 时：reportUsage 照常记账，但绝不推送事件、不归档、不入相册
    const minPngB64 = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    ]).toString('base64');
    const ac = new AbortController();
    globalThis.fetch = async () => {
      // 模拟服务端刚生成完毕准备回包时调用方触发了中断信号
      ac.abort();
      return new Response(JSON.stringify({
        data: [{ b64_json: minPngB64 }],
        usage: { input_tokens: 120, output_tokens: 80 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    pushed.length = 0;
    const beforeCount = w.photos.count();
    const photoTool = w.tools().find((t) => t.name === 'journey_photo');
    assert.ok(photoTool);
    const shootRes = await photoTool.handler({ subject: 'ground', describe: '城墙脚下晴天光线' }, { signal: ac.signal });
    assert.match(typeof shootRes === 'string' ? shootRes : shootRes.text, /没拍|取消|没能/);
    assert.equal(usages.length, 1, '云端已返回 usage 时必须照常记账');
    assert.equal(pushed.length, 0, '已取消后绝不应推送 journey.photo');
    assert.equal(w.photos.count(), beforeCount, '已取消后绝不应写入相册');
    assert.equal(existsSync(join(syncDiary, 'media')), false, '已取消后绝不应写入同步盘媒体归档');

    // J14：config.ts 中画面描述字符上限说明统一为 120 字
    const cfgSrc = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(cfgSrc, /60 字的描述/);
    assert.match(cfgSrc, /120 字上限/);

    await w.stop();
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第三轮复审（J11/J12/J15/J18）：换酒店不混旧酒店名、push 等待期清图鉴与取消均不写回、日出附注完整保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-r3-'));
  const syncDiary = join(dir, 'sync-diary');
  const origFetch = globalThis.fetch;

  try {
    // J18：stripClashClock 不得误剥「当地日出 六点半」日出附注
    const xian = cityById('xian');
    const sunriseRendered = beatText(
      xian,
      {
        cityId: 'xian',
        dateKey: '2026-11-19',
        sunriseHour: 6.5,
        sunsetHour: 18.0,
        lodging: { name: '青旅', tier: 'budget', price: 120, feel: '安静' },
        beats: [],
      },
      'wake',
      5,
      '天没亮就起，为了赶日出（当地日出 六点半）',
    );
    assert.match(sunriseRendered, /当地日出 六点半/);
    assert.doesNotMatch(sunriseRendered, /当地日出\s*[）)]/);

    // J11：通过 advanceBeats 入队 hotel deferred，再真实调用 changeLodging() 换酒店后 render() 绝不能混出旧酒店名+新价格
    let clock = new Date('2026-11-19T14:00:00Z'); // 西安当地 22:00
    const deferred = [];
    const pushed = [];
    let pushGate = null;
    const minPngB64 = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    ]).toString('base64');

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (/open-meteo|amap/.test(u)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            daily: {
              time: ['2026-11-18', '2026-11-19', '2026-11-20'],
              weather_code: [0, 0, 0],
              temperature_2m_max: [20, 20, 20],
              temperature_2m_min: [10, 10, 10],
              precipitation_probability_max: [0, 0, 0],
              wind_speed_10m_max: [6, 6, 6],
            },
          }),
        };
      }
      return new Response(JSON.stringify({
        data: [{ b64_json: minPngB64 }],
        usage: { input_tokens: 80, output_tokens: 40 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const w = new JourneyWorld({
      cfg: {
        ...JOURNEY_DEFAULTS(),
        enabled: true,
        homeCity: '兰州',
        imageProtocol: 'openai',
        imageApi: 'https://img.test/v1/images/generations',
        imageKey: 'sk-test',
        imageModel: 'gpt-image-1',
        memoryDir: syncDiary,
      },
      dataDir: dir,
      botName: '大肥鱼',
      now: () => clock,
    });
    const hostRef = {
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e) => {
        if (e.type === 'journey.photo' && pushGate) {
          await pushGate.promise;
        }
        const env = { ...e, cursor: pushed.length + 1, blobs: [{ handle: 'log:mock2.png' }] };
        pushed.push(env);
        return env;
      },
      pushDeferred: (spec, opts) => {
        deferred.push({ spec, opts });
      },
      reportUsage: () => {},
      store: {},
      drainPendingEvents: async () => [],
    };
    await w.start(hostRef);

    const oldHotelName = '虚构旧客栈(测试号)';
    w.st = { ...w.st, phase: 'staying', hereId: 'xian', lastBeatKey: '' };
    w.plan = {
      cityId: 'xian',
      dateKey: '2026-11-19',
      sunriseHour: 7.0,
      sunsetHour: 17.8,
      lodging: { name: oldHotelName, tier: 'budget', kind: '快捷连锁', price: 240, feel: '院里有棵老树' },
      beats: [
        { at: 21.5, kind: 'hotel', what: `回${oldHotelName}。院里有棵老树` },
      ],
    };
    await w.advanceBeats(clock, xian, 22.0, '2026-11-19');
    const hotelDefer = deferred.find((d) => d.spec.type === 'journey.beat');
    assert.ok(hotelDefer, '应入队 hotel deferred');

    const originalRandom = Math.random;
    Math.random = () => 0;
    let changeRes;
    try {
      changeRes = await w.changeLodging('nicer', '太吵了换一家');
    } finally {
      Math.random = originalRandom;
    }
    assert.match(changeRes.text, /换到/);
    assert.equal(w.plan.lodging.tier, 'luxury', 'J19: nicer 必须真实覆盖高档分支');
    const renderedHotel = hotelDefer.spec.render()?.text ?? '';
    assert.ok(renderedHotel.length > 0);
    assert.ok(!renderedHotel.includes(oldHotelName), 'J11: 换酒店后 deferred 绝不能保留旧酒店名');
    assert.ok(renderedHotel.includes(w.plan.lodging.name), 'J11: 换酒店后 deferred 应使用新酒店名（含括号也按字面匹配）');

    // J15：push 等待期间执行 journey.photos.clear()，放行后相册计数仍为 0 且 photos.json 不重建
    const storageParts = w.webUi().storage ?? [];
    const photosPart = storageParts.find((p) => p.key === 'journey.photos');
    assert.ok(photosPart);
    await photosPart.clear();
    assert.equal(existsSync(join(dir, 'photos.json')), false);

    let releasePush;
    pushGate = { promise: new Promise((r) => { releasePush = r; }) };
    const photoTool = w.tools().find((t) => t.name === 'journey_photo');
    assert.ok(photoTool);
    const ac1 = new AbortController();
    const p1 = photoTool.handler({ subject: 'ground', describe: '大雁塔晨光' }, { signal: ac1.signal });
    await new Promise((r) => setTimeout(r, 40));
    await photosPart.clear();
    releasePush();
    const r1 = await p1;
    assert.match(r1.text, /清空|变更|没拍成/);
    assert.equal(w.photos.count(), 0, 'J15: push 期间清空相册后不得写回');
    assert.equal(existsSync(join(dir, 'photos.json')), false, 'J15: 不得在清空后重建 photos.json');

    // J12/J15：push 等待期间触发 signal.aborted，放行后同样不得归档与写相册
    pushGate = { promise: new Promise((r) => { releasePush = r; }) };
    const ac2 = new AbortController();
    const p2 = photoTool.handler({ subject: 'ground', describe: '钟楼夜景' }, { signal: ac2.signal });
    await new Promise((r) => setTimeout(r, 40));
    ac2.abort();
    releasePush();
    const r2 = await p2;
    assert.match(r2.text, /取消|没拍成/);
    assert.equal(w.photos.count(), 0, 'J12: push 期间取消后不得写回相册');
    assert.equal(existsSync(join(dir, 'photos.json')), false, 'J12: push 期间取消后不得创建 photos.json');
    assert.equal(existsSync(join(syncDiary, 'media')), false, 'J12: push 期间取消后不得归档媒体');

    await w.stop();
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第四轮 J12/J15/J21/J22：重拍并发闸先作废旧代次，宿主撤回三态均等待且不写回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-r4-photo-'));
  const syncDiary = join(dir, 'diary');
  const origFetch = globalThis.fetch;
  const cfg = {
    ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', memoryDir: syncDiary,
    imageProtocol: 'openai', imageApi: 'https://img.test/v1/images/generations',
    imageKey: 'sk-test', imageModel: 'gpt-image-1',
  };
  const imageResponse = () => new Response(JSON.stringify({
    data: [{ b64_json: MIN_PNG_B64 }], usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    // shooting 中的重拍不会发起第二次请求，但仍要让第一个请求失效。
    let releaseFetch;
    let fetchStarted;
    const started = new Promise((r) => { fetchStarted = r; });
    globalThis.fetch = async () => {
      fetchStarted();
      await new Promise((r) => { releaseFetch = r; });
      return imageResponse();
    };
    const w0 = new JourneyWorld({ cfg, dataDir: join(dir, 'shooting'), botName: '大肥鱼' });
    const first = shootDirect(w0);
    await started;
    const second = await shootDirect(w0, { prompt: '新提示词', replaceHandle: 'log:old.png' });
    assert.match(second.reason, /上一张还没拍完/);
    releaseFetch();
    const stale = await first;
    assert.match(stale.reason, /变更|丢弃/);
    assert.equal(w0.photos.count(), 0, '被重拍作废的旧请求不得写回相册');

    // abort 让请求进入 catch 时也属于 stale；不得借异常分支覆盖指示灯或错误状态。
    const abort = new AbortController();
    globalThis.fetch = async () => {
      abort.abort();
      throw new Error('mock aborted fetch');
    };
    const cancelled = await shootDirect(w0, undefined, abort.signal);
    assert.equal(cancelled.ok, false);
    assert.equal(w0.photoOutcome, 'never', '已取消旧请求不得改写指示灯');
    assert.equal(w0.photoError, null, '已取消旧请求不得写回错误状态');

    // true / false / throw 三态都走同一个 await 撤回路径。
    const w = new JourneyWorld({ cfg, dataDir: join(dir, 'withdraw'), botName: '大肥鱼' });
    let activeAbort;
    let withdrawMode = 'true';
    let releaseWithdraw;
    let markWithdraw;
    const withdrawals = [];
    await w.start({
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e) => {
        if (e.type === 'journey.photo') activeAbort.abort();
        return { ...e, cursor: 41, blobs: [{ handle: 'log:withdraw.png' }] };
      },
      withdrawPending: async (cursor) => {
        withdrawals.push(cursor);
        markWithdraw();
        await new Promise((r) => { releaseWithdraw = r; });
        if (withdrawMode === 'throw') throw new Error('mock withdraw failure');
        return withdrawMode === 'true';
      },
      reportUsage: () => {}, store: {}, drainPendingEvents: async () => [],
    });
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('https://registry.npmjs.org/')) {
        return { ok: true, status: 200, json: async () => ({ latest: '0.0.0' }) };
      }
      return imageResponse();
    };
    for (const mode of ['true', 'false', 'throw']) {
      withdrawMode = mode;
      const ac = new AbortController();
      activeAbort = ac;
      const waiting = new Promise((r) => { markWithdraw = r; });
      const pending = shootDirect(w, undefined, ac.signal);
      await waiting;
      assert.notEqual(w.photoOutcome, 'ok', '撤回尚未确认时指示灯不得显示拍成');
      releaseWithdraw();
      const res = await pending;
      assert.equal(res.ok, false);
      if (mode === 'true') assert.match(res.reason, /已撤回/);
      if (mode === 'false') assert.match(res.reason, /已投递.*可能残留/);
      if (mode === 'throw') assert.match(res.reason, /撤回失败.*状态未知/);
      assert.equal(w.photos.count(), 0, `${mode}: 不得写入相册`);
      assert.equal(existsSync(join(syncDiary, 'media')), false, `${mode}: 不得归档媒体`);
      assert.notEqual(w.photoOutcome, 'ok', `${mode}: 失败事务不得亮成功灯`);
      const album = await w.panelInvoke('album', 'list', []);
      assert.equal(album.photos.length, 0, `${mode}: 相册 UI 不得列出未提交照片`);
      const expectedNote = mode === 'true' ? /已撤回/
        : mode === 'false' ? /已投递.*可能残留/ : /撤回失败.*状态未知/;
      assert.match(String(album.error), expectedNote, `${mode}: 相册 UI 必须说明宿主侧真实状态`);
    }
    assert.deepEqual(withdrawals, [41, 41, 41], '每次 stale 都必须真正等待一次宿主撤回');
    await w.stop();
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第四轮 J21/J22：媒体句柄缺失、归档异常与相册写盘失败都结算宿主 pending，索引保持原状', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-r4-io-'));
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://registry.npmjs.org/')) {
      return { ok: true, status: 200, json: async () => ({ latest: '0.0.0' }) };
    }
    return new Response(JSON.stringify({ data: [{ b64_json: MIN_PNG_B64 }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    let withHandle = false;
    const withdrawals = [];
    const w = new JourneyWorld({
      cfg: {
        ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', imageProtocol: 'openai',
        imageApi: 'https://img.test/v1/images/generations', imageKey: 'sk-test', imageModel: 'gpt-image-1',
      },
      dataDir: dir,
      botName: '大肥鱼',
    });
    await w.start({
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e) => ({ ...e, cursor: 52, blobs: withHandle ? [{ handle: 'log:new.png' }] : [] }),
      withdrawPending: async (cursor) => { withdrawals.push(cursor); return false; },
      reportUsage: () => {}, store: {}, drainPendingEvents: async () => [],
    });

    const missing = await shootDirect(w);
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /没返回图片句柄.*已投递/);
    assert.equal(w.photoOutcome, 'fail');
    assert.equal(w.photos.count(), 0);

    w.photos.add({
      handle: 'log:old.png', cityId: 'xian', cityName: '西安', dateKey: '2026-11-18',
      title: '旧照片', spot: '', at: '2026-11-18T04:00:00Z',
    });
    const before = w.photos.list().map((p) => p.handle);
    const originalSave = w.photos.save;
    w.photos.save = () => { throw new Error('mock photos.json write failure'); };
    withHandle = true;
    const failed = await shootDirect(w);
    assert.equal(failed.ok, false);
    assert.match(failed.reason, /write failure.*已投递.*可能残留/);
    assert.deepEqual(w.photos.list().map((p) => p.handle), before, '相册写盘失败必须回滚内存');
    assert.equal(w.photoOutcome, 'fail');

    // 归档阶段发生未预期异常：同样撤回 pending、保留旧索引，并把真实残留状态展示到 UI。
    w.photos.save = originalSave;
    w.archiveToJournal = () => { throw new Error('mock archive failure'); };
    const archiveFailed = await shootDirect(w);
    assert.equal(archiveFailed.ok, false);
    assert.match(archiveFailed.reason, /archive failure.*已投递.*可能残留/);
    assert.deepEqual(w.photos.list().map((p) => p.handle), before, '归档异常不得改动相册索引');
    const albumAfterArchiveFailure = await w.panelInvoke('album', 'list', []);
    assert.match(String(albumAfterArchiveFailure.error), /archive failure.*已投递.*可能残留/);
    assert.deepEqual(withdrawals, [52, 52, 52], '句柄缺失、索引失败和归档异常都必须 await 撤回');
    await w.stop();
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('第四轮 J20：A/B deferred 按 senderKey 反序结算，换酒店只重算仍 pending 的节点', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-r4-beats-'));
  const origFetch = globalThis.fetch;
  const originalRandom = Math.random;
  try {
    const reverse = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
      dataDir: join(dir, 'reverse'), botName: '大肥鱼',
    });
    reverse.pendingBeats.set('A', '2026-11-19|lunch|12.5');
    reverse.pendingBeats.set('B', '2026-11-19|hotel|21.5');
    reverse.onEventsSettled([{ type: 'journey.beat', senderKey: 'B' }], 'delivered');
    assert.deepEqual([...reverse.pendingBeats.keys()], ['A'], 'B 先结算不得清掉 A');
    reverse.onEventsSettled([{ type: 'journey.beat', senderKey: 'A' }], 'discarded');
    assert.equal(reverse.pendingBeats.size, 0);

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith('https://registry.npmjs.org/')) {
        return { ok: true, status: 200, json: async () => ({ latest: '0.0.0' }) };
      }
      if (/open-meteo|amap/.test(u)) {
        return { ok: true, status: 200, json: async () => ({ daily: {
          time: ['2026-11-19'], weather_code: [0], temperature_2m_max: [20],
          temperature_2m_min: [10], precipitation_probability_max: [0], wind_speed_10m_max: [6],
        } }) };
      }
      throw new Error(`测试阻断未知 URL：${u}`);
    };
    const deferred = [];
    const w = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
      dataDir: join(dir, 'live'), botName: '大肥鱼',
      now: () => new Date('2026-11-19T14:00:00Z'),
    });
    await w.start({
      log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      pushEvent: async (e) => ({ ...e, cursor: 1 }),
      pushDeferred: (spec, opts) => { deferred.push({ spec, opts }); },
      store: {}, drainPendingEvents: async () => [],
    });
    const xian = cityById('xian');
    w.st = { ...w.st, phase: 'staying', hereId: 'xian', lastBeatKey: '' };
    w.plan = {
      cityId: 'xian', dateKey: '2026-11-19', sunriseHour: 7, sunsetHour: 18,
      lodging: { name: '旧酒店(测试)', tier: 'budget', kind: '快捷连锁', price: 240, feel: '安静' },
      beats: [
        { at: 12.5, kind: 'lunch', what: '午饭，吃肉丸胡辣汤' },
        { at: 21.5, kind: 'hotel', what: '回旧酒店(测试)。安静' },
      ],
    };
    await w.advanceBeats(new Date('2026-11-19T05:00:00Z'), xian, 13, '2026-11-19');
    await w.advanceBeats(new Date('2026-11-19T14:00:00Z'), xian, 22, '2026-11-19');
    assert.equal(w.pendingBeats.size, 2);
    const keyA = 'beat-2026-11-19-lunch-12.5';
    const keyB = 'beat-2026-11-19-hotel-21.5';
    w.onEventsSettled([{ type: 'journey.beat', senderKey: keyA }], 'discarded');
    assert.deepEqual([...w.pendingBeats.keys()], [keyB], 'A 结算后 B 必须继续 pending');

    Math.random = () => 0;
    await w.changeLodging('nicer', '换一家');
    const hotel = deferred.find((d) => d.spec.senderKey === keyB);
    const rendered = hotel.spec.render()?.text ?? '';
    assert.ok(rendered.includes(w.plan.lodging.name));
    assert.ok(!rendered.includes('旧酒店(测试)'));
    w.onEventsSettled([{ type: 'journey.beat', senderKey: keyB }], 'delivered');
    assert.equal(w.pendingBeats.size, 0);
    await w.stop();
  } finally {
    Math.random = originalRandom;
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
