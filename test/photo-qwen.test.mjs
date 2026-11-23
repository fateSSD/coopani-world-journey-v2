/**
 * 千问（百炼 / Token Plan）生图 —— 2026-11-23
 *
 * ## 起因
 *
 * GitHub Discussion #586 里 lyb-ai 问：「生图设置的千问 api 格式
 * `…/api/v1/services/aigc/multimodal-generation/generation` 这个不支持吗？」
 *
 * 不支持，而且不是「地址填错了」那种不支持 —— 三处都不一样：
 *
 *   路径   `/images/generations` → `/api/v1/services/aigc/multimodal-generation/generation`
 *   请求体 `{model, prompt, size}` → `{model, input:{messages:[…]}, parameters:{size:"1024*1024"}}`
 *   返回   `data[0]` → `output.choices[0].message.content[0].image`
 *
 * 这三条各自都会**静默**出错：404、400、和「返回里没有图」—— 图生成了、额度扣了，
 * 用户看到的是「拍不出来」。所以三处都要有断言钉住，而且钉在真实形状上
 * （官方文档的示例响应，不是我编的）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { shootPhoto, firstImage } = await import('../src/photo.ts');
const { resolveImageBackend } = await import('../src/image-backend.ts');

/** 1×1 的 PNG。`sniffImage` 只看文件头，够用。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URI = `data:image/png;base64,${PNG_B64}`;

const QWEN_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

/** 官方示例响应（只把图换成一个能验的地址）。 */
const okPayload = (image = 'https://dashscope-result-sh.oss-cn-shanghai.aliyuncs.com/xxx.png?Expires=1') => ({
  output: {
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ image }] } }],
  },
  usage: { output_height: 1024, output_width: 1024, output_image_count: 1 },
  request_id: 'd025a3d3-b07f-49e1-bdc8-6793f4929xxx',
});

function fakeFetch(handler) {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    return handler(calls.length, body, String(url));
  };
  return { calls, restore: () => { globalThis.fetch = prev; } };
}

/** 生图请求回 JSON，下载图片那条回 PNG 字节。 */
const jsonThenPng = (image) => (n) => (n === 1
  ? new Response(JSON.stringify(okPayload(image)), { status: 200, headers: { 'content-type': 'application/json' } })
  : new Response(Buffer.from(PNG_B64, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } }));

/* ---------------- 后端解析 ---------------- */

test('服务商选千问：协议切到 qwen，地址只到域名', () => {
  const b = resolveImageBackend({ imageProtocol: 'openai', imagePreset: 'qwen' });
  assert.equal(b.protocol, 'qwen', '没切到千问协议 —— 后面会按 /images/generations 拼地址，404');
  assert.equal(b.api, 'https://dashscope.aliyuncs.com', '地址不能带 /api/v1，否则会拼出两条路径');
  assert.equal(b.model, 'qwen-image-3.0-pro');
  assert.equal(b.size, '1024x1024');
  assert.match(b.note, /千问/);
});

test('手填地址优先：Token Plan 只改地址这一栏', () => {
  /*
   * Token Plan 和百炼的 model 名字一样，差别只在域名。
   * 如果他填了地址，预设不许把它盖掉。
   */
  const b = resolveImageBackend({
    imageProtocol: 'openai',
    imagePreset: 'qwen',
    imageApi: 'https://token-plan.maas.qianwenaiapi.com',
  });
  assert.equal(b.api, 'https://token-plan.maas.qianwenaiapi.com');
  assert.equal(b.protocol, 'qwen', '换了地址就不是千问了？协议只看预设，不看地址');
});

test('协议说 ComfyUI 时，选了千问也还是本地 —— 两个字段不许自相矛盾', () => {
  const b = resolveImageBackend({ imageProtocol: 'comfyui', imagePreset: 'qwen' });
  assert.equal(b.protocol, 'comfyui');
});

/* ---------------- 请求 ---------------- */

test('千问的地址、请求体都是它自己那一套', async () => {
  const { calls, restore } = fakeFetch(jsonThenPng());
  try {
    await shootPhoto({
      api: 'https://dashscope.aliyuncs.com',
      protocol: 'qwen',
      key: 'sk-sp-test',
      model: 'qwen-image-3.0-pro',
      prompt: '成都的傍晚，街上刚下过雨',
      size: '1024x1024',
    });
    assert.equal(calls[0].url, QWEN_URL, '地址拼错了');

    const body = calls[0].body;
    assert.equal(body.model, 'qwen-image-3.0-pro');
    assert.equal(body.input.messages[0].role, 'user');
    assert.equal(body.input.messages[0].content[0].text, '成都的傍晚，街上刚下过雨',
      '提示词必须躺在 input.messages[].content[].text 里，顶层 prompt 它不认');
    assert.equal('prompt' in body, false, '顶层 prompt 是 OpenAI 那条的写法，别混进来');
    assert.equal('response_format' in body, false, '千问的 response_format 在 parameters 里，顶层发它是多余的');
    assert.equal(body.parameters.size, '1024*1024', '尺寸要用星号：1024x1024 它会当成非法值');
  } finally { restore(); }
});

test('地址栏被贴了整条接口也不重复拼 —— 别让人因为多贴一段就 404', async () => {
  const { calls, restore } = fakeFetch(jsonThenPng());
  try {
    await shootPhoto({ api: QWEN_URL, protocol: 'qwen', key: 'k', prompt: 'p' });
    assert.equal(calls[0].url, QWEN_URL);
  } finally { restore(); }
});

/* ---------------- 返回 ---------------- */

test('返回从 output.choices[0].message.content[0].image 取，并自己把图下回来', async () => {
  const { calls, restore } = fakeFetch(jsonThenPng());
  try {
    const out = await shootPhoto({ api: 'https://dashscope.aliyuncs.com', protocol: 'qwen', key: 'k', prompt: 'p' });
    assert.equal(calls.length, 2, '应该只有「生成」和「下载」两次请求');
    assert.match(calls[1].url, /^https:\/\/dashscope-result/, '没去下载那张图');
    assert.equal(out.mime, 'image/png');
    assert.equal(out.bytes.length, Buffer.from(PNG_B64, 'base64').length);
  } finally { restore(); }
});

test('firstImage 认得千问那层嵌套（它原来会把 output 当数组，穿过去返回空）', () => {
  const got = firstImage(okPayload('https://x/y.png'));
  assert.deepEqual(got, { url: 'https://x/y.png' });
});

test('网关把 response_format 改成 b64_json 时回的是 Data URL —— 也要认', async () => {
  /*
   * 千问 `parameters.response_format: 'b64_json'` 时，图的写法是
   * 把整条 Data URL 塞进 `image` 字段，**不是** `b64_json` 字段。
   * 我们默认不要 b64_json（2.x 会报 InvalidParameter），但账号默认值
   * 被改过时撞上的就是这个形状 —— 认不出来就等于白扣一次额度。
   */
  const { calls, restore } = fakeFetch(() => new Response(
    JSON.stringify(okPayload(PNG_DATA_URI)),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  try {
    const out = await shootPhoto({ api: 'https://dashscope.aliyuncs.com', protocol: 'qwen', key: 'k', prompt: 'p' });
    assert.equal(calls.length, 1, 'Data URL 不该再发一次下载请求');
    assert.equal(out.mime, 'image/png');
  } finally { restore(); }
});

/* ---------------- 失败 ---------------- */

test('尺寸不合法：摘掉 parameters.size 重发一次，不是原地重试', async () => {
  /*
   * 官方规定总像素 512×512 – 2048×2048。用户从豆包切过来时，尺寸栏里
   * 很可能还是 2048x2048 以上或者别的算法 —— 让它报错、退一步用模型自己
   * 推荐的分辨率，比连发三次同样的坏尺寸强。
   */
  const { calls, restore } = fakeFetch((n) => (n === 1
    ? new Response(JSON.stringify({ code: 'InvalidParameter', message: 'size must be within 512*512 to 2048*2048' }), { status: 400 })
    : new Response(JSON.stringify(okPayload()), { status: 200, headers: { 'content-type': 'application/json' } })));
  try {
    const out = await shootPhoto({ api: 'https://dashscope.aliyuncs.com', protocol: 'qwen', key: 'k', prompt: 'p', size: '4096x4096' });
    /* 三次：第一次被拒、第二次重发成功、第三次把图下回来。 */
    assert.equal(calls.length, 3);
    assert.ok('parameters' in calls[0].body && 'size' in calls[0].body.parameters);
    assert.equal('parameters' in calls[1].body, false, '重发时必须整段不带 parameters，而不是只删 size 留个空对象');
    assert.equal(out.mime, 'image/png');
  } finally { restore(); }
});

test('404 要说清地址该填到哪儿 —— 只说 not found 等于没说', async () => {
  const { restore } = fakeFetch(() => new Response('not found', { status: 404 }));
  try {
    await assert.rejects(
      () => shootPhoto({ api: 'https://dashscope.aliyuncs.com/v1', protocol: 'qwen', key: 'k', prompt: 'p' }),
      /只填域名/,
    );
  } finally { restore(); }
});

test('千问这条暂不发参考图，但要如实标记 refsDropped', async () => {
  /*
   * 千问的图生图是另一套 content 结构，字段名没验证过 —— 发过去要么 400，
   * 要么被静默忽略（用户以为图鉴生效了，画面里却换了个人）。所以先不发，
   * 但必须把「没生效」告诉上层，不能装作发过了。
   */
  const { calls, restore } = fakeFetch(jsonThenPng());
  try {
    const out = await shootPhoto({
      api: 'https://dashscope.aliyuncs.com',
      protocol: 'qwen',
      key: 'k',
      prompt: 'p',
      refs: [PNG_DATA_URI],
    });
    const body = calls[0].body;
    const content = body.input.messages[0].content;
    assert.equal(content.length, 1, '参考图不该出现在 content 里');
    assert.equal('image' in body, false, '顶层的 image 字段不是千问的写法');
    assert.equal(out.refsDropped, true);
  } finally { restore(); }
});
