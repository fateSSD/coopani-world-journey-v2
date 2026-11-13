/**
 * ComfyUI 那条生图链路。
 *
 * 分两层：
 *   1. 纯函数（找节点、写提示词、解析 workflow）—— 不发网络，直接喂数据；
 *   2. 端到端 —— 起一个假 ComfyUI，把「提交 → 轮询 → 取图 → 进照片簿」走通。
 *
 * 最要紧的一条断言是**提示词写进了正向、没碰负向**。默认工作流里有两个
 * CLIPTextEncode（正向 6、负面 7），取错了不报错、不崩，只是出来一张黑图 ——
 * 用户会以为是模型的问题，查半天。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { cityById } = await import('../src/geo/cities.ts');
const { parseWorkflow, findPromptNode, withPrompt, firstOutputImage } = await import('../src/comfy.ts');
const { normalizeComfyBase } = await import('../src/comfy.ts');

/** ComfyUI 官方默认 txt2img 的 API 格式（精简，结构一致）：6 正向、7 负向。 */
const DEFAULT_WF = {
  3: { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 8, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'beautiful scenery', clip: ['4', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'text, watermark', clip: ['4', 1] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
};

/* ============================ 纯函数 ============================ */

test('地址：三种填法都收拾成同一个根地址', () => {
  /*
   * 用户从浏览器复制带尾斜杠、从文档复制带 /prompt、或者手打忘了斜杠 ——
   * 三种都会真实发生。不收拾的话请求会打到 /prompt/prompt，回一个 404，
   * 而错误信息不会告诉他是地址多了一段。
   */
  assert.equal(normalizeComfyBase('http://127.0.0.1:8188'), 'http://127.0.0.1:8188');
  assert.equal(normalizeComfyBase('http://127.0.0.1:8188/'), 'http://127.0.0.1:8188');
  assert.equal(normalizeComfyBase('  http://127.0.0.1:8188/prompt/  '), 'http://127.0.0.1:8188');
});

test('workflow：界面格式要当场拒绝，并告诉他点哪个菜单', () => {
  /*
   * ComfyUI 的「Save」导出的是 UI 格式（带 nodes/links），提交给 /prompt 会被拒，
   * 而它的 400 说得含糊。等用户自己去猜「要 API Format」很难，所以这里先说。
   */
  const ui = JSON.stringify({ nodes: [], links: [], version: 0.4 });
  assert.throws(() => parseWorkflow(ui), /API Format/, '界面格式没有指向正确的导出菜单');
  assert.throws(() => parseWorkflow(''), /还没粘/, '空的时候没说清要粘什么');
  assert.throws(() => parseWorkflow('{ 坏掉的'), /不是合法 JSON/, '坏 JSON 没给出可操作的说法');
  assert.throws(() => parseWorkflow('[]'), /顶层应该是一个对象/);
  // 能过的就是 API 格式
  assert.ok(parseWorkflow(JSON.stringify(DEFAULT_WF))['6']);
});

test('找提示词节点：跟着采样器的连线走，不认编号大小', () => {
  assert.equal(findPromptNode(DEFAULT_WF), '6', '默认工作流该认出正向是 6，不是负向的 7');
  /*
   * 把编号对调：正向改成 7、负向改成 6。取「数字小的那个」就会答错 ——
   * 而真实工作流里编号顺序完全取决于用户先放了哪个节点。
   */
  const swapped = {
    3: { class_type: 'KSampler', inputs: { positive: ['7', 0], negative: ['6', 0] } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'worst quality' } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: 'a quiet alley' } },
  };
  assert.equal(findPromptNode(swapped), '7', '编号对调之后跟着连线走才对');
});

test('找提示词节点：中间隔着一层合并节点也能挖到', () => {
  /*
   * 用了 ControlNet / 双提示词的工作流，正向不是直接连到 KSampler 的，
   * 中间会夹 ConditioningCombine。只看 KSampler 的直接输入会找不到。
   */
  const wf = {
    3: { class_type: 'KSampler', inputs: { positive: ['10', 0], negative: ['7', 0] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: 'bad' } },
    10: { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['6', 0], conditioning_2: ['11', 0] } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'harbour at dusk' } },
    11: { class_type: 'CLIPTextEncode', inputs: { text: 'moody' } },
  };
  assert.equal(findPromptNode(wf), '6', '没穿过合并节点');
});

test('找提示词节点：认不出来就返回 null，绝不瞎指一个', () => {
  /*
   * 「猜一个」的代价是把描述写进负向，出来一张黑图且零报错。
   * 返回 null 让上层要求用户填节点 id —— 报错一次，他改一次就好。
   */
  const wf = {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
  };
  assert.equal(findPromptNode(wf), null);
});

test('写提示词：只改指定节点，且不动传进来的那份', () => {
  const before = JSON.stringify(DEFAULT_WF);
  const out = withPrompt(DEFAULT_WF, '6', '兰州的黄河边');
  assert.equal(JSON.stringify(DEFAULT_WF), before, '把入参改了 —— 下一张会带着上一张的文字');
  assert.equal(out['6'].inputs.text, '兰州的黄河边');
  assert.equal(out['7'].inputs.text, 'text, watermark', '负面提示被改了');
});

test('写提示词：SDXL 的长短两份文字都要写', () => {
  // CLIPTextEncodeSDXL 有 text_g / text_l，只写一份出来会缺描述。
  const wf = { 6: { class_type: 'CLIPTextEncodeSDXL', inputs: { text_g: 'g', text_l: 'l' } } };
  const out = withPrompt(wf, '6', '雨后的巷子');
  assert.equal(out['6'].inputs.text_g, '雨后的巷子');
  assert.equal(out['6'].inputs.text_l, '雨后的巷子');
});

test('取结果：history 里挑第一张图，按它自己说的 type 取', () => {
  const h = {
    'pid-1': {
      outputs: {
        9: { images: [{ filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' }] },
        12: { images: [{ filename: 'preview.png', subfolder: 'x', type: 'temp' }] },
      },
    },
  };
  const img = firstOutputImage(h, 'pid-1');
  assert.equal(img.filename, 'ComfyUI_00001_.png');
  // 队列还没跑完时 history 是空的，不能当成失败
  assert.equal(firstOutputImage({}, 'pid-1'), null);
});

/* ============================ 端到端 ============================ */

/**
 * 起一个假的 ComfyUI。
 *
 * `mode`：
 * - `ok`：头两次 /history 返回空（装作还在排队），验轮询真的在等
 * - `reject`：/prompt 回 400 + node_errors
 * - `exec_error`：执行阶段报红
 * - `no_image`：有结果但没有图（workflow 没接 Save Image）
 * - `queued`：永远排队，用来验超时
 */
async function fakeComfy(mode = 'ok') {
  const posted = [];
  const viewed = [];
  let polls = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && url.pathname === '/prompt') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        posted.push(JSON.parse(body || '{}'));
        if (mode === 'reject') {
          res.statusCode = 400;
          json({ error: { message: 'Prompt outputs failed validation' }, node_errors: { 7: { errors: [{ message: 'Required input is missing: clip' }] } } });
          return;
        }
        json({ prompt_id: 'pid-1' });
      });
      return;
    }
    if (url.pathname.startsWith('/history/')) {
      polls += 1;
      const id = url.pathname.split('/').pop();
      if (mode === 'queued') return json({});
      if (polls < 3) return json({});
      if (mode === 'exec_error') {
        return json({ [id]: { status: { status_str: 'error', messages: [['execution_error', { node_type: 'KSampler', exception_message: 'CUDA out of memory' }]] }, outputs: {} } });
      }
      if (mode === 'no_image') return json({ [id]: { status: { status_str: 'success' }, outputs: {} } });
      return json({ [id]: { status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' }] } } } });
    }
    if (url.pathname === '/view') {
      viewed.push(url.search);
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.from(PNG_B64, 'base64'));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    api: `http://127.0.0.1:${server.address().port}`,
    posted,
    viewed,
    polls: () => polls,
    close: () => new Promise((r) => server.close(r)),
  };
}

function fakeHost() {
  const events = [];
  const warns = [];
  return {
    events,
    warns,
    log: { trace() {}, debug() {}, info() {}, warn: (m) => warns.push(String(m)), error: (m) => warns.push(String(m)) },
    pushEvent: async (e) => {
      const blobs = (e.blobs ?? []).map((b, i) => ({ handle: `log:comfy${events.length}-${i}.png`, mime: b.mime, name: b.name }));
      const env = { ...e, blobs };
      events.push(env);
      return env;
    },
    pushDeferred: () => {},
    store: {},
    drainPendingEvents: async () => [],
  };
}

async function makeWorld(cfgOver = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-comfy-'));
  const world = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', ...cfgOver },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date('2026-10-31T12:00:00Z'),
  });
  const host = fakeHost();
  await world.start(host);
  return { world, host, dir };
}

test('ComfyUI：一张照片走到「提交 → 轮询 → 取图 → 进照片簿」', async () => {
  const api = await fakeComfy('ok');
  try {
    const { world, host } = await makeWorld({
      imageProtocol: 'comfyui',
      imageApi: api.api,
      imageWorkflow: JSON.stringify(DEFAULT_WF),
    });
    const r = await world.maybePhoto(cityById('tianshui'), 15, '2026-10-31', '麦积山石窟', null);
    assert.equal(r.ok, true, `没拍成：${r.reason}`);

    assert.equal(api.posted.length, 1, `提交了 ${api.posted.length} 次`);
    const sent = api.posted[0].prompt;
    // 最要紧的一条：写进正向，负面原封不动
    assert.match(sent['6'].inputs.text, /麦积山石窟/, '提示词没写进正向节点');
    /*
     * 2026-11-12 晚：`people` 那条负向撤了 —— 景区要有人气。
     * 判据不变：**负向只走负向节点，不进正向**。
     */
    assert.equal(sent['7'].inputs.text, 'text, watermark', '负面提示被写进了风景描述');
    assert.doesNotMatch(sent['6'].inputs.text, /people|human.*,/, '负向词写进正向去了');
    // 轮询真的等了，不是发一次就来拿
    assert.ok(api.polls() >= 3, `只查了 ${api.polls()} 次 history，没等它画完`);

    const photoEvents = host.events.filter((e) => e.type === 'journey.photo');
    assert.equal(photoEvents.length, 1, '没有推照片事件');
    assert.equal(photoEvents[0].blobs[0].mime, 'image/png', 'mime 不对，宿主会存成打不开的文件');
  } finally { await api.close(); }
});

test('ComfyUI：选了协议却没粘 workflow —— 在发请求之前就拦住', async () => {
  const api = await fakeComfy('ok');
  try {
    const { world } = await makeWorld({ imageProtocol: 'comfyui', imageApi: api.api, imageWorkflow: '' });
    const r = await world.maybePhoto(cityById('tianshui'), 15, '2026-10-31', '', null);
    assert.equal(r.ok, false);
    assert.match(r.reason, /workflow/i, `没说清缺的是 workflow：${r.reason}`);
    assert.match(r.reason, /API Format/i, '没告诉他怎么导出');
    // 关键：一次请求都没发出去
    assert.equal(api.posted.length, 0, '配置不全还是发了请求');
  } finally { await api.close(); }
});

test('ComfyUI：workflow 被拒时，把节点号和原因一起说出来', async () => {
  const api = await fakeComfy('reject');
  try {
    const { world, host } = await makeWorld({
      imageProtocol: 'comfyui', imageApi: api.api, imageWorkflow: JSON.stringify(DEFAULT_WF),
    });
    const r = await world.maybePhoto(cityById('tianshui'), 15, '2026-10-31', '', null);
    assert.equal(r.ok, false);
    // node_errors 才是能照做的信息：哪个节点、缺什么
    assert.match(r.reason, /节点 7/, `没说是哪个节点：${r.reason}`);
    assert.match(r.reason, /clip/, '没带上 ComfyUI 的原话');
    assert.ok(host.warns.some((w) => /节点 7/.test(w)), '日志里没有原因');
  } finally { await api.close(); }
});

test('ComfyUI：执行报错要说清是哪个节点红了', async () => {
  const api = await fakeComfy('exec_error');
  try {
    const { world } = await makeWorld({
      imageProtocol: 'comfyui', imageApi: api.api, imageWorkflow: JSON.stringify(DEFAULT_WF),
    });
    const r = await world.maybePhoto(cityById('tianshui'), 15, '2026-10-31', '', null);
    assert.equal(r.ok, false);
    assert.match(r.reason, /KSampler/);
    assert.match(r.reason, /out of memory/i);
  } finally { await api.close(); }
});

test('ComfyUI：画完了但没图，指向 Save Image 而不是说「不知道」', async () => {
  const api = await fakeComfy('no_image');
  try {
    const { world } = await makeWorld({
      imageProtocol: 'comfyui', imageApi: api.api, imageWorkflow: JSON.stringify(DEFAULT_WF),
    });
    const r = await world.maybePhoto(cityById('tianshui'), 15, '2026-10-31', '', null);
    assert.equal(r.ok, false);
    assert.match(r.reason, /Save Image/, `没给出可查的方向：${r.reason}`);
  } finally { await api.close(); }
});

test('ComfyUI：排队太久要报超时，而且不许说成「连不上」', async () => {
  const api = await fakeComfy('queued');
  try {
    const { world } = await makeWorld({
      imageProtocol: 'comfyui',
      imageApi: api.api, imageWorkflow: JSON.stringify(DEFAULT_WF),
    });
    // 直接从 shootComfy 这一层测超时：World 那条路的超时是写死的 180 秒
    const { shootComfy } = await import('../src/comfy.ts');
    const t0 = Date.now();
    await assert.rejects(
      shootComfy({ api: api.api, workflow: JSON.stringify(DEFAULT_WF), prompt: 'x', timeoutMs: 1200 }),
      /还没画完|等太久/,
      '超时的说法不对',
    );
    assert.ok(Date.now() - t0 < 10_000, '没有按 timeoutMs 及时收手');
    void world;
  } finally { await api.close(); }
});

test('ComfyUI：服务没开时说「连不上」，不抛一个裸的 fetch 错误', async () => {
  const { shootComfy } = await import('../src/comfy.ts');
  // 拿一个刚关掉的端口
  const api = await fakeComfy('ok');
  const dead = api.api;
  await api.close();
  await assert.rejects(
    shootComfy({ api: dead, workflow: JSON.stringify(DEFAULT_WF), prompt: 'x', timeoutMs: 2000 }),
    /连不上 ComfyUI/,
    '没给出「服务开着吗」这句能照做的话',
  );
});

test('ComfyUI：面板诊断按协议分开，不把「模型名」甩给本地用户', async () => {
  /*
   * 云端那条路的面板文案是「接口 X，模型 Y，密钥已填/没填」。
   * ComfyUI 没有模型名（写在 workflow 里）、通常也没有密钥 —— 照念会让人
   * 以为自己漏填了两项，然后去填一个根本没用的字段。
   */
  const api = await fakeComfy('ok');
  try {
    const { world } = await makeWorld({
      imageProtocol: 'comfyui', imageApi: api.api, imageWorkflow: JSON.stringify(DEFAULT_WF),
    });
    const out = await world.webUi().invoke('album', 'shoot', []);
    assert.equal(out.ok, true);
    assert.equal(out.diag.protocol, 'comfyui');
    assert.match(out.diag.line, /ComfyUI/);
    assert.doesNotMatch(out.diag.line, /模型/, '把云端的字段名带给了本地用户');
  } finally { await api.close(); }
});
