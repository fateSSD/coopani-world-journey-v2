/**
 * 同伴事件和好感度联动（2026-11-08，1.0.5）。
 *
 * ## 反馈原话
 *
 * Mr.Q：「em，这些事件可以和好感度系统联动起来嘛」
 *
 * 在那之前六个函数里只有 `bondWith` 看 warmth，其余五个不管关系深浅用同一个池子 ——
 * 第一天刚约上就会说「这趟出来值了，下次还来」，那是老搭子的话。
 *
 * ## 这条测试守什么
 *
 * 1. **关系浅时说不出熟话** —— warmth 0 / 12 下，那些 36 分才该出口的句子一句都不许出现；
 * 2. **关系深了真会说** —— warmth 60 下一个都不出现，说明门槛标完就没人抽得到，联动等于没接；
 * 3. **关系越深，一天提到对方的次数越多** —— 这是第二处联动（`odds` 的系数）；
 * 4. **同一档里重算稳定** —— warmth 收成台阶就是为了这个，不收的话 ±6 分会让句子在重算时变。
 */
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { cityById } = await import('../src/geo/cities.ts');
const { planDay } = await import('../src/plan/dayplan.ts');
const { warmthStep } = await import('../src/mate-talk.ts');

const ROOM = { tier: 'comfort', kind: '中档酒店', price: 480, feel: '干净、位置好' };
const WEATHER = { dayWeather: '晴', nightWeather: '晴', wet: false };
const lcg = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const days = (n) => Array.from({ length: n }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);

function plan(cityId, dateKey, warmth, seed = 7) {
  return planDay({
    city: cityById(cityId),
    dateKey,
    shape: 'full',
    startHour: 0,
    lodging: ROOM,
    weather: WEATHER,
    dayIndex: 1,
    comfortable: true,
    mate: '小满',
    warmth,
    rnd: lcg(seed),
  });
}

/** 把一天里所有带同伴的句子拼起来。 */
const mateText = (cityId, dateKey, warmth) =>
  plan(cityId, dateKey, warmth).beats.map((b) => b.what).filter((w) => w.includes('小满')).join('\n');

/**
 * 只在 36 / 60 分才该出现的句子。
 *
 * 挑的是**特征片段**不是整句 —— 整句一改字就失配，碎片能活很久。
 */
const HOT = [
  '一个人来大概就没意思了', // min 36
  '这趟出来值了',           // min 36
  '看跟谁',                 // min 60
];

/** 24 分档的动作：从别人碗里夹、嫌对方手抖、说不想那么早回去。 */
const WARM = [
  '往你碗里夹了一筷',
  '自己不动筷，说怕烫',
  '换过来半碗',
  '手抖了',
  '说不想那么早回去',
];

test('关系浅（warmth 0 / 12）说不出那几句熟话', () => {
  for (const w of [0, 12]) {
    for (const id of ['chengdu', 'xian', 'sanya']) {
      for (const d of days(15)) {
        const text = mateText(id, d, w);
        for (const hot of HOT) {
          assert.doesNotMatch(text, new RegExp(hot), `warmth ${w} 却说出了「${hot}」：\n${text}`);
        }
        for (const hot of WARM) {
          assert.doesNotMatch(text, new RegExp(hot), `warmth ${w} 却说出了「${hot}」：\n${text}`);
        }
      }
    }
  }
});

test('关系深（warmth 60）那几句真的会出现 —— 门槛标完没人抽得到等于没接', () => {
  let hit = 0;
  for (const id of ['chengdu', 'xian', 'sanya', 'lijiang']) {
    for (const d of days(20)) {
      const text = mateText(id, d, 60);
      if (HOT.some((h) => text.includes(h))) hit += 1;
    }
  }
  assert.ok(hit >= 4, `80 天里只有 ${hit} 天出现了 36 分以上的句子，太少`);
});

test('关系越深，一天提到对方的次数越多', () => {
  const avg = (w) => {
    let total = 0;
    let n = 0;
    for (const id of ['chengdu', 'xian', 'sanya', 'lijiang']) {
      for (const d of days(14)) {
        total += plan(id, d, w).beats.filter((b) => b.what.includes('小满')).length;
        n += 1;
      }
    }
    return total / n;
  };
  const cold = avg(0);
  const warm = avg(60);
  /*
   * 判据不是「差不多」，是**有可见的差**：刚碰上的两个人各走各的，
   * 一起走过五趟的几乎每一项都在一起。差得太小等于没做。
   */
  assert.ok(warm - cold >= 0.4, `warmth 0 平均 ${cold.toFixed(2)} 处、60 平均 ${warm.toFixed(2)} 处，差得太小`);
  assert.ok(cold >= 1.8, `warmth 0 一天只剩 ${cold.toFixed(2)} 处，刚认识也不该一句话没有`);
  /* 上限：不能变成「每格都填名字」—— 那是另一个极端。 */
  assert.ok(warm <= 4, `warmth 60 一天 ${warm.toFixed(2)} 处，已经不是一起旅行，是每格填名字`);
});

test('同一档里重算两次一模一样 —— warmth 收成台阶就是为了这个', () => {
  /*
   * 日程会被重建好几次（刷新面板、改酒店、钱紧了）。warmth 在同一天里也会动
   * （接约 +6、到站 +6）—— 按原值比门槛的话，11 跳到 12 就会换一句话，
   * 用户看到的是「刚才那句挺好，刷新一下变了」。
   */
  for (const w of [3, 11, 12, 23, 24, 45, 60, 88]) {
    const a = mateText('chengdu', '2026-12-05', w);
    const b = mateText('chengdu', '2026-12-05', w);
    assert.equal(a, b, `warmth ${w} 重算变了`);
  }
});

test('台阶只在跨档时变：同一档内不同分数，句子一样', () => {
  /*
   * 11 和 12 差一档（0 → 12），允许变；12 和 23 同档（都是 12），必须不变。
   * 这条钉的是「台阶边界」本身 —— 边界写错，上面那条测不出来。
   */
  for (const [a, b] of [[13, 23], [24, 35], [36, 59]]) {
    assert.equal(warmthStep(a), warmthStep(b), `${a} 和 ${b} 该是同一档`);
    assert.equal(
      mateText('chengdu', '2026-12-06', a),
      mateText('chengdu', '2026-12-06', b),
      `同一档（${a} / ${b}）里句子却变了`,
    );
  }
});

/* ============ 记账要按人记，不能拿拼接串当名字（2026-11-11） ============ */

test('多人同行：namesIn 给的是每个人，whoOf 给的是给人看的一整串', async () => {
  const { namesIn, whoOf } = await import('../src/world.ts');
  const p = { withPet: '小满', withPets: ['小满', '小汐', '阿澈'] };

  assert.equal(whoOf(p), '小满、小汐、阿澈', 'whoOf 是句子用的，本来就该拼起来');
  assert.deepEqual(namesIn(p), ['小满', '小汐', '阿澈'], '记账要的是三个独立的名字');

  // 这条才是那个 bug：拿 whoOf 的返回值去记账，等于往记忆里塞一个叫「小满、小汐、阿澈」的人
  assert.ok(!namesIn(p).includes(whoOf(p)), '拼接串不能出现在记账名单里');
});

test('多人同行：老数据没有 withPets 时退回单人', async () => {
  const { namesIn } = await import('../src/world.ts');
  assert.deepEqual(namesIn({ withPet: '小满' }), ['小满']);
  assert.deepEqual(namesIn({ withPet: '小满', withPets: [] }), ['小满'], '空数组不能把人盖掉');
});

test('多人同行：同名的人只算一个，否则 times 会被多加', async () => {
  const { namesIn } = await import('../src/world.ts');
  assert.deepEqual(
    namesIn({ withPet: '小满', withPets: ['小满', '小满', '小汐'] }),
    ['小满', '小汐'],
    '服务端可能回重复的接单记录，去重否则「一起走过 1 次」会变成 3 次',
  );
});

test('多人同行：占位名「一只鱼」不算人', async () => {
  const { namesIn } = await import('../src/world.ts');
  assert.deepEqual(namesIn({ withPet: '一只鱼' }), [], '没名字就是没人，不能记一个叫「一只鱼」的');
});

/* ============ 散伙催她说一句印象（2026-11-11） ============ */

const { impressionAsk } = await import('../src/world.ts');

test('散伙催印象：没写过的人才问，写了的不再催', () => {
  const ask = impressionAsk(['小满', '阿澈'], { 小满: { impression: '' }, 阿澈: { impression: '走路快' } }, 3);
  assert.match(ask, /小满/);
  assert.doesNotMatch(ask, /阿澈/, '已经写过的人不该再被催一次');
});

test('散伙催印象：都写过了就一个字不说', () => {
  assert.equal(impressionAsk(['小满'], { 小满: { impression: '走路快' } }, 3), '');
  assert.equal(impressionAsk([], {}, 3), '');
});

test('散伙催印象：必须给退路，否则她会编一句「好旅伴」', () => {
  const ask = impressionAsk(['小满'], {}, 5);
  assert.match(ask, /没记住就空着/, '没有这条退路，她会为了完成任务硬写一句套话');
  assert.match(ask, /好旅伴/, '要明确点出哪种话不算数');
  assert.match(ask, /这一趟 5 天/);
});

test('散伙催印象：天数缺失或乱填时按 1 天算，不能出「这一趟 0 天」', () => {
  assert.match(impressionAsk(['小满'], {}, 0), /这一趟 1 天/);
  assert.match(impressionAsk(['小满'], {}, Number.NaN), /这一趟 1 天/);
});
