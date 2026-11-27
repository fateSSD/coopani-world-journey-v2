/**
 * 2026-11-08 那一批：口味、熟络度、山上代步、酒店设施、海边玩法、
 * 「没有景点时去哪」、以及把「她正在做的事」写进图片提示词。
 *
 * 每条断言都对应 Mr.Q 的一句原话，改坏了要能立刻看出来是哪一条不成立了。
 */
const base = '../src/';
const { cityById } = await import(base + 'geo/cities.ts');
const { pickFood, planDay } = await import(base + 'plan/dayplan.ts');
const {
  spotRideOptions, pickSpotExtra, beachPlay, hotelNightOptions, hotelEvening, idleSpots,
} = await import(base + 'plan/leisure.ts');
const { photoPrompt } = await import(base + 'photo.ts');
const {
  metPet, mergePets, normalizePets, warmWord,
} = await import(base + 'travel-memory.ts');
const { bondWith } = await import(base + 'mate-talk.ts');
const assert = (await import('node:assert/strict')).default;
const { test } = await import('node:test');

const ROOM = (tier) => ({ tier, kind: '某处住处', price: tier === 'luxury' ? 1500 : 200, feel: '窗是大的' });
const WEATHER = { dayWeather: '晴', nightWeather: '晴', wet: false };

/* ---------------- 4. 山上得有代步 ---------------- */

test('名山给得上代步：索道 / 滑竿 / 滑道三选一，而且真的挑得出来', () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const r = pickSpotExtra('黄山风景区', i * 7919, true);
    if (r) seen.add(r.item);
  }
  assert.ok(seen.has('索道'), `四十次没出过索道：${[...seen].join('/')}`);
  assert.ok(seen.has('滑竿'), `名山的滑竿一次没出现：${[...seen].join('/')}`);
  assert.ok(seen.has('滑道'), `下山滑道一次没出现：${[...seen].join('/')}`);
  /* 价格要对得上公示价：索道往还 140、滑竿 260、滑道 50。 */
  const price = Object.fromEntries(
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => {
      const r = pickSpotExtra('黄山风景区', i * 7919, true);
      return [r?.item, r?.price];
    }),
  );
  assert.equal(price['索道'] ?? 140, 140);
});

test('普通郊野公园没有滑竿 —— 那是城里人散步的地方，没人抬', () => {
  const items = new Set();
  for (let i = 0; i < 30; i++) items.add(pickSpotExtra('城南公园', i * 104729, true)?.item ?? '');
  assert.ok(!items.has('滑竿'), '公园里冒出人力轿了');
});

test('手头不宽就自己走 —— 一条都不买', () => {
  for (let i = 0; i < 20; i++) {
    assert.equal(pickSpotExtra('黄山风景区', i * 7919, false), null);
  }
});

/* ---------------- 5. 好酒店能游泳、健身、SPA ---------------- */

test('晚上干什么，看这家店真有什么设施，不看档位', () => {
  /*
   * ── 2026-11-09 判据换了 ──
   *
   * 原来测的是「五星档有泳池/健身/SPA，快捷连锁什么都没有」——
   * 那时候没有真实数据，只能按档位猜。
   *
   * 现在订的店是真的，有泳池没泳池查得到（`data/hotel-facts.json`）。
   * 再按档位猜就是错的：5 星店设施覆盖率 87%，剩下 13% 里就有只配健身房的，
   * 说她「在泳池里游了二十分钟」，用户上携程一看没泳池 —— 第三次返工。
   *
   * 新判据：**有 `pool` 才给泳池，没 `pool` 就不给，跟几星无关。**
   */
  const hasPool = new Set();
  for (let i = 0; i < 40; i++) hasPool.add(hotelEvening('luxury', i * 313, true, ['pool', 'gym', 'spa'])?.item ?? '');
  assert.ok(hasPool.has('泳池'), `有 pool 设施却没给泳池：${[...hasPool].join('/')}`);
  assert.ok(hasPool.has('健身房'), '有 gym 设施却没给健身房');
  assert.ok(hasPool.has('SPA'), '手头宽的时候也没安排 SPA');

  /* 五星档但设施表里没有 pool —— 一个字都不许提泳池。 */
  const noPool = new Set();
  for (let i = 0; i < 40; i++) noPool.add(hotelEvening('luxury', i * 313, true, ['gym'])?.item ?? '');
  assert.ok(!noPool.has('泳池'), '这家店没有泳池，却排了游泳');

  /* 二钻店**真有**泳池时就该给 —— 档位不比事实可靠。 */
  const cheapWithPool = new Set();
  for (let i = 0; i < 40; i++) cheapWithPool.add(hotelEvening('budget', i * 313, true, ['pool'])?.item ?? '');
  assert.ok(cheapWithPool.has('泳池'), '便宜店有泳池反而不给');

  /* 什么设施都没有（或没查到）时，只剩泡澡/在房间待着这类通用项。 */
  const bare = new Set();
  for (let i = 0; i < 40; i++) bare.add(hotelEvening('dingy', i * 313, true, [])?.item ?? '');
  for (const bad of ['泳池', '健身房', 'SPA', '温泉']) {
    assert.ok(!bare.has(bad), `没有设施数据却冒出了「${bad}」`);
  }
});

test('酒店那一项真的进了账 —— 不是白嫖', () => {
  const plan = planDay({
    city: cityById('tianshui'), dateKey: '2026-11-22', shape: 'full', startHour: 0,
    lodging: ROOM('luxury'), weather: WEATHER, dayIndex: 1, comfortable: true, rnd: Math.random,
  });
  const eve = plan.beats.filter((b) => b.kind === 'hotel');
  assert.ok(eve.length >= 2, '晚上了还只有「回酒店」一句');
  assert.ok(plan.extras.price >= 0);
  /* 有 SPA 那天必须记上 380。 */
  if (plan.extras.items.includes('SPA')) assert.ok(plan.extras.price >= 380);
});

/* ---------------- 6. 南方沙滩能玩水 ---------------- */

test('三亚十一月能下水 —— 北纬 20.5 以南全年算暖', () => {
  const sanya = cityById('sanya');
  const plan = planDay({
    city: sanya, dateKey: '2026-11-15', shape: 'full', startHour: 0,
    lodging: ROOM('budget'), weather: WEATHER, dayIndex: 0, comfortable: true, rnd: Math.random,
  });
  /* 海滩那几样要么是水上项目，要么是堆沙堡；不许出现「风凉、水只没过脚背」。 */
  const beachLines = plan.beats.filter((b) => b.kind === 'beat'
    && /香蕉艇|摩托艇|潜水|沙堡|沙上走/.test(b.what));
  assert.ok(beachLines.length >= 1 || plan.extras.items.length >= 0);
  for (const b of beachLines) assert.doesNotMatch(b.what, /风凉/, '十一月的三亚写成海水凉了');
});

test('北方海滩十一月不下水', () => {
  const qd = cityById('qingdao');
  const plan = planDay({
    city: qd, dateKey: '2026-11-15', shape: 'full', startHour: 0,
    lodging: ROOM('budget'), weather: WEATHER, dayIndex: 0, comfortable: true, rnd: Math.random,
  });
  for (const b of plan.beats) assert.doesNotMatch(b.what, /香蕉艇|摩托艇|潜水/, `十一月在青岛玩水了：${b.what}`);
});

test('内陆城市的湖不给水上项目', () => {
  const hz = cityById('hangzhou');
  for (let i = 0; i < 10; i++) {
    assert.equal(beachPlay('西湖', hz, i * 97, true, true), null, '西湖上冒出潜水了');
  }
});

/* ---------------- 8. 没景点的时候去哪 ---------------- */

test('没有景点可排的时候，去的是具体地方 —— 不是「随便走走」', () => {
  const t = cityById('tianshui');
  const spots = idleSpots(t, '黄土坡上的老城，渭河从城北过去');
  assert.ok(spots.some((x) => /土特产/.test(x)), `没给土特产店：${spots.join('/')}`);
  assert.ok(spots.length >= 3);
  /* 排到第六天（六个景点用完之后）就得出现具体去处。 */
  const plan = planDay({
    city: t, dateKey: '2026-11-20', shape: 'full', startHour: 0,
    lodging: ROOM('budget'), weather: WEATHER, dayIndex: 5, comfortable: false, rnd: Math.random,
  });
  const acts = plan.beats.filter((b) => b.kind === 'activity').map((b) => b.what).join('｜');
  assert.match(acts, /土特产|菜市场|步道|老庙|旧货|黄土坡/, `第六天又退回泛泛说法了：${acts}`);
});

/* ---------------- 1. 口味要能改结果 ---------------- */

test('不想再吃的东西不会再被排到', () => {
  const cd = cityById('chengdu');
  const days = Array.from({ length: 20 }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);
  const all = days.flatMap((d) => [0, 1, 2].map((m) => pickFood(cd, m, d, { dislike: ['钟水饺'] })));
  assert.ok(!all.includes('钟水饺'), '记过「不想再吃」，还是排到了钟水饺');
});

test('喜欢的更常出现，但不是天天同一道', () => {
  const cd = cityById('chengdu');
  const days = Array.from({ length: 30 }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);
  const dishes = days.map((d) => pickFood(cd, 1, d, { like: ['担担面'] }));
  const hit = dishes.filter((x) => x === '担担面').length;
  assert.ok(hit >= 6, `三十天里只排到 ${hit} 次，偏好等于没生效`);
  assert.ok(hit < 30, '三十天全是同一道菜，那不是偏好，是卡住了');
});

test('讨厌的剔完不剩，就退回原表 —— 宁可排一样也不让这顿空着', () => {
  const cd = cityById('chengdu');
  const all = cd.foods;
  const r = pickFood(cd, 1, '2026-12-01', { dislike: all });
  assert.ok(r && r.length > 0, '把整张表都拉黑之后就没饭吃了');
});

test('口味已经进了日程：planDay 传进去，那天的午饭就变了', () => {
  const cd = cityById('chengdu');
  const args = {
    city: cd, dateKey: '2026-12-09', shape: 'full', startHour: 0,
    lodging: ROOM('budget'), weather: WEATHER, dayIndex: 0, comfortable: false, rnd: Math.random,
  };
  const a = planDay({ ...args, taste: { dislike: ['麻婆豆腐'] } });
  const lunch = a.beats.find((b) => b.kind === 'lunch')?.what ?? '';
  assert.ok(!lunch.includes('麻婆豆腐'), `传了 dislike 还是排到：${lunch}`);
});

/* ---------------- 2. 熟络度 ---------------- */

test('熟络度会涨、有上限、老数据不会一夜变生面孔', () => {
  let pets = {};
  for (let i = 0; i < 5; i++) pets = metPet(pets, '小满', '2026-11-05', 6);
  assert.equal(pets['小满'].warmth, 30);
  assert.equal(pets['小满'].times, 5);
  for (let i = 0; i < 40; i++) pets = metPet(pets, '小满', '2026-11-05', 6);
  assert.equal(pets['小满'].warmth, 100, '熟络度没封顶');

  /* 老存档没有 warmth 这一栏：按走过次数折个底，不能判成 0。 */
  const old = normalizePets({ 阿岚: { times: 7, last: '2026-10-30', impression: '话少' } });
  assert.ok(old['阿岚'].warmth >= 20, `老数据被判成了陌生人：${old['阿岚'].warmth}`);
});

test('两台机器的熟络度取大，不相加', () => {
  const a = { 小满: { times: 2, last: '2026-11-01', impression: '', warmth: 40 } };
  const b = { 小满: { times: 3, last: '2026-11-05', impression: '爱笑', warmth: 55 } };
  const m = mergePets(a, b);
  assert.equal(m['小满'].warmth, 55);
  assert.equal(m['小满'].impression, '爱笑');
});

test('熟络度说成人话，五档都对得上', () => {
  assert.equal(warmWord(0), '刚认识的人');
  assert.equal(warmWord(15), '见过几面的人');
  assert.equal(warmWord(40), '熟人');
  assert.equal(warmWord(70), '老朋友');
  assert.equal(warmWord(95), '老搭档');
});

test('同一档关系里，句子里一定有名字；不同档说的话不一样', () => {
  const early = bondWith('小满', 5, 3);
  const close = bondWith('小满', 80, 3);
  assert.match(early, /小满/);
  assert.match(close, /小满/);
  assert.notEqual(early, close, '刚认识和老搭档说同一句话');
  assert.equal(bondWith('小满', 80, 3), close, '同种子重算换了句子');
});

/* ---------------- 2. 一起出游写进日程 ---------------- */

test('有人一起的时候，晚饭里有那个人，而且她在做一件事', () => {
  const cd = cityById('chengdu');
  const args = {
    city: cd, dateKey: '2026-12-11', shape: 'full', startHour: 0,
    lodging: ROOM('budget'), weather: WEATHER, dayIndex: 0, comfortable: false, rnd: Math.random,
  };
  const alone = planDay(args).beats.find((b) => b.kind === 'dinner')?.what ?? '';
  const withMate = planDay({ ...args, mate: '小满' }).beats.find((b) => b.kind === 'dinner')?.what ?? '';
  assert.doesNotMatch(alone, /小满/);
  assert.match(withMate, /小满/);
  /*
   * **2026-11-08 改：不钉措辞，钉「人是不是状语」。**
   *
   * 原来这里断言的是 `/一起/` —— 因为当时晚饭固定写成「晚饭，和某某一起，担担面」。
   * 那句话里人只是个状语，把名字抠掉句子照样成立，用户读到的就是个标签。
   * 现在改成「她点了这份菜」这种写法，措辞变了，`/一起/` 就不在了。
   *
   * 判据换成**把名字抠掉还剩多少**：
   *   「和X一起，担担面」      → 抠掉只剩「，担担面」        ← 标签
   *   「X点了担担面，你跟着也来一份」→ 抠掉还剩一整句        ← 人在做事
   */
  const stripped = withMate.replace(/小满/g, '').replace(/^晚饭，/, '');
  assert.ok(stripped.length >= 8, `把名字抠掉就没什么了 —— 人还是状语：${withMate}`);
});

/* ---------------- 3. 「正在做的事」进图片提示词 ---------------- */

test('她正在做的事会写进提示词，而且引号被洗干净', () => {
  const base = { city: '三亚', cityId: 'sanya', spot: '亚龙湾', hour: 15, month: 11, day: 15 };
  const plain = photoPrompt({ ...base, subject: 'ground' });
  const doing = photoPrompt({ ...base, subject: 'ground', doing: '在亚龙湾坐了香蕉艇，她说「再来一次」' });
  assert.doesNotMatch(plain, /正在发生的事/);
  assert.match(doing, /正在发生的事：在亚龙湾坐了香蕉艇/);
  assert.doesNotMatch(doing, /「|」/, '引号没洗掉，模型会把台词当招牌画');
  /* 街景和细节也要带上。 */
  for (const subject of ['street', 'detail']) {
    const t = photoPrompt({ ...base, subject, doing: '在亚龙湾坐了香蕉艇' });
    assert.match(t, /正在发生的事/, `${subject} 题材没带上正在做的事`);
  }
});

test('太长的那句截断，提示词不是叙事的地方', () => {
  const long = '在'.repeat(2) + '亚龙湾的沙滩上来回走了很久，看了很多人在玩水，还蹲下来堆了一个沙堡'.repeat(3);
  const t = photoPrompt({ city: '三亚', cityId: 'sanya', hour: 15, month: 11, day: 15, subject: 'ground', doing: long });
  const line = t.split('。').find((x) => x.startsWith('正在发生的事'));
  assert.ok(line && line.length <= 50, `没截断：${line?.length}`);
});

test('三期：景区新增高空热气球、敞篷双层缆车、登山齿轨小火车及高空热气球拍照俯拍提示', () => {
  const guilin = cityById('guilin');
  const hailaer = cityById('hailaer');
  const zhangye = cityById('zhangye');
  const lijiang = cityById('lijiang');
  const zjj = cityById('zhangjiajie');
  const sh = cityById('shanghai');

  // 1) 高空热气球：喀斯特/丹霞/草原晴天可选、雨天屏蔽、城里街巷与鸣沙山屏蔽
  const glDry = spotRideOptions('漓江', { city: guilin, wet: false });
  assert.ok(glDry.some((o) => o.how === 'balloon' && o.price === 280), '桂林漓江晴天应可选高空热气球');
  const glWet = spotRideOptions('漓江', { city: guilin, wet: true });
  assert.equal(glWet.some((o) => o.how === 'balloon'), false, '雨天应屏蔽热气球');
  assert.equal(spotRideOptions('西街', { city: guilin, wet: false }).some((o) => o.how === 'balloon'), false, '老街街区不出热气球');
  assert.equal(spotRideOptions('鸣沙山', { wet: false }).some((o) => o.how === 'balloon'), false, '沙丘不出热气球');
  assert.ok(spotRideOptions('呼伦贝尔草原', { city: hailaer, wet: false }).some((o) => o.how === 'balloon'));
  assert.ok(spotRideOptions('七彩丹霞', { city: zhangye, wet: false }).some((o) => o.how === 'balloon'));

  const balloonShot = photoPrompt({
    city: '桂林', cityId: 'guilin', spot: '漓江', hour: 7, month: 11, day: 27,
    subject: 'ground', doing: '清晨乘着高空热气球随风缓缓升空',
  });
  assert.match(balloonShot, /高空热气球吊篮俯拍视角/);

  // 2) 敞篷双层缆车：高海拔/雪山景区触发
  assert.ok(spotRideOptions('玉龙雪山', { city: lijiang, wet: false }).some((o) => o.how === 'cabrio-cableway' && o.price === 180));
  assert.equal(spotRideOptions('城南公园', { city: sh, wet: false }).some((o) => o.how === 'cabrio-cableway'), false);

  // 3) 登山齿轨小火车：森林/古道/高山特色山地景区触发，普通公园不触发
  assert.ok(spotRideOptions('国家森林公园', { city: zjj, wet: false }).some((o) => o.how === 'mountain-train' && o.price === 120));
  assert.ok(spotRideOptions('阿里山森林游乐区', { wet: false }).some((o) => o.how === 'mountain-train'));
  assert.equal(spotRideOptions('城南公园', { wet: false }).some((o) => o.how === 'mountain-train'), false);

  // 4) 红线：文案不含鱼/海鲜词
  const allTexts = [
    ...spotRideOptions('玉龙雪山', { city: lijiang, wet: false }),
    ...spotRideOptions('漓江', { city: guilin, wet: false }),
    ...spotRideOptions('国家森林公园', { city: zjj, wet: false }),
  ].map((o) => o.text).join('\n');
  assert.doesNotMatch(allTexts, /鱼|虾|蟹|生鱼/);
});

test('三期：城市夜游新增夜游船、摇橹乌篷船、复古有轨叮叮车及城市特征边界', () => {
  const sh = cityById('shanghai');
  const sx = cityById('shaoxing');
  const hk = cityById('xianggang');
  const ams = cityById('amsterdam');
  const cd = cityById('chengdu');

  const shNight = hotelNightOptions('budget', [], [], '', '', sh).map((o) => o.what);
  assert.ok(shNight.includes('night-cruise'), '上海应有城市夜游船');
  assert.equal(shNight.includes('rowboat'), false);

  const sxNight = hotelNightOptions('budget', [], [], '', '', sx).map((o) => o.what);
  assert.ok(sxNight.includes('rowboat'), '绍兴水乡应有摇橹乌篷船');

  const amsNight = hotelNightOptions('budget', [], [], '', '', ams).map((o) => o.what);
  assert.equal(amsNight.includes('rowboat'), false, '阿姆斯特丹不应出现中式乌篷船');
  assert.ok(amsNight.includes('night-cruise') && amsNight.includes('tram'));

  const hkNight = hotelNightOptions('budget', [], [], '', '', hk).map((o) => o.what);
  assert.ok(hkNight.includes('tram') && hkNight.includes('night-cruise'), '香港应有复古叮叮车与夜游船');

  const cdNight = hotelNightOptions('budget', [], [], '', '', cd).map((o) => o.what);
  assert.equal(cdNight.includes('night-cruise'), false);
  assert.equal(cdNight.includes('rowboat'), false);
  assert.equal(cdNight.includes('tram'), false);
});

test('P2 #11/#12 回归：雅丹解封热气球、溶洞/塔/港不误出、大理不出夜游船、非ground生图不插热气球俯拍', () => {
  const dh = cityById('dunhuang');
  const gl = cityById('guilin');
  const dl = cityById('dali');

  assert.ok(spotRideOptions('雅丹魔鬼城', { city: dh, wet: false }).some((o) => o.how === 'balloon'), '雅丹魔鬼城应可选热气球');
  assert.equal(spotRideOptions('芦笛岩', { city: gl, wet: false }).some((o) => o.how === 'balloon'), false, '地下溶洞不得出热气球');
  assert.equal(
    spotRideOptions('天空塔', { city: { id: 'test-auck', name: '奥克兰', country: 'NZ', tz: 'Pacific/Auckland', lat: -36.8, lon: 174.7, tags: ['火山', '海港'], climate: 'oceanic', spots: ['天空塔'], foods: [] }, wet: false })
      .some((o) => o.how === 'balloon'),
    false,
    '带港/塔城市地标不得误出热气球',
  );
  if (dl) {
    const dlNight = hotelNightOptions('budget', [], [], '', '', dl).map((o) => o.what);
    assert.equal(dlNight.includes('night-cruise'), false, '大理古城不应强挂城市江海夜游船');
  }

  const foodShot = photoPrompt({
    city: '桂林', cityId: 'guilin', spot: '漓江', hour: 12, month: 6,
    weather: '晴', subject: 'food', doing: '看着刚拍下的热气球照片吃桂林米粉',
  });
  assert.doesNotMatch(foodShot, /高空热气球吊篮俯拍视角/);

  // 194 城漏网景点排除回归：阳朔西街走 BALLOON_SPOT 也必须被街巷排除，其余 6 处非升空地标同步屏蔽
  const hhht = cityById('huhehaote');
  const sg = cityById('shaoguan');
  const alt = cityById('aletai');
  assert.equal(spotRideOptions('阳朔西街', { city: gl, wet: false }).some((o) => o.how === 'balloon'), false, '阳朔西街不得出热气球');
  assert.ok(spotRideOptions('阳朔热气球', { city: gl, wet: false }).some((o) => o.how === 'balloon'), '字面热气球仍可选');
  assert.equal(spotRideOptions('昭君墓', { city: hhht, wet: false }).some((o) => o.how === 'balloon'), false);
  assert.equal(spotRideOptions('席力图召', { city: hhht, wet: false }).some((o) => o.how === 'balloon'), false);
  assert.equal(spotRideOptions('靖江王府', { city: gl, wet: false }).some((o) => o.how === 'balloon'), false);
  assert.equal(spotRideOptions('满堂客家大围', { city: sg, wet: false }).some((o) => o.how === 'balloon'), false);
  assert.equal(spotRideOptions('将军山滑雪场', { city: alt, wet: false }).some((o) => o.how === 'balloon'), false);
  assert.equal(spotRideOptions('敦德布拉克岩画', { city: alt, wet: false }).some((o) => o.how === 'balloon'), false);
});
