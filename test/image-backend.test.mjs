/**
 * 生图后端：一个下拉切云端 / 本地 —— 2026-11-14
 *
 * Mr.Q 的原话：「最好一个选项点进去 UI 是云端，一个选项点进去 UI 切本地。」
 *
 * 宿主的配置面板没有条件显示，做不到「选了云端就让本地那几项消失」。
 * 能做的是两件，这批断言守的就是这两件：
 *   ① `imageProtocol` 是个下拉，点一下就切；
 *   ② 选了云端服务商就把「地址 / 模型 / 合规尺寸」填好 —— 落地在 `resolveImageBackend`。
 *
 * 还有一条隐含规则：**手填的值永远优先于预设**。预设是兜底，不是覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveImageBackend, liftToMinPixels, presetLabel } = await import('../src/image-backend.ts');

test('老配置（ComfyUI）一个字都不变', () => {
  const b = resolveImageBackend({
    imageProtocol: 'comfyui',
    imageApi: 'http://127.0.0.1:8188',
    imageWorkflow: 'C:/Users/x/Desktop/pet-qwen.json',
    imageSize: '1664x928',
  });
  assert.equal(b.protocol, 'comfyui');
  assert.equal(b.api, 'http://127.0.0.1:8188');
  assert.equal(b.size, '1664x928', '本地尺寸不该被预设动过');
  assert.equal(b.sizeNote, '');
});

test('ComfyUI 没填地址也有个默认值，但会说自己没选 workflow', () => {
  const b = resolveImageBackend({ imageProtocol: 'comfyui' });
  assert.equal(b.api, 'http://127.0.0.1:8188');
  assert.match(b.note, /还没选 workflow/, `没提示缺 workflow：${b.note}`);
});

test('豆包预设：地址与模型自动填好', () => {
  const b = resolveImageBackend({ imageProtocol: 'openai', imagePreset: 'doubao' });
  assert.equal(b.protocol, 'openai');
  assert.equal(b.api, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.match(b.model, /seedream/, `模型没预设上：${b.model}`);
  assert.equal(b.size, '2048x2048');
  assert.match(b.note, /豆包/);
});

test('手填的值优先于预设 —— 预设是兜底，不是覆盖', () => {
  const b = resolveImageBackend({
    imageProtocol: 'openai',
    imagePreset: 'doubao',
    imageApi: 'https://my-proxy.example.com/v1',
    imageModel: 'doubao-seedream-5-0-pro-260628',
  });
  assert.equal(b.api, 'https://my-proxy.example.com/v1');
  assert.equal(b.model, 'doubao-seedream-5-0-pro-260628');
});

test('豆包的最低像素：1024x1024 会被抬上去，比例不变', () => {
  /* 方舟 seedream 5.0 / 4.5 最低 3,686,400 像素，1024² 只有 105 万 —— 必定 400。 */
  const b = resolveImageBackend({
    imageProtocol: 'openai', imagePreset: 'doubao', imageSize: '1024x1024',
  });
  const [w, h] = b.size.split('x').map(Number);
  assert.ok(w * h >= 3_686_400, `没抬够：${b.size} = ${w * h}`);
  assert.ok(Math.abs(w / h - 1) < 0.02, `比例被改了：${b.size}`);
  assert.match(b.sizeNote, /抬到/, '抬了却没说，就是静默改配置');
});

test('已经够大的尺寸不动它', () => {
  const b = resolveImageBackend({
    imageProtocol: 'openai', imagePreset: 'doubao', imageSize: '2560x1440',
  });
  assert.equal(b.size, '2560x1440');
  assert.equal(b.sizeNote, '');
});

test('OpenAI 没有最低像素这一说', () => {
  const b = resolveImageBackend({ imageProtocol: 'openai', imagePreset: 'openai', imageSize: '1024x1024' });
  assert.equal(b.size, '1024x1024');
  assert.equal(b.model, 'gpt-image-1');
});

test('自定义：什么都不预设，缺了什么要说出来', () => {
  const b = resolveImageBackend({ imageProtocol: 'openai', imagePreset: 'custom' });
  assert.equal(b.api, '');
  assert.match(b.note, /地址没填/, `没说缺地址：${b.note}`);
});

test('漏填模型也要说 —— 不然用户只会看到「拍不出来」', () => {
  const b = resolveImageBackend({
    imageProtocol: 'openai', imagePreset: 'custom', imageApi: 'https://x.example.com/v1',
  });
  assert.match(b.note, /模型没填/);
});

test('海报尺寸走 override，不被「出图尺寸」那一栏改掉', () => {
  const b = resolveImageBackend({ imageProtocol: 'openai', imagePreset: 'doubao', imageSize: '2048x2048' }, '1024x1536');
  const [w, h] = b.size.split('x').map(Number);
  assert.ok(h > w, `海报该是竖的：${b.size}`);
  assert.ok(w * h >= 3_686_400, `海报没过最低像素：${b.size}`);
});

test('协议说 ComfyUI 时，预设不影响它 —— 两个字段不许自相矛盾', () => {
  const b = resolveImageBackend({
    imageProtocol: 'comfyui', imagePreset: 'doubao', imageApi: 'http://127.0.0.1:8188',
  });
  assert.equal(b.protocol, 'comfyui', '选了豆包但后端是本地，结果必须是本地');
  assert.equal(b.model, '', 'ComfyUI 的模型写在 workflow 里');
});

test('liftToMinPixels 只放大不缩小', () => {
  const big = '3000x2000';
  assert.deepEqual(liftToMinPixels(big, 3_686_400), { size: big, lifted: false });
  const { size, lifted } = liftToMinPixels('1664x928', 3_686_400);
  assert.equal(lifted, true);
  const [w, h] = size.split('x').map(Number);
  assert.equal(w % 8, 0, '宽没吸附到 8 的倍数');
  assert.equal(h % 8, 0, '高没吸附到 8 的倍数');
});

test('预设名给人看的是中文', () => {
  assert.match(presetLabel('doubao'), /豆包/);
  assert.equal(presetLabel('custom'), '自定义');
  assert.equal(presetLabel(undefined), '自定义');
});

/* ---------------- 配置 schema 自身的合法性 ---------------- */

test('每个带 enum 的配置项，默认值必须在枚举里', async () => {
  /*
   * 2026-11-14 当场踩到：`imagePreset` 的默认值我写成空串 `''`，
   * 而它的 enum 是 `['doubao','openai','custom']` —— 空串不在里面。
   * 宿主拿默认值去校验，用户一保存就弹：
   *
   *   ⚠ 失败：云端服务商 只能是 doubao / openai / custom
   *
   * 报错文本里说的是那个**下拉的名字**，看不出问题出在默认值上，
   * 所以容易被当成「用户填错了」。这条测试守的就是这个坑。
   */
  const { journeyConfigGroups, JOURNEY_DEFAULTS } = await import('../src/config.ts');
  const defaults = JOURNEY_DEFAULTS();
  const bad = [];
  for (const g of journeyConfigGroups()) {
    for (const [key, field] of Object.entries(g.schema.properties ?? {})) {
      if (!Array.isArray(field.enum)) continue;
      const short = key.replace(/^worlds\.journey\./, '');
      const d = defaults[short];
      if (!field.enum.includes(d)) {
        bad.push(`${short} 的默认值 ${JSON.stringify(d)} 不在 ${JSON.stringify(field.enum)} 里`);
      }
    }
  }
  assert.deepEqual(bad, [], `底下列默认值不合法，用户一保存就报「只能是…」：\n${bad.join('\n')}`);
});

test('defaults 里的键都能在 schema 里找到 —— 拼错了没人会发现', async () => {
  /* 拼错的默认值等于没写：读的时候拿不到，字段静默回落成 undefined。 */
  const { journeyConfigGroups, JOURNEY_DEFAULTS } = await import('../src/config.ts');
  /*
   * `enabled` 是 World 自己的开关（`WorldDefinition` 上的），不属于任何一个配置项 ——
   * 它跟 `schema.properties` 本来就不是一张表。除它之外都该对得上。
   */
  const NOT_A_FIELD = new Set(['enabled']);
  /*
   * 生图那 16 项 2026-11-14 从「配置」页搬到了面板的「生图设置」页
   * （Mr.Q：「把配置里面有关生图的条目删除」）。它们不再由 `journeyConfigGroups()`
   * 声明，改由 `panelInvoke('settings', …)` 读写 —— 所以「schema 里找不到」
   * 是**预期**，不是拼错。
   *
   * 白名单逐个写、**不用前缀匹配**：以后新增一个生图字段，忘了接面板也忘了
   * 加进这里，这条断言仍然会抓住它。用 `/^image/` 之类的正则就抓不住了。
   */
  const PANEL_OWNED = new Set([
    'imageProtocol', 'imagePreset', 'imageApi', 'imageModel', 'imageSize',
    'imageWorkflow', 'imagePromptNode', 'imageMinimal', 'imageStyle', 'imageCast',
    'imageWatermark', 'photoDir', 'comfyNegative', 'comfyNegativeNode',
    'imageStyleCast', 'imageCastChance',
    'imageTimeoutSec', 'imageKey',
  ]);
  const declared = new Set();
  for (const g of journeyConfigGroups()) {
    for (const key of Object.keys(g.schema.properties ?? {})) declared.add(key.replace(/^worlds\.journey\./, ''));
  }
  const orphans = Object.keys(JOURNEY_DEFAULTS())
    .filter((k) => !NOT_A_FIELD.has(k) && !PANEL_OWNED.has(k) && !declared.has(k));
  assert.deepEqual(orphans, [], `这些默认值在 schema 里没有对应项：${orphans.join('、')}`);
});
