/*
 * 真实酒店数据（2026-11-09）。
 *
 * 起因是 Mr.Q 那句话：「你就让子agent去查查 185 座城市的酒店呗，
 * 把它有什么设施、活动都全部查清楚嘛，以后别再返工了。我也不差那点 token。」
 *
 * 这个文件守的是**数据与规则的一致性**，不是具体某家店 ——
 * 店名和价格会随季节变动，用具体店名做断言，过两个月就假红了。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { factsFor, hasFacts } = await import('../src/geo/hotel-facts.ts');
const { realFeel } = await import('../src/plan/lodging.ts');
const { CITIES } = await import('../src/geo/cities.ts');

const lcg = (seed) => {
  let x = seed >>> 0;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
};

test('真实数据：中国主要城市都查得到店', () => {
  /*
   * 覆盖率的底线。实测（2026-11-09）：185 城里 177 城有数据，
   * 差的是 7 个俄罗斯城市 + 库特纳霍拉 —— TourMind 对那几处没开库存。
   *
   * 这里只钉几个「不能没有」的城市，不钉覆盖率 —— 上游补数据是好事，
   * 钉成具体数字反而会挡着以后变好。
   */
  for (const id of ['chengdu', 'lanzhou', 'xian', 'tokyo', 'newyork']) {
    assert.ok(hasFacts(id), `${id} 没有真实酒店数据`);
    assert.ok(factsFor(id).length >= 3, `${id} 只有 ${factsFor(id).length} 家，太少`);
  }
});

test('真实数据：每家店都有名字，没有空壳', () => {
  for (const c of CITIES.slice(0, 40)) {
    for (const f of factsFor(c.id)) {
      assert.ok(f.name && f.name.trim(), `${c.id} 有一条没名字的记录`);
      assert.ok(typeof f.cost === 'number' || f.cost === null, 'cost 类型不对');
    }
  }
});

test('分档按价格：同一城 luxury 的价格不低于 dingy', () => {
  /*
   * 这是 2026-11-09 改的核心 —— 分档原来按 `star_rating`，实测那个字段错标严重：
   * 纽约康拉德标 0 星（13677 元），福州某店标 5 星（111 元）。
   * 按星级分的结果是「1826 元的银座酒店住进小破店档」。
   *
   * 现在按同城价格分位。判据：**贵的不能比便宜的档位低。**
   */
  let checked = 0;
  for (const c of CITIES) {
    const facts = factsFor(c.id);
    if (facts.length < 6) continue;
    const byTier = {};
    for (const f of facts) {
      if (!f.tier || f.cost === null) continue;
      (byTier[f.tier] ??= []).push(f.cost);
    }
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    if (byTier.luxury && byTier.dingy) {
      assert.ok(
        avg(byTier.luxury) >= avg(byTier.dingy),
        `${c.name}：豪华档均价 ${Math.round(avg(byTier.luxury))} 低于小破店档 ${Math.round(avg(byTier.dingy))}`,
      );
      checked++;
    }
  }
  assert.ok(checked >= 20, `只核了 ${checked} 座城，样本太少，测试没起作用`);
});

test('真实设施：有泳池的店，描述里才出现泳池', () => {
  /*
   * 反向也要守：**没查到的店不许提**。
   *
   * 上一次返工就是这一条 ——「温泉度假酒店」+「房间里带私汤」挂在二钻宾馆上，
   * 而那家店的设施清单里只有餐厅和停车场。
   */
  let saidPool = 0;
  let saidOnsen = 0;
  for (const c of CITIES) {
    for (const f of factsFor(c.id)) {
      if (!f.amen?.length) continue;
      const feel = realFeel(f, 'luxury', lcg(11));
      if (!f.amen.includes('pool')) assert.doesNotMatch(feel, /泳池/, `${f.name} 没有泳池数据却写了泳池`);
      if (!f.amen.includes('onsen')) assert.doesNotMatch(feel, /温泉/, `${f.name} 没有温泉数据却写了温泉`);
      if (f.amen.includes('pool')) saidPool++;
      if (f.amen.includes('onsen')) saidOnsen++;
    }
  }
  assert.ok(saidPool > 0, '一家有泳池的都没找到 —— 要么数据空了，要么 key 对不上');
});

test('真实设施：描述里提到的每一项设施，都必须有数据支撑', () => {
  /*
   * 这是整个改造的要害，比「有泳池才能说泳池」更严 ——
   * **说出口的每一个设施词，都要能在 `amen` 里找到对应的 key。**
   *
   * 2026-11-09 踩过一次：抓取脚本存了英文 key 和中文标签两份，我接错了那份，
   * 结果设施句永远不生成。当时那条「不许提没有的」是绿的 ——
   * 「一句都不说」当然不会提到没有的。所以要**双向**守。
   */
  const WANT = [
    ['pool', /泳池/],
    ['onsen', /温泉/],
    ['spa', /桑拿/],
    ['gym', /健身房/],
    ['restaurant', /餐厅|早餐/],
    ['bar', /酒吧/],
    ['meeting', /会议室/],
    /* 收紧：`洗衣粉味` 不是「有洗衣服务」，误报过一次。 */
    ['laundry', /能洗衣|洗衣服务|洗衣服/],
    ['parking', /停车/],
  ];
  let spoke = 0;
  for (const c of CITIES) {
    for (const f of factsFor(c.id)) {
      for (const tier of ['luxury', 'view', 'budget', 'dingy']) {
        const feel = realFeel(f, tier, lcg(9));
        for (const [key, re] of WANT) {
          if (!re.test(feel)) continue;
          assert.ok(
            (f.amen ?? []).includes(key),
            `${f.name} 的设施数据里没有 ${key}，描述却说到了：${feel}`,
          );
          spoke++;
        }
      }
    }
  }
  assert.ok(spoke > 0, '一条设施描述都没生成 —— 数据没接上');
});

test('挂真名时不许有人身攻击 —— 这是上次「温泉私汤」的另一面', () => {
  /*
   * 2026-11-09 抽样读出来：dingy 档挂着「天水皇冠假日酒店」，描述是
   * 「床单上有一块洗不掉的印子」。
   *
   * 不挂名时那是「这类地方」的想象，没问题；挂了真名就是**在说人家床单脏**。
   * 判据：挂在真名后面的每个字，都是对那家店的指控或背书。
   */
  const SLANDER = /洗不掉的印子|老式插销|灯有一半不亮|发霉|蟑螂|脏/;
  for (const c of CITIES) {
    for (const f of factsFor(c.id)) {
      for (const tier of ['luxury', 'view', 'budget', 'dingy']) {
        const feel = realFeel(f, tier, lcg(3));
        assert.doesNotMatch(feel, SLANDER, `${f.name}（${tier}）的描述在指责店家：${feel}`);
      }
    }
  }
});

test('周边：只按距离说事，不把英文地名塞进中文句子', () => {
  /*
   * 上游给的景点名是英文（`Tianfu Square`、`People's Park`）。
   * 直接拼进中文句子会变成「出门拐个弯就是 Tianfu Square」——
   * 半截外语，比不说更怪。
   *
   * 所以只说「类别 + 走多久」。这条守住「别哪天有人加了一句点名」。
   */
  let checked = 0;
  for (const c of CITIES) {
    for (const f of factsFor(c.id)) {
      if (!f.around?.length) continue;
      const feel = realFeel(f, 'budget', lcg(5));
      /* 英文短语 = 两个以上连续英文单词 */
      assert.doesNotMatch(feel, /[A-Za-z]{3,}\s+[A-Za-z]{3,}/, `${f.name} 的描述里混进了英文地名：${feel}`);
      checked++;
    }
  }
  assert.ok(checked > 0, '一家带周边数据的都没有，测试没起作用');
});

test('周边：距离越远，话说得越含糊', () => {
  const near = realFeel({ amen: [], around: [{ n: 'X Square', km: 0.3 }] }, 'budget', lcg(1));
  const mid = realFeel({ amen: [], around: [{ n: 'X Square', km: 1.2 }] }, 'budget', lcg(1));
  const far = realFeel({ amen: [], around: [{ n: 'X Square', km: 8 }] }, 'budget', lcg(1));

  assert.match(near, /拐个弯/, `600 米内说得不对：${near}`);
  assert.match(mid, /走十来分钟/, `1.2 公里说得不对：${mid}`);
  assert.match(far, /偏|没什么可逛/, `8 公里说得不对：${far}`);
});

test('降级：城市没有真实数据时返回空，不抛错', () => {
  /*
   * 那 8 个 TourMind 没开库存的城市（喀山、伊尔库茨克…）走的就是这条路 ——
   * 退回「只挂类别、不挂名字」，而不是崩掉或者编一家。
   */
  assert.deepEqual(factsFor('__not_a_city__'), []);
  assert.equal(hasFacts('__not_a_city__'), false);
  /*
   * 2026-11-10 改：原来拿喀山当反例（TourMind 没开库存）。
   * 现在喀山有数据了 —— 问道补了 23 家店（只有店名和星级，没房价）。
   * 反例换成确实不存在的 id，这才是这条断言真正要守的东西：
   * **拿不到数据时返回空，不是崩，也不是编。**
   */
  assert.deepEqual(factsFor('__nope__'), [], '不存在的城市应返回空');
  /* 喀山现在有 2 家（问道），但**没有房价** —— 这条要一直成立，否则就是伪造。 */
  const kazan = factsFor('kazan');
  assert.ok(kazan.length > 0, '喀山现在应该有问道补的店');
  assert.ok(kazan.every((h) => h.cost === null), `问道补的店不许带价格：${JSON.stringify(kazan[0])}`);
});

/* ---------------------------------------------------------------- 本地夜去处 */

test('夜去处：采到的城市够多，且每条都能读成一句话', async () => {
  /*
   * 数据是携程问道采的（185/185 城，分两天补完），原始回答留在 `tools/.play-inbox.txt`。
   * 这里守两件事：**量够**、**没有解析残留**。
   *
   * 解析残留是这类「模型自由文本 → 结构化」最容易出的问题：
   * 尖括号、半角竖线、`[object Object]`，都会原样进到她的台词里。
   */
  const { playSpots } = await import('../src/geo/city-play.ts');
  let cities = 0;
  let spots = 0;
  for (const c of CITIES) {
    const list = playSpots(c.id);
    if (!list.length) continue;
    cities++;
    for (const s of list) {
      spots++;
      assert.ok(s.n && s.n.trim(), `${c.id} 有一条没有地名`);
      assert.ok(s.d && s.d.trim(), `${c.id} 有一条没有说明`);
      assert.doesNotMatch(s.n + s.d, /[<>《》|]/, `${c.id} 有解析残留：${s.n}｜${s.d}`);
      assert.doesNotMatch(s.n + s.d, /object Object|undefined|NaN/, `${c.id} 有脏值：${s.n}`);
    }
  }
  /*
   * 门槛定在 140：问道有每日调用上限（30 次/天），最后 23 城是分两天补的。
   * 钉太高会挡住「今天又补了几城」这种好事，钉太低则形同虚设。
   */
  assert.ok(cities >= 140, `只有 ${cities} 城有夜去处，太少`);
  assert.ok(spots >= cities * 2, `平均不到 2 处/城：${spots}/${cities}`);
});

test('夜去处：没有数据的城市退回 city.night，不编', async () => {
  const { playSpots } = await import('../src/geo/city-play.ts');
  /*
   * 2026-11-10 改：原来拿喀山当「采不到」的例子，现在 185 城全补上了。
   * 反例换成不存在的 id —— 守的还是那一件事：**没数据就返回空，不编。**
   */
  assert.deepEqual(playSpots('__nope__'), []);
  assert.deepEqual(playSpots('__not_a_city__'), []);
});
