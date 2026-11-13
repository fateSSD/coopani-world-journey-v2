/**
 * 视觉锚点 + workflow 选文件。
 *
 * 视觉锚点是一百多条人工写的内容，最容易出的问题是「漏了几个城市」和
 * 「某条悄悄写超长」—— 两种都不会报错，只会让某几张照片莫名其妙地不像。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { CITIES, VISTA, vistaOf } = await import('../src/geo/cities.ts');
const { photoPrompt } = await import('../src/photo.ts');
const { parseWorkflow } = await import('../src/comfy.ts');

test('每个城市都有一条视觉锚点，长度在 20–45 字之间', () => {
  const missing = [];
  const tooLong = [];
  const tooShort = [];
  for (const c of CITIES) {
    const v = VISTA[c.id];
    if (!v) { missing.push(c.name); continue; }
    const n = [...v].length;
    if (n < 20) tooShort.push(`${c.name}(${n})`);
    if (n > 45) tooLong.push(`${c.name}(${n})`);
  }
  assert.deepEqual(missing, [], `这些城市没有视觉锚点：${missing.join('、')}`);
  assert.deepEqual(tooShort, [], `太短，等于没说：${tooShort.join('、')}`);
  assert.deepEqual(tooLong, [], `太长，会盖过场景描述：${tooLong.join('、')}`);
});

test('锚点表里没有多余的城市 id', () => {
  const ids = new Set(CITIES.map((c) => c.id));
  const extra = Object.keys(VISTA).filter((id) => !ids.has(id));
  assert.deepEqual(extra, [], `VISTA 里有已经不存在的城市：${extra.join('、')}`);
});

test('锚点不许写评价词 —— 模型会把它当风格指令，出来一片糖水', () => {
  const BAN = ['很美', '令人惊叹', '别具风情', '充满异国情调', '值得一去', '如画'];
  const hits = [];
  for (const [id, v] of Object.entries(VISTA)) {
    for (const b of BAN) if (v.includes(b)) hits.push(`${id}: ${b}`);
  }
  assert.deepEqual(hits, [], hits.join('；'));
});

test('提示词里用上了视觉锚点（这是「像不像那地方」的关键）', () => {
  const p = photoPrompt({
    city: '九寨沟', cityId: 'jiuzhaigou', spot: '甘海子', hour: 10,
  });
  assert.match(p, /九寨沟的甘海子/, '地点名丢了');
  assert.match(p, /钙化池/, `锚点没进提示词：${p}`);
});

test('查不到锚点就只用地名，绝不编一个', () => {
  // 新增城市但忘了补锚点时，行为要可预期：退化成旧行为，而不是瞎写。
  const p = photoPrompt({ city: '某个新城', cityId: 'not-exist', spot: '某处', hour: 10 });
  assert.match(p, /某个新城的某处/);
  assert.equal(vistaOf('not-exist'), '');
  assert.equal(vistaOf(undefined), '');
});

test('路上的照片不加城市锚点 —— 那时候拍的是窗外，套上去会让它硬画一座城', () => {
  const p = photoPrompt({
    city: '九寨沟', cityId: 'jiuzhaigou', hour: 10, onRoad: true, mode: '火车',
  });
  assert.match(p, /火车上往外看/);
  assert.doesNotMatch(p, /钙化池/, `路上的照片带了城市锚点：${p}`);
});

test('workflow 可以填文件路径（设置页那个「选择文件」存的是路径）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  const p = join(dir, 'my-workflow.json');
  writeFileSync(p, JSON.stringify({ '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } } }), 'utf8');
  const wf = parseWorkflow(p);
  assert.ok(wf['6'], '路径没被读成 workflow');
});

test('路径打不开时，要说清是文件的问题，不是 JSON 的问题', () => {
  // 用户点了「选择文件」但后来把文件删了/移走了，报「JSON 不合法」会让他去查格式。
  assert.throws(
    () => parseWorkflow('D:/不存在的目录/workflow.json'),
    /打不开|选择文件/,
    '路径失效时说错了方向',
  );
});

test('配置描述是纯文本 —— 设置页不解析 markdown', async () => {
  /*
   * 2026-11-04 Mr.Q 发来截图：描述里显示着两个星号本身。
   *
   * 那个界面是纯文本的，「碰面」那一条原本写的是 **不填＝照常旅行**，
   * 用户看到的就是 `**不填＝照常旅行**`。同一个坑我自己又踩了一次
   * （workflow 那条写了「**点右边按钮**」）。所以加一条测试兜住。
   */
  const { journeyConfigGroups } = await import('../src/config.ts');
  const bad = [];
  for (const g of journeyConfigGroups()) {
    const props = g.schema?.properties ?? {};
    for (const [key, def] of Object.entries(props)) {
      const d = String(def?.description ?? '');
      const hit = /\*\*|\[[^\]]+\]\([^)]+\)|^#{1,6}\s/m.test(d);
      if (hit) bad.push(`${key}: ${d.slice(0, 50)}…`);
    }
  }
  assert.deepEqual(bad, [], `这些描述里有 markdown，设置页会原样显示：\n${bad.join('\n')}`);
});

test('人物设定默认必须是空 —— 照片默认拍风景，不拍人', async () => {
  /*
   * 2026-11-04 Mr.Q：「照片出不出人这点，麻烦设成默认为空值」。
   *
   * 这条守的是**默认值**，不是配置里那个值：装了扩展什么都不填时，
   * 拍出来应该是一张空镜风景，而不是每张都站着一个人。
   * 想让人出镜得自己去填 —— 默认带人才是那个意外。
   */
  const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
  assert.equal(JOURNEY_DEFAULTS().imageCast, '', '默认值不是空 —— 新装的用户会莫名拍到人');
});

/* ---------------- 同城别的景点不能进提示词（2026-11-11） ---------------- */

/*
 * 用户来信（沃兔，拿豆包实测两次）：
 *
 *   「删除掉『周围红砖白石…开元寺有石塔两座，街巷榕树遮顶…』这段提示词，
 *     就能输出正常的照片。这段提示词有点意义不明，**我的鱼没去过开元寺**，
 *     但每段提示词都会强调这个。」
 *
 * 这是**编造**，比「权重压过景点」严重。锚点要留（像不像那地方全靠它），
 * 但里面有别的景点的专名时，那不是地域特征，是另一个地方。
 */

test('锚点里同城别的景点要剔掉，地貌要留着', () => {
  // 泉州锚点原本是「红砖白石…；开元寺有石塔两座，街巷榕树遮顶」
  const atQingjing = photoPrompt({ city: '泉州', cityId: 'quanzhou', spot: '清净寺', hour: 10, month: 11 });
  assert.ok(!/开元寺/.test(atQingjing), `她人在清净寺，提示词里却有开元寺：${atQingjing}`);
  assert.match(atQingjing, /红砖白石|燕尾|榕树/, '把地貌一起剔掉了 —— 那是「像不像那地方」的根');

  // 九寨沟的钙化池不是别的景点，必须留住
  const atJiuzhai = photoPrompt({ city: '九寨沟', cityId: 'jiuzhaigou', spot: '甘海子', hour: 10, month: 11 });
  assert.match(atJiuzhai, /钙化池/, '钙化池是地貌不是地标，不该跟着被剔');
});

/*
 * 2026-11-11 全量重写后，这两条从「抽查泉州」升级成**全局检查**。
 *
 * 原来测的是「泉州锚点含开元寺、keep 传开元寺时不剔除」——
 * 而泉州那条已经重写（不再含开元寺），断言自动失效，挂了。
 * 更要紧的是：当时「锚点里写着本城景点名」的条目有 **40 条**，
 * 逐城抽查根本守不住 —— 以后有人补一条城市，也该自动被拦住。
 */
test('锚点里不许出现本城景点名 —— 写了就会画进这座城的每一张照片', () => {
  const bad = [];
  for (const c of CITIES) {
    const v = vistaOf(c.id);
    for (const s of c.spots ?? []) {
      if (s.length >= 2 && v.includes(s)) bad.push(`${c.name}:${s}`);
    }
  }
  assert.equal(
    bad.length, 0,
    `这些锚点还写着本城景点名，会被画进每一张照片：${bad.slice(0, 8).join('、')}`,
  );
});
