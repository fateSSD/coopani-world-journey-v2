/**
 * 地点类型：让「敦煌博物馆」不再建在沙丘里 —— 2026-11-14
 *
 * Mr.Q 原话：「敦煌市明明是个市，敦煌博物馆却建在沙漠里非常离谱」，
 * 并且指出方向：「让她能够完全按照自己看到了什么为主去生成图片，
 * 而不是靠我们自己一个一个去补充」。
 *
 * 根因不是那句话写错了，是结构：没有景点锚点时**退回城市锚点**，
 * 而城市锚点是「整座城的平均长相」—— 敦煌那条里就有「出城就是连片沙丘」。
 * `SPOT_LOOK` 只有 60 城 136 条，`CITIES` 是 185 城 × 3–9 个点，覆盖率约 15%，
 * 剩下 85% 全在这条路上。所以这批断言守的是**结构**，不是某一句文案。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { photoPrompt } = await import('../src/photo.ts');
const { spotProfile, trimVistaFor } = await import('../src/geo/spot-profile.ts');

const dh = (over) => photoPrompt({
  city: '敦煌', cityId: 'dunhuang', month: 11, day: 9, hour: 15, subject: 'ground', ...over,
});

test('敦煌博物馆：周边不许出现沙丘、沙脊、戈壁', () => {
  const t = dh({ spot: '敦煌博物馆' });
  assert.doesNotMatch(t, /沙丘|沙脊|戈壁|沙漠/, `博物馆的周边还是沙漠：${t}`);
});

test('敦煌博物馆：室内被说出来（不说就会被画成外立面）', () => {
  const t = dh({ spot: '敦煌博物馆' });
  assert.match(t, /室内/, `没告诉她这是室内：${t}`);
});

test('室内：连「周边一带」都不拼，也看不见城外的房子', () => {
  const t = dh({ spot: '敦煌博物馆' });
  assert.doesNotMatch(t, /周边一带/, `室内还挂着「周边一带」：${t}`);
  assert.doesNotMatch(t, /平顶房|葡萄架|白杨/, `展厅里看得见城外的房子：${t}`);
  assert.doesNotMatch(t, /沙丘|沙脊|戈壁|沙漠/, `博物馆的周边还是沙漠：${t}`);
});

test('室内：不写天、不写季节（那些东西站在屋里看不到）', () => {
  const t = dh({ spot: '敦煌博物馆' });
  assert.doesNotMatch(t, /薄云|天往浅里退|西边/, `室内写了天：${t}`);
  assert.doesNotMatch(t, /胡杨|榆树|地面是干土|河面不冻/, `室内写了野外季节：${t}`);
});

test('市区的非室内点：周边照旧，只砍野外那半截', () => {
  /* 党河风情线是街区，本来就在城里逛 —— 周边该留着，沙丘该砍掉。 */
  const t = dh({ spot: '党河风情线' });
  assert.match(t, /绿洲|平顶房|白杨/, `把整个城市锚点一起丢了：${t}`);
  assert.doesNotMatch(t, /沙丘|沙脊/, `沙丘没砍掉：${t}`);
});

test('她自己写了画面时，不塞系统形制 —— 以她看到的为主', () => {
  const plain = dh({ spot: '敦煌博物馆' });
  const hers = dh({ spot: '敦煌博物馆', describe: 'a low concrete building with glass doors' });
  assert.match(plain, /室内/, '前提：不写 describe 时是有形制的');
  assert.doesNotMatch(hers, /展柜和展墙/, `她写了画面还被塞了模板：${hers}`);
  assert.match(hers, /low concrete building/, '她写的那句必须原样在里面');
});

test('野外的地方不受影响：雅丹魔鬼城照旧有地貌', () => {
  const t = dh({ spot: '雅丹魔鬼城' });
  assert.match(t, /土台|垄岗/, `雅丹自己的锚点被裁了：${t}`);
});

test('有专属锚点的点一个字都不动', () => {
  const t = dh({ spot: '莫高窟' });
  assert.match(t, /赭黄砂砾岩崖面|洞窟/, `莫高窟的锚点丢了：${t}`);
  assert.doesNotMatch(t, /周边一带/, '有锚点就不该走「周边一带」那条');
});

test('只拍城市（没有具体景点）照旧用城市锚点', () => {
  const t = dh({});
  assert.match(t, /沙丘|绿洲/, `只拍城市时锚点不该被裁：${t}`);
  assert.doesNotMatch(t, /周边一带/, '没有景点就不该出现「周边一带」');
});

test('极简模式不受影响', () => {
  const t = photoPrompt({
    city: '敦煌', cityId: 'dunhuang', spot: '敦煌博物馆',
    month: 11, day: 9, hour: 15, subject: 'ground', minimal: true,
  });
  assert.doesNotMatch(t, /绿洲|平顶房/, `极简模式不该带城市锚点：${t}`);
});

/* ---- 类型判定：专名里的字不许当类别 ---- */

test('后缀比包含可靠：山/河/湾里的字不算数', () => {
  /* 第一版按「包含」判，这四个全错，是拿 1510 个真实地点跑出来才看见的。 */
  assert.equal(spotProfile('中山桥').kind, 'bridge', '中山桥不该是山');
  assert.equal(spotProfile('黄河楼').kind, 'tower', '黄河楼不该是水');
  assert.equal(spotProfile('大地湾遗址').kind, 'ruins', '大地湾遗址不该是湾');
  assert.equal(spotProfile('莫高窟').kind, 'cave', '莫高窟该是石窟');
});

test('魔鬼城不是城，也不是关隘', () => {
  assert.equal(spotProfile('雅丹魔鬼城').kind, 'geology');
  assert.equal(spotProfile('玉门关').kind, 'fort');
});

test('括号里的补充说明不参与判定', () => {
  /* 「沙湖（石嘴山平罗县…）」里的「石嘴山」差点让它变成山 */
  assert.equal(spotProfile('沙湖（石嘴山平罗县，单算半天）').kind, 'water');
});

test('判不出就返回空，不猜', () => {
  /* 空档的后果只是走老行为；猜错才出坏图。 */
  assert.equal(spotProfile('禾木村').kind, '');
  assert.equal(spotProfile('鼓浪屿').kind, '');
  assert.equal(spotProfile('').kind, '');
});

test('裁锚点时，野外描写一旦开始就砍到结尾', () => {
  /* 逐句剔会漏掉「沙脊锋利」—— 它是沙丘那一句的下半截。 */
  const vista = '党河两岸是窄绿洲，三四层土黄与灰白平顶房，出城就是连片沙丘，沙脊锋利。';
  const out = trimVistaFor(vista, spotProfile('敦煌博物馆'));
  assert.doesNotMatch(out, /沙丘|沙脊/, `砍漏了：${out}`);
  assert.match(out, /平顶房/, `砍多了：${out}`);
});

test('裁完只剩零星几个字就整句不拼', () => {
  const out = trimVistaFor('出城就是连片沙丘。', spotProfile('敦煌博物馆'));
  assert.equal(out, '', '残句比不写更糟，模型会拿它当主体');
});
