/**
 * 照片题材 —— 2026-11-06
 *
 * 一位用户报的 bug（原话）：
 * 「无论我提出什么拍摄要求（比如拍晚饭等），都只会生成同一处风景画面，
 *  无法按照我的指令更换拍摄对象和场景。」
 *
 * 根因：工具上只有一个 `view`（ground/sky），他说「拍晚饭」能动的只有「抬不抬头」，
 * 题材一个字都改不了 —— 提示词照样按「城市 + 景点」拼，出来当然还是那处风景。
 *
 * 这一组守两件事：
 *   1. 六个题材真的出六种不同的提示词（不然改了等于没改）
 *   2. 每种都带「人怎么处理」和「不要文字」—— 那两条是硬约束，缺一张就是一张废图
 *
 *      2026-11-12 晚改了口径：景区**要有人气**（Mr.Q：「得有人，景区有人气最好，
 *      就是别太突出了」），所以风景/街景/节日写的是「远处零星几个虚化的人影」，
 *      食物和细节仍然是「画面里没有人物」—— 特写边上站着人是另一张照片。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { photoPrompt } = await import('../src/photo.ts');

const BASE = {
  city: '婺源',
  cityId: 'wuyuan',
  spot: '江岭',
  hour: 19,
  month: 11,
  day: 6,
  cityIdx: 0.8,
};

const subjects = ['ground', 'sky', 'food', 'street', 'festival', 'detail'];

test('六个题材，六种不同的提示词', () => {
  const out = new Map();
  for (const s of subjects) {
    out.set(s, photoPrompt({ ...BASE, subject: s, dish: s === 'food' ? '粉蒸肉' : undefined }));
  }
  const seen = new Set();
  for (const [s, p] of out) {
    assert.equal(seen.has(p), false, `题材 ${s} 和别的题材出了同一句话 —— 那等于没分题材`);
    seen.add(p);
  }
  assert.equal(seen.size, subjects.length);
});

test('每种都交代了人怎么处理，也都有「不要文字」', () => {
  const crowd = new Set(['ground', 'street', 'festival']);
  for (const s of subjects) {
    const p = photoPrompt({ ...BASE, subject: s });
    if (crowd.has(s)) {
      assert.ok(/人影|行人/.test(p), `${s} 该有人气，却一个人都没有：${p}`);
      assert.ok(/看不清脸/.test(p), `${s} 的人没写「看不清脸」，模型会给一张大脸`);
    } else {
      assert.ok(/没有人物/.test(p), `${s} 是特写，边上不该站人：${p}`);
    }
    assert.ok(/文字/.test(p), `${s} 没写「不要文字」—— 中文招牌生成出来必然是乱码`);
  }
});

test('拍吃的：用给的菜名，不泛泛说「当地的饭」', () => {
  const p = photoPrompt({ ...BASE, subject: 'food', dish: '粉蒸肉' });
  assert.ok(p.includes('粉蒸肉'), `没带上菜名：${p.slice(0, 60)}`);
  assert.ok(/碗|盘|锅|蒸笼/.test(p), '没写盛器 —— 「好吃」画不出来，碗才画得出来');
});

test('拍街：按城市档次换要素', () => {
  const metro = photoPrompt({ ...BASE, subject: 'street', cityIdx: 1.3 });
  const county = photoPrompt({ ...BASE, subject: 'street', cityIdx: 0.7 });
  assert.notEqual(metro, county, '一线和县城出的街景一样 —— 那档位没起作用');
  assert.ok(/空调外机|卷帘门|共享单车/.test(metro), '一线老街缺要素');
  assert.ok(/瓷砖|喷绘布|电动车/.test(county), '县城缺要素');
});

/*
 * 2026-11-11 加。这条原名叫「按城市档次换要素，**不写景点**」——
 * 而断言里一个字都没验过景点，名字把「街景只写城市」当成了设计。
 *
 * 用户来信戳破的正是这件事：「所有照片都是同一个特色建筑，不管在哪个景点」。
 * 查下来 `streetPrompt` **从头到尾没读过 `scene.spot`**，标题句是
 * `${city}的街` —— 在文殊院和在锦里发出去的是同一条提示词。
 *
 * 现在景点是位置锚（街长什么样仍由地区决定，这没错），所以标题句要带上它。
 */
test('拍街：景点名要进提示词，否则同一个城里所有街拍都是同一张', () => {
  const a = photoPrompt({ ...BASE, spot: '文殊院', subject: 'street' });
  const b = photoPrompt({ ...BASE, spot: '锦里', subject: 'street' });
  assert.notEqual(a, b, '同城两个景点出了同一条提示词 —— 又退回「只写城市」了');
  assert.ok(a.includes('文殊院'), `文殊院没进提示词：${a.slice(0, 40)}`);
  assert.ok(b.includes('锦里'), `锦里没进提示词：${b.slice(0, 40)}`);

  // 没有景点时退回城市，不能因此崩掉或者留个空
  const bare = photoPrompt({ ...BASE, spot: '', subject: 'street' });
  assert.ok(/的街/.test(bare) && !/undefined/.test(bare), `无景点时退化不对：${bare.slice(0, 40)}`);
});

test('拍街：机位和两条硬约束不能是死代码', () => {
  /*
   * 2026-11-11 抓到的：`return \`…\`;` 后面跟了一行 `+ \`…\`;`，
   * 分号让 return 提前结束，那行成了孤立的单目正号表达式，**永远不执行**。
   * 于是街景从来没写过「没有人」「不要文字」，也没写过机位。
   * 编译器不拦这种错（`+x` 合法），只有这里能拦。
   */
  const p = photoPrompt({ ...BASE, subject: 'street' });
  assert.ok(/35mm/.test(p), '街景缺机位那一句 —— 大概又是 return 后面跟 + 的死代码');
  assert.ok(/人影|行人|没有人物/.test(p));
  assert.ok(/文字/.test(p));
  assert.ok(!/NaN/.test(p), '拼接把字符串变成 NaN 了 —— 多打了一个 +');
});

test('拍节日：按日期算，不是随机', () => {
  const spring = photoPrompt({ ...BASE, subject: 'festival', month: 2, day: 5 });
  const midautumn = photoPrompt({ ...BASE, subject: 'festival', month: 9, day: 18 });
  assert.ok(/灯笼|春联|红纸|剪纸/.test(spring), `春节没出春节的东西：${spring.slice(0, 50)}`);
  assert.ok(/月饼|月亮/.test(midautumn), `中秋没出中秋的东西：${midautumn.slice(0, 50)}`);
});

test('拍细节：同一天同一个，不会一会儿这样一会儿那样', () => {
  const a = photoPrompt({ ...BASE, subject: 'detail' });
  const b = photoPrompt({ ...BASE, subject: 'detail' });
  assert.equal(a, b);
  // 换一天就该换一样东西（不然相册里全是同一张特写）
  const list = new Set();
  for (let d = 1; d <= 12; d++) list.add(photoPrompt({ ...BASE, subject: 'detail', day: d }));
  assert.ok(list.size >= 4, `十二天里只出了 ${list.size} 种特写，太少了`);
});

test('sky 认 subject：抬头拍天才会有「抬起来」', () => {
  const g = photoPrompt({ ...BASE, subject: 'ground' });
  const s = photoPrompt({ ...BASE, subject: 'sky' });
  assert.equal(g.includes('抬起来'), false, 'ground 不该说抬头');
  assert.equal(s.includes('抬起来'), true, 'subject=sky 没说抬头 —— 那和风景一模一样');
});

test('不传 subject 时行为和以前完全一样', () => {
  const legacy = photoPrompt({ ...BASE });
  const explicit = photoPrompt({ ...BASE, subject: 'ground' });
  assert.equal(legacy, explicit, '不传 subject 走了别的分支 —— 老调用方会被悄悄改掉');
});

/* ---------------- 顺序就是权重（2026-11-11） ---------------- */

/*
 * Mr.Q：「后台提示词要给前端用户写入的提示词让路，前端为主后台做辅助。」
 *
 * 原来 `describe` 排在「地点 + 锚点 + 光」之后，`focus` 更靠后（硬约束前面）。
 * 沃兔贴出来的提示词一眼能看出：一长串系统描述铺在前面，真正「她看到什么」
 * 那句挤在中段 —— 模型按前面那串画，人写的等于备注。
 *
 * 现在的顺序：lead → 她写的画面 → 用户改的怎么拍 → 系统（地点/锚点/光/季节）→ 硬约束。
 */
test('她写的画面排在系统描述前面', () => {
  const p = photoPrompt({ ...BASE, subject: 'ground', describe: '石阶上蹲着一只橘猫' });
  const cat = p.indexOf('橘猫');
  const city = p.indexOf('婺源');
  assert.ok(cat >= 0, '她写的那句丢了');
  assert.ok(city >= 0);
  assert.ok(cat < city, `人的话排在地点之后了 —— 顺序没让路：${p.slice(0, 80)}`);
});

test('用户写的「怎么拍」紧跟在她写的画面之后，仍早于系统描述', () => {
  const p = photoPrompt({ ...BASE, subject: 'ground', describe: '石阶上蹲着一只橘猫', focus: '蹲低一点' });
  const cat = p.indexOf('橘猫');
  const focus = p.indexOf('蹲低一点');
  const city = p.indexOf('婺源');
  assert.ok(cat < focus && focus < city, `顺序不对：橘猫@${cat} focus@${focus} 地点@${city}`);
});

test('硬约束永远在最后一句', () => {
  const p = photoPrompt({ ...BASE, subject: 'ground', describe: '一只猫', focus: '蹲低' });
  const tail = p.slice(-40);
  assert.ok(/没有文字|没有人/.test(tail), `硬约束被挤到中间了：${tail}`);
});

/* ---------------- 极简模式（2026-11-11） ---------------- */

/*
 * 用户沃兔拿豆包做的对照实验，方向跟我这些天做的相反：
 *
 *   「我在豆包**只写地名和景点、不加其它提示词**的话，出现的就是正常的景点照片，
 *     建筑也能对上。」
 *
 * 本机同 workflow 同种子复现过（seed 42）：
 *
 * | 地方 | 完整 131-176 字 | 极简 28 字 |
 * |---|---|---|
 * | 成都文殊院 | 木构青瓦的「街」（被「街巷两侧」带偏） | 大殿重檐 + 石阶 + 古树 = **寺院** |
 * | 泉州清净寺 | 花岗岩墙 + 尖拱门 + 燕尾脊 | 燕尾脊红砖庙宇 = **中式寺，全错** |
 *
 * 差别在**模型认不认识这个地方**。所以极简砍的是「一座城的平均长相」（城市锚点），
 * 留的是「这个地方到底什么样」（景点锚点）—— 下面这组就是钉这个分工。
 */

test('极简模式：只写地名和光，长度砍到完整版的三分之一以下', () => {
  const full = photoPrompt({ ...BASE, subject: 'ground' });
  const min = photoPrompt({ ...BASE, subject: 'ground', minimal: true });
  assert.ok([...min].length < [...full].length / 3, `没瘦下来：极简 ${[...min].length} / 完整 ${[...full].length}`);
  assert.ok([...min].length <= 90, `极简还太长：${[...min].length} 字 —— ${min}`);
});

test('极简模式：不带城市锚点、不带季节、不带机位', () => {
  const min = photoPrompt({ ...BASE, subject: 'ground', minimal: true });
  // 婺源的城市锚点里有「徽派民居」这类话，极简不该出现
  assert.ok(!/徽派|马头墙|粉墙黛瓦/.test(min), `城市锚点混进来了：${min}`);
  // 季节句
  assert.ok(!/银杏|梧桐|潮湿|灰白低云/.test(min), `季节句混进来了：${min}`);
  // 机位与风格套话
  assert.ok(!/自然随手拍|35mm|胶片质感/.test(min), `机位/风格套话混进来了：${min}`);
});

test('极简模式：景点自己的锚点要留着 —— 模型不认识的地方全靠它', () => {
  const min = photoPrompt({ city: '泉州', cityId: 'quanzhou', spot: '清净寺', subject: 'ground', hour: 15, month: 11, minimal: true });
  assert.ok(/花岗岩/.test(min), `景点锚点被砍了，模型只能按「寺」字画中式庙宇：${min}`);
  assert.ok(/泉州/.test(min) && /清净寺/.test(min), '地名丢了');
});

test('极简模式：没有专属锚点的景点就真的只发地名', () => {
  // 文殊院没有 SPOT_LOOK 条目 —— 这条正是本机画出「寺院」的那张
  const min = photoPrompt({ city: '成都', cityId: 'chengdu', spot: '文殊院', subject: 'ground', hour: 16, month: 11, minimal: true });
  assert.ok(/成都文殊院/.test(min));
  assert.ok(!/青瓦木构|竹林|街巷/.test(min), `城市锚点没砍干净：${min}`);
  assert.ok([...min].length <= 40, `这条应该只有二十来字：${min}`);
});

test('极简模式：时段和天气必须留 —— 不写会把夜里画成白天', () => {
  const night = photoPrompt({ ...BASE, subject: 'ground', hour: 23, minimal: true });
  assert.match(night, /深夜/, `没写时段：${night}`);
  const rainy = photoPrompt({ ...BASE, subject: 'ground', hour: 15, weather: '小雨', minimal: true });
  assert.match(rainy, /小雨/, `没写天气：${rainy}`);
});

test('极简模式 v2：抬头看天和在路上也统一走极简，带真实天象或车窗外视角且不带多余行人', () => {
  const skyMin = photoPrompt({ ...BASE, subject: 'sky', hour: 22, minimal: true });
  assert.match(skyMin, /婺源上空，抬头看天/, `极简天空没说抬头看天：${skyMin}`);
  assert.match(skyMin, /满天星|星|云|夜里/, `极简天空丢了真实天象：${skyMin}`);
  assert.doesNotMatch(skyMin, /随手拍|三脚架长曝|噪点明显|地平线.*一道/, `极简天空混进了详细模式套话：${skyMin}`);
  assert.match(skyMin, /没有人物，没有文字。$/);

  const roadMin = photoPrompt({ ...BASE, onRoad: true, mode: '火车', hour: 15, minimal: true });
  assert.match(roadMin, /火车上往外看，前往婺源途中/, `极简路上没写车窗外视角：${roadMin}`);
  assert.doesNotMatch(roadMin, /远处散着几个很小的行人|田野、村庄和路/, `极简路上不该有行人或长模板：${roadMin}`);
  assert.match(roadMin, /没有人物，没有文字。$/);
});

test('极简模式：硬约束仍然在，一条都不能少', () => {
  const min = photoPrompt({ ...BASE, subject: 'ground', minimal: true });
  assert.match(min, /人影|行人|没有人物/, '极简模式没交代人怎么处理 —— 模型会塞一个正对镜头的陌生人');
  assert.match(min, /没有文字/, '不写「没有文字」，中文招牌会糊成乱码');
  assert.ok(!/NaN|undefined/.test(min), `拼接出错了：${min}`);
});

/*
 * ============================================================
 * 人和硬约束不能打架（2026-11-20，读者报的两条）
 *
 * 「画面里没有人物」原来是写在食物 / 小物模板里的死句子，而「这张有没有她」
 * 是另一条路算出来的。两条撞上，模型一边看到参考图里的脸、一边被告知画面里没有人 ——
 * 出来就是「有时画她有时不画」，多张参考图还会复制出两个她。
 * ============================================================ */

test('食物和小物：有人那张不许再写「画面里没有人物」', () => {
  for (const s of ['food', 'detail']) {
    const withCast = photoPrompt({ ...BASE, subject: s, dish: s === 'food' ? '粉蒸肉' : undefined, cast: '一个穿米色风衣的女孩' });
    assert.doesNotMatch(withCast, /没有人物/, `${s} 有人却说没人：${withCast}`);
    assert.match(withCast, /画面里有一个人：一个穿米色风衣的女孩/, `${s} 没把人物描述写进去`);
    assert.match(withCast, /只有这一个人/, `${s} 没拦住多画人`);

    /* 参考图那条路同理：外观交给图，但存在性约束要在。 */
    const fromRef = photoPrompt({ ...BASE, subject: s, dish: s === 'food' ? '粉蒸肉' : undefined, castFromRef: true });
    assert.doesNotMatch(fromRef, /没有人物/, `${s} 带参考图却说没人：${fromRef}`);
    assert.match(fromRef, /只有这一个人/);
    assert.match(fromRef, /参考图为准/);

    /* 没人的那张一个字不动 —— 默认行为不能被这次改动带走。 */
    const none = photoPrompt({ ...BASE, subject: s, dish: s === 'food' ? '粉蒸肉' : undefined });
    assert.match(none, /没有人物/, `${s} 没人时该照旧写没有人物`);
  }
});

test('街景和节日：她出镜时不能一句不提她，人气也不能丢', () => {
  for (const s of ['street', 'festival']) {
    const p = photoPrompt({ ...BASE, subject: s, castFromRef: true });
    assert.match(p, /只有这一个人/, `${s} 带参考图却没说她是谁：${p}`);
    assert.match(p, /其余的人只在远处|看不清脸/, `${s} 把她出镜写成了空街：${p}`);
  }
});

test('参考图只管脸，不管衣服 —— 不能一张图锁死全程的服装', () => {
  /*
   * 原来那句是「保持脸型、发型与服装一致」。参考图一给，她穿同一件衣服
   * 拍遍十几座城。她要的是**同一个人**，不是同一套衣服。
   */
  for (const s of ['ground', 'food', 'street']) {
    const p = photoPrompt({ ...BASE, subject: s, dish: s === 'food' ? '粉蒸肉' : undefined, castFromRef: true });
    assert.doesNotMatch(p, /与服装一致|服装一致/, `${s} 还在锁服装：${p}`);
    assert.match(p, /脸型|五官/, `${s} 没把脸交给参考图`);
    assert.match(p, /衣着按这一张/, `${s} 没交代衣服跟当次描述走`);
  }
});
