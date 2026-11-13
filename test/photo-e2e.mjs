/**
 * 生图链路端到端：真起一个本地 HTTP 服务装作生图接口，真跑一遍 World。
 *
 * 为什么值得单独一条：这条链路上有三段（请求 → 字节 → 宿主落库 → 句柄进照片簿），
 * 任何一段断了，表现都是「相册永远是空的」，而且日志里一片祥和。
 * 单测只能验拼字符串，验不了「句柄有没有拿到」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 1×1 PNG，够用。
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { cityById } = await import('../src/geo/cities.ts');

/**
 * 起一个只认 /images/generations 的假接口，记下它收到的请求体。
 *
 * `mode` 除了成/败，还能扮两种真实的挑剔服务：
 * - `image_size`：只认 `image_size` 字段，传 `size` 就 400（硅基流动那一支）
 * - `size_unknown`：不认任何尺寸字段，多传一个就 400
 * - `fmt_unknown`：不认 `response_format`，多传一个就 400
 * - `octet_url`：回一个 url，下载时 content-type 是 application/octet-stream（对象存储的常态）
 */
async function fakeImageApi(mode = 'b64') {
  const seen = [];
  const server = createServer((req, res) => {
    if (req.url === '/blob') {
      // 对象存储的常态：图片是好的，content-type 却是 octet-stream
      res.setHeader('content-type', 'application/octet-stream');
      res.end(Buffer.from(PNG_B64, 'base64'));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      seen.push({ url: req.url, auth: req.headers.authorization, body: parsed });
      res.setHeader('content-type', 'application/json');
      if (mode === 'fail') { res.statusCode = 500; res.end('{}'); return; }
      if (mode === 'image_size' && parsed.image_size === undefined) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: 'image_size 不能为空' } }));
        return;
      }
      /*
       * 中转站把 b64 换成占位符（日志脱敏那种），但照样 200。
       * 解出来不是图，扩展必须当场说清，不能存成一张打不开的「照片」。
       */
      if (mode === 'b64_placeholder') {
        res.end(JSON.stringify({ data: [{ b64_json: '[base64 image data omitted from logs]' }] }));
        return;
      }
      /*
       * base64 里带裸换行（没转义）—— 常见的中转站坏法，不是合法 JSON。
       * 这里手写响应体，不用 JSON.stringify。
       */
      if (mode === 'b64_broken_lines') {
        const body = `{"data":[{"b64_json":"${PNG_B64.replace(/([A-Za-z0-9+/=]{60})(?=[A-Za-z0-9+/=])/g, '$1\n')}"}]}`;
        res.end(body);
        return;
      }
      // 压根不是 JSON：网关返回了 HTML
      if (mode === 'html') {
        res.end('<html><body>502 Bad Gateway</body></html>');
        return;
      }
      // 硅基流动现在回的是 images 而不是 data —— 图生成好了，只认 data 会报「没有图」
      if (mode === 'images_url') {
        res.end(JSON.stringify({ images: [{ url: `http://127.0.0.1:${server.address().port}/blob` }] }));
        return;
      }
      if (mode === 'octet_url') {
        res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${server.address().port}/blob` }] }));
        return;
      }
      if (mode === 'fmt_unknown' && parsed.response_format !== undefined) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: '不支持的参数：response_format' } }));
        return;
      }
      if (mode === 'size_unknown' && (parsed.size !== undefined || parsed.image_size !== undefined)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: '不支持的参数：尺寸' } }));
        return;
      }
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    api: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** 假宿主：把事件和附件记下来，返回带句柄的信封。 */
function fakeHost() {
  const events = [];
  const warns = [];
  return {
    events,
    warns,
    // 桩要像个真 Logger：宿主接口有 trace/debug/info/warn/error，
    // 少一个就会在「跳过时记 debug」这类路径上抛 TypeError。
    log: {
      trace() {}, debug() {}, info() {},
      warn: (m) => warns.push(String(m)),
      error: (m) => warns.push(String(m)),
    },
    pushEvent: async (e) => {
      const blobs = (e.blobs ?? []).map((b, i) => ({
        // 事件序号进句柄：两次拍到同一处时，测试要能分辨「换了」还是「没换」
        handle: `log:fake${events.length}-${i}.png`,
        mime: b.mime,
        name: b.name,
      }));
      const env = { ...e, blobs };
      events.push(env);
      return env;
    },
    pushDeferred: () => {},
    store: {},
    drainPendingEvents: async () => [],
  };
}

async function makeWorld(cfgOver = {}, now) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-photo-'));
  const cfg = { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', ...cfgOver };
  const world = new JourneyWorld({
    cfg, dataDir: dir, botName: '大肥鱼', now: now ?? (() => new Date('2026-10-31T12:00:00Z')),
  });
  const host = fakeHost();
  await world.start(host);
  return { world, host, dir };
}

test('生图：一张照片真的走到「宿主收到附件 + 照片簿记下句柄」', async () => {
  const api = await fakeImageApi('b64');
  try {
    const { world, host, dir } = await makeWorld({ imageApi: api.api, imageKey: 'sk-test', imageModel: 'gpt-image-1' });
    const city = cityById('tianshui');
    await world.maybePhoto(city, 15, '2026-10-31', '麦积山石窟', null);

    assert.equal(api.seen.length, 1, `接口被调了 ${api.seen.length} 次`);
    assert.equal(api.seen[0].url, '/v1/images/generations', `请求路径不对：${api.seen[0].url}`);
    assert.equal(api.seen[0].auth, 'Bearer sk-test', '密钥没带上');
    assert.equal(api.seen[0].body.model, 'gpt-image-1');
    assert.match(api.seen[0].body.prompt, /麦积山石窟/, '提示词里没有地点');
    assert.match(api.seen[0].body.prompt, /人影|行人|没有人物/, '提示词没交代人怎么处理');

    const photoEvents = host.events.filter((e) => e.type === 'journey.photo');
    assert.equal(photoEvents.length, 1, '没有推照片事件');
    assert.equal(photoEvents[0].blobs.length, 1, '事件里没有附件');

    const file = join(dir, 'photos.json');
    assert.ok(existsSync(file), '照片簿没落盘');
    const book = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(book.items.length, 1);
    assert.equal(book.items[0].cityId, 'tianshui');
    assert.equal(book.items[0].handle, photoEvents[0].blobs[0].handle, '照片簿里的句柄和事件对不上');
  } finally { await api.close(); }
});

test('生图：同一天同一个城市不拍第二张（不给同一张付两次钱）', async () => {
  const api = await fakeImageApi('b64');
  try {
    const { world } = await makeWorld({ imageApi: api.api });
    const city = cityById('tianshui');
    await world.maybePhoto(city, 15, '2026-10-31', '麦积山石窟', null);
    await world.maybePhoto(city, 16, '2026-10-31', '麦积山石窟', null);
    assert.equal(api.seen.length, 1, `同城同日拍了 ${api.seen.length} 张`);
    // 换一天才允许再拍
    await world.maybePhoto(city, 15, '2026-11-01', '', null);
    assert.equal(api.seen.length, 2, '第二天没拍');
  } finally { await api.close(); }
});

test('生图：接口挂了就静默跳过，不留残渣、不推事件', async () => {
  const api = await fakeImageApi('fail');
  try {
    const { world, host, dir } = await makeWorld({ imageApi: api.api });
    await world.maybePhoto(cityById('tianshui'), 15, '2026-10-31', '麦积山石窟', null);
    assert.equal(host.events.filter((e) => e.type === 'journey.photo').length, 0, '失败还推了事件');
    // 静默不等于无声：相册空了，用户唯一能查的就是日志，里面必须有原因。
    assert.ok(host.warns.some((w) => /HTTP 500/.test(w)), `日志里没有失败原因：${host.warns.join(' | ')}`);
    assert.ok(host.warns.some((w) => /没拍成/.test(w)), '日志没说清是哪张没拍成');
    const file = join(dir, 'photos.json');
    if (existsSync(file)) {
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).items.length, 0, '失败还记了一张');
    }
  } finally { await api.close(); }
});

test('生图：没配接口时一次请求都不该发', async () => {
  const api = await fakeImageApi('b64');
  try {
    const { world } = await makeWorld({ imageApi: '' });
    await world.maybePhoto(cityById('tianshui'), 15, '2026-10-31', '麦积山石窟', null);
    assert.equal(api.seen.length, 0, '没配接口竟然发了请求');
  } finally { await api.close(); }
});

test('生图：只认 image_size 的服务，换字段名重发一次就成', async () => {
  /*
   * 硅基流动、阿里百炼那一支的写法是 `image_size`，传 `size` 直接 400。
   * 原来的退路是「去掉尺寸再发」，对这种服务是**错的** —— 去掉了它照样要。
   * 所以先换字段名、尺寸不变，第二次才退到「不带尺寸」。
   */
  const api = await fakeImageApi('image_size');
  try {
    const { world, host } = await makeWorld({ imageApi: api.api });
    await world.maybePhoto(cityById('tianshui'), 15, '2026-10-31', '麦积山石窟', null);

    assert.equal(api.seen.length, 2, `该发两次（换字段名重发），实际 ${api.seen.length} 次`);
    assert.equal(api.seen[0].body.size, '1024x1024', '第一次该按 OpenAI 的写法发');
    assert.equal(api.seen[0].body.image_size, undefined);
    assert.equal(api.seen[1].body.image_size, '1024x1024', '第二次没换成 image_size');
    assert.equal(api.seen[1].body.size, undefined, '两个字段都带着会被挑剔的服务再拒一次');
    assert.equal(host.events.filter((e) => e.type === 'journey.photo').length, 1, '换字段名之后还是没拍成');
  } finally { await api.close(); }
});

test('生图：连尺寸都不认的服务，最后一步是不带尺寸再发', async () => {
  const api = await fakeImageApi('size_unknown');
  try {
    const { world, host } = await makeWorld({ imageApi: api.api });
    await world.maybePhoto(cityById('tianshui'), 15, '2026-10-31', '麦积山石窟', null);

    assert.equal(api.seen.length, 2, `该发两次，实际 ${api.seen.length} 次`);
    assert.equal(api.seen[1].body.size, undefined);
    assert.equal(api.seen[1].body.image_size, undefined, '退到这一步就该什么尺寸都不带');
    assert.equal(host.events.filter((e) => e.type === 'journey.photo').length, 1, '不带尺寸之后还是没拍成');
  } finally { await api.close(); }
});

test('生图：不认 response_format 的服务，去掉它再发，尺寸照留', async () => {
  /*
   * 有的服务（尤其自建的 OpenAI 兼容层）见到不认识的字段直接 400。
   * 去掉 response_format 之后返回的通常是 `data[0].url`，那条路本来就走得通。
   */
  const api = await fakeImageApi('fmt_unknown');
  try {
    const { world, host } = await makeWorld({ imageApi: api.api });
    await world.maybePhoto(cityById('tianshui'), 15, '2026-10-31', '麦积山石窟', null);

    assert.equal(api.seen.length, 2, `该发两次，实际 ${api.seen.length} 次`);
    assert.equal(api.seen[1].body.response_format, undefined, '第二次还带着 response_format');
    assert.equal(api.seen[1].body.size, '1024x1024', '去掉 response_format 时不该顺手把尺寸也扔了');
    assert.equal(host.events.filter((e) => e.type === 'journey.photo').length, 1, '还是没拍成');
  } finally { await api.close(); }
});

test('生图：下载回来的 content-type 是 octet-stream 时，按文件头认出是 PNG', async () => {
  /*
   * 2026-11-01 的真实故障：硅基流动回的是 url，点过去 content-type 是
   * `application/octet-stream`。宿主按 mime 决定落盘扩展名，认不出就存成 `.bin` ——
   * 用户双击打不开，相册也显示不出来。
   *
   * 所以下载完不能只信响应头，要看文件头。
   */
  const api = await fakeImageApi('octet_url');
  try {
    const { world, host } = await makeWorld({ imageApi: api.api });
    await world.maybePhoto(cityById('tianshui'), 15, '2026-11-01', '伏羲庙', null);

    const ev = host.events.find((e) => e.type === 'journey.photo');
    assert.ok(ev, '没推照片事件');
    assert.equal(ev.blobs[0].mime, 'image/png', `落盘类型认错了（${ev.blobs[0].mime}）—— 会存成 .bin`);
    assert.match(ev.blobs[0].name, /\.png$/, '附件名不是 .png');
    // 地名要进提示词：用户在伏羲庙，拍的不该是一张「天一水」的通用图
    assert.match(api.seen[0].body.prompt, /伏羲庙/, '提示词里没有地名');
  } finally { await api.close(); }
});

test('补拍：点「补一张」会换掉当天那张，不会因为「一天一张」静默不动', async () => {
  /*
   * 2026-11-01 的真实故障：那天已经自动拍过一张，用户在相册点「补一张」，
   * 后台在判重那行 return 了 —— 不报错、不记日志、界面纹丝不动。
   * 用户看到的就是「点了没反应」。
   *
   * 手动是明确意图：换掉旧的，不是再攒一张。
   */
  const api = await fakeImageApi('b64');
  try {
    const { world, host, dir } = await makeWorld({ imageApi: api.api });
    const city = cityById('tianshui');
    await world.maybePhoto(city, 15, '2026-11-01', '伏羲庙', null);
    const book = () => JSON.parse(readFileSync(join(dir, 'photos.json'), 'utf8')).items;
    const first = book()[0].handle;

    await world.maybePhoto(city, 15, '2026-11-01', '伏羲庙', null, true);
    assert.equal(api.seen.length, 2, `补拍没真的发请求（${api.seen.length} 次）`);
    const items = book();
    assert.equal(items.length, 1, `补拍之后该还是一条记录，实际 ${items.length} 条`);
    assert.notEqual(items[0].handle, first, '句柄没变 —— 旧的那张还在最上面');
    assert.equal(host.events.filter((e) => e.type === 'journey.photo').length, 2);
  } finally { await api.close(); }
});

test('拍失败的原因要能到界面上，不能只写进日志', async () => {
  /*
   * 相册空着的时候，用户唯一能查的线索就是那句话。
   * 只写日志等于「点了没反应」。
   */
  const api = await fakeImageApi('fail');
  try {
    const { world } = await makeWorld({ imageApi: api.api });
    await world.maybePhoto(cityById('tianshui'), 15, '2026-11-01', '伏羲庙', null, true);
    const res = await world.panelInvoke('album', 'list', []);
    assert.match(res.error, /HTTP 500/, `界面拿不到原因：${res.error}`);
    assert.match(res.error, /伏羲庙/, '原因里没说清是哪一张');
    assert.deepEqual(res.photos, [], '失败了还列出一张');
  } finally { await api.close(); }
});

test('生图：返回体是 images 而不是 data 时也要认得出', async () => {
  /*
   * 2026-11-01 同一天里见到两种形状：OpenAI 那套是 `{data:[{url}]}`，
   * 硅基流动是 `{images:[{url}]}`。只认 data 的话，图生成好了这边却报
   * 「返回里没有图」—— 钱照扣，相册空着。
   */
  const api = await fakeImageApi('images_url');
  try {
    const { world, host } = await makeWorld({ imageApi: api.api });
    await world.maybePhoto(cityById('tianshui'), 15, '2026-11-01', '伏羲庙', null);
    const ev = host.events.find((e) => e.type === 'journey.photo');
    assert.ok(ev, '认不出 images 形状，图白生成');
    assert.equal(ev.blobs[0].mime, 'image/png');
  } finally { await api.close(); }
});

test('补拍：手动点的那张不受「白天才拍」限制', async () => {
  /*
   * 2026-11-01 收到的反馈：填好了地址、密钥、模型，点「补一张」没反应，
   * core.log 没有任何记录，中转站也没看到请求。
   *
   * 根因之一是这一行：`if (hour < 7 || hour >= 20) return;` —— 它连**手动补拍**
   * 也挡住，而且一声不响。用户点的是「现在补一张」，凭什么因为她那边过了八点就拒绝。
   */
  const api = await fakeImageApi('b64');
  try {
    const { world } = await makeWorld({ imageApi: api.api });
    const city = cityById('tianshui');

    // 自动那条：当地 22 点，该跳过，而且要说得出口
    const auto = await world.maybePhoto(city, 22, '2026-11-01', '伏羲庙', null);
    assert.equal(auto.ok, false, '自动那条半夜居然拍了');
    assert.match(String(auto.reason), /22 点/, `跳过的理由没说清：${auto.reason}`);
    assert.equal(api.seen.length, 0, '自动那条半夜还是发了请求');

    // 手动那条：同样是 22 点，但这是他点的，该拍
    const manual = await world.maybePhoto(city, 22, '2026-11-01', '伏羲庙', null, true);
    assert.equal(manual.ok, true, `手动补拍被时间窗挡住了：${manual.reason}`);
    assert.equal(api.seen.length, 1, '手动补拍没发请求');
  } finally { await api.close(); }
});

test('跳过的每一种理由都要能说出来，不能一声不响', async () => {
  /*
   * 原来四个 `return` 全是静默的：不报错、不记日志、界面什么都不变。
   * 用户只能猜 —— 这正是那条反馈「日志里也没有任何记录」的来源。
   */
  const city = cityById('tianshui');

  const noApi = await makeWorld({ imageApi: '' });
  const r1 = await noApi.world.maybePhoto(city, 15, '2026-11-01', '伏羲庙', null, true);
  assert.equal(r1.ok, false);
  assert.match(String(r1.reason), /接口/, '没说是没配接口');

  const api = await fakeImageApi('b64');
  try {
    const { world } = await makeWorld({ imageApi: api.api });
    await world.maybePhoto(city, 15, '2026-11-01', '伏羲庙', null);
    // 同一天同城第二张走自动路径，要被判重挡住，并说得出为什么
    const r2 = await world.maybePhoto(city, 16, '2026-11-01', '伏羲庙', null);
    assert.equal(r2.ok, false);
    assert.match(String(r2.reason), /已经拍过/, `判重的理由没说清：${r2.reason}`);
  } finally { await api.close(); }
});

test('面板补拍：回执里带原因和诊断，界面才有东西可显示', async () => {
  /*
   * 后台原来用 `void` 不等待，前端只能死等轮询 —— 失败时拿不到任何原因。
   * 现在等拍完再回话，并把配置状态一起带回去。
   */
  const api = await fakeImageApi('fail');
  try {
    const { world } = await makeWorld({ imageApi: api.api, imageKey: 'sk-test', imageModel: 'm1' });
    const res = await world.panelInvoke('album', 'shoot', []);
    assert.equal(res.ok, false, '失败了却报成功');
    assert.match(String(res.reason), /HTTP 500/, `原因不对：${res.reason}`);
    assert.ok(res.diag, '没有诊断信息，界面只能显示一句「没拍成」');
    assert.equal(res.diag.hasKey, true, '诊断说没填密钥，实际填了');
    assert.match(res.diag.api, /^https?:\/\//);
    assert.equal(String(res.diag.api).includes('sk-test'), false, '诊断把密钥泄露出去了');
  } finally { await api.close(); }
});

test('b64 解出来不是图（中转站换了占位符）要当场说清，不能存成坏文件', async () => {
  /*
   * 2026-11-01 真实反馈：中转站那边图生成成功，返回体里 b64_json 被换成了
   * 「[base64 image data omitted from logs]」。原来 b64 分支硬写 mime 为 image/png、
   * 不做任何校验 —— 会存出一张打不开的「照片」，而且日志里看不出问题。
   */
  const api = await fakeImageApi('b64_placeholder');
  try {
    const { world, host } = await makeWorld({ imageApi: api.api });
    const r = await world.maybePhoto(cityById('tianshui'), 15, '2026-11-01', '伏羲庙', null);
    assert.equal(r.ok, false, '占位符居然被当成照片存下来了');
    assert.match(String(r.reason), /不是图片/, `理由没说清：${r.reason}`);
    assert.equal(host.events.filter((e) => e.type === 'journey.photo').length, 0, '推了一张坏图');
  } finally { await api.close(); }
});

test('base64 里有裸换行的 JSON：修一次就能读，不该直接判死', async () => {
  /*
   * 中转站常见坏法：base64 按 76 字符断行但没转义成 \\n，整份响应就不是合法 JSON。
   * 用户看到的是「返回的不是 JSON」，可图其实是好的 —— 能修就别让他白等。
   */
  const api = await fakeImageApi('b64_broken_lines');
  try {
    const { world, host } = await makeWorld({ imageApi: api.api });
    const r = await world.maybePhoto(cityById('tianshui'), 15, '2026-11-01', '伏羲庙', null);
    assert.equal(r.ok, true, `换行修不了：${r.reason}`);
    const ev = host.events.find((e) => e.type === 'journey.photo');
    assert.ok(ev, '没推照片事件');
    assert.equal(ev.blobs[0].mime, 'image/png');
  } finally { await api.close(); }
});

test('压根不是 JSON 时，错误里要带上大小和开头，能让人判断', async () => {
  /*
   * 原来只有一句「返回的不是 JSON」—— 用户和我们都没法判断
   * 是网关返回了 HTML、被截断了、还是别的。
   */
  const api = await fakeImageApi('html');
  try {
    const { world } = await makeWorld({ imageApi: api.api });
    const r = await world.maybePhoto(cityById('tianshui'), 15, '2026-11-01', '伏羲庙', null);
    assert.equal(r.ok, false);
    const why = String(r.reason);
    assert.match(why, /不是 JSON/);
    assert.match(why, /\d+ 字符/, `没说响应多大：${why}`);
    assert.match(why, /502 Bad Gateway|html/i, `没把开头露出来：${why}`);
  } finally { await api.close(); }
});

test('拍照：路上的那张是窗外，不是城里的景点', async () => {
  /*
   * 2026-11-03 一位读者来信：「加了豆包的模型，但生成的图片一直都是几个出发的城市
   * 中的图片，不会显示火车、乡间的照片」。
   *
   * 根因不在模型：拍照只挂在「出去逛」这一个作息节点上，路上一个节点都不拍。
   * 所以提示词永远是「某城的某景点」，模型再强也只能画城。
   */
  const { photoPrompt } = await import('../src/photo.ts');

  const city = photoPrompt({ city: '天水', spot: '麦积山石窟', hour: 10 });
  assert.match(city, /天水的麦积山石窟/, '城里的那张还是该写清具体景点');

  const road = photoPrompt({ city: '天水', hour: 10, onRoad: true, mode: '火车' });
  assert.match(road, /火车上往外看/, `路上的提示词没写清在车上：${road}`);
  assert.doesNotMatch(road, /麦积山/, '路上那张不该再点名某个景点');
  assert.doesNotMatch(road, /天水的/, '写「天水的」会被画成城里的景');

  // 没传交通方式也别崩，退成「车上」
  const bare = photoPrompt({ city: '天水', hour: 10, onRoad: true });
  assert.match(bare, /车上往外看/);
});

test('在路上点「现在补一张」：拍窗外，不拍出发城市的街景', async () => {
  /*
   * 2026-11-03 一位读者反馈：她在路上跑了一下午，点「现在补一张」，
   * 出来的还是出发城市晾衣服的照片 —— 原话「我人往东跑了一下午，照片还站在原地晾衣服」。
   *
   * 根因：`hereId` 在 traveling 时**还是出发城市**（等 arrive 才更新），
   * 补拍那个按钮一直拿着起点去拍。路上的照片该拍目的地一带、而且拍窗外。
   *
   * 顺带一句读者的判断：「我看得见窗外是什么样，就是发不出去」—— 提示词管不了这件事，
   * 是底层传错了城市。他自己往提示词里加了「拍照拍什么」那一段，没用，因为问题不在那儿。
   */
  const { StateStore, initialState } = await import('../src/state.ts');
  const api = await fakeImageApi();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'jr-roadphoto-'));
    new StateStore(dir).save({
      ...initialState('lanzhou'),
      phase: 'traveling',
      hereId: 'tianshui',
      leg: {
        id: 'leg-1', fromId: 'tianshui', toId: 'nanchang', modeId: 'train',
        km: 1200, durationWorldHours: 8,
        departedAt: '2026-11-03T00:00:00Z', arriveAt: '2026-11-03T08:00:00Z',
        speed: 1, viaIds: [], createdAt: '2026-11-03T00:00:00Z',
      },
      tripStartedAt: '2026-11-01T00:00:00Z',
    });

    const world = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', imageApi: api.api, imageKey: 'sk-test' },
      dataDir: dir, botName: '大肥鱼',
      now: () => new Date('2026-11-03T04:00:00Z'), // 北京 12:00
    });
    await world.start(fakeHost());

    await world.panelInvoke('album', 'shoot', []);

    const prompt = api.seen.at(-1)?.body?.prompt ?? '';
    assert.ok(prompt, '没有真的发出生图请求');
    assert.match(prompt, /火车上往外看/, `路上补拍没写「窗外」：${prompt}`);
    assert.match(prompt, /南昌/, '该拍目的地那一带');
    assert.doesNotMatch(prompt, /天水的/, '还在拍出发城市的街景');
  } finally { await api.close?.(); }
});

/* ============================================================
 * 她有相机了（2026-11-04，0.5.32）
 *
 * 起因是一段用户反馈：「能不能让鱼主动拍照啊，我跟他说让他拍张照，
 * 他说必须点拍一张才行」。
 *
 * 查下来不是她不肯，是**她手上没有工具** —— 拍照只有面板上那个「补一张」
 * 按钮一条路。所以这一组测试盯的不是「拍得成不成」（上面十几条已经盯够了），
 * 而是「她那条路和按钮那条路是不是同一条路」。
 * ============================================================ */

const photoTool = (world) => world.tools().find((t) => t.name === 'journey_photo');

test('工具表里有 journey_photo：两个可选参数 view + subject', async () => {
  const { world } = await makeWorld();
  const tool = photoTool(world);
  assert.ok(tool, '工具表里没有 journey_photo —— 她还是只能让人去点按钮');
  /*
   * 2026-11-05 改了这条判断，理由换了，不是结论换了。
   *
   * 原来的理由是「模型多填一个参数就多一次失败机会」—— 那是对的。
   * 但「她要能拍到星空」这件事，工具拿不到他要看什么，只能靠她猜时辰，
   * 猜错就又是一次编。所以放**一个可选**参数进来：不填 = 老行为，一个字不变。
   * 谁要再加第二个，回到这条测试上来吵。
   *
   * ── 2026-11-06 我回来了，带着理由 ──
   *
   * 一位用户报的 bug（原话）：「无论我提出什么拍摄要求（比如拍晚饭等），
   * 都只会生成同一处风景画面，无法按照我的指令更换拍摄对象和场景」。
   *
   * 根因就是「只有一个 view」：他说「拍晚饭」，能动的只有「抬不抬头」，
   * 题材一个字都改不了 —— 提示词照样按「城市 + 景点」拼，出来当然还是那处风景。
   *
   * 所以加 `subject`（ground/sky/food/street/festival/detail）。
   * 两个都是可选的，不填 = 老行为，一个字不变。
   */
  /*
   * ── 2026-11-09 我第三次回来，带着理由 ──
   *
   * Mr.Q 的截图里，用户说「拍一下你在公交车上的风景」，她答「喏，车窗外这一段，
   * 我坐得挺靠后」—— 前半句 `subject` 能表达（车窗外的风景），
   * 后半句表达不了。**用户已经开始提具体的取景要求了，而工具只能选题材。**
   *
   * 加 `focus`：一句话（≤40 字）补「怎么拍」，不补「拍什么」。
   * 三个都是可选的，不填 = 老行为一个字不变。
   *
   * 边界写死在工具描述里（见下面的断言）：她能加取景、角度、坐在哪，
   * 不能加「本来不在那儿的东西」。放开了她会写「九寨沟的樱花」，季节对不上。
   */
  /*
   * ── 2026-11-10 第四次回来，带着理由 ──
   *
   * Mr.Q：「能让桌宠自己写提示词嘛？」
   *
   * 加 `describe`：她自己写一句「画面里是什么」（≤60 字）。
   * 事实层（地点/时段/天气/光/季节/有无人物/硬约束）仍归程序 ——
   * 她拿到的是**画面那一段**，不是整条提示词的支配权。
   * 全交给她会出现「九寨沟的樱花」那种季节对不上的画面，
   * 而「只拍她真看到的」一破，前面接的 177 城真实数据就白接了。
   *
   * 和 `focus` 分工：describe = 看到什么，focus = 怎么拍。
   */
  assert.deepEqual(
    Object.keys((tool.parameters && tool.parameters.properties) ?? {}),
    ['view', 'subject', 'describe', 'focus'],
    '参数表动了：现在应该是 view + subject + describe + focus，四个都可选',
  );
  /*
   * `describe` 的边界必须写在描述里 —— 模型读的是描述，不是代码注释。
   * 只说「写一句画面」等于给她一支笔，她会拿去写不存在的花和雪。
   */
  const descDesc = String(tool.parameters.properties.describe?.description ?? '');
  assert.match(descDesc, /60/, '没说清 60 字上限');
  assert.match(descDesc, /WHAT IS IN THE FRAME/i, '没说清它管画面内容');
  assert.match(descDesc, /Never add|do not have/i,
    '没写「不许加本来不在那儿的东西」—— 这条边界一松，真实性就没了');
  /*
   * `focus` 的边界必须在描述里 —— 只说「补充描述」等于给了她一支笔，
   * 她会拿去写不存在的花和雪。
   */
  const focusDesc = String(tool.parameters.properties.focus?.description ?? '');
  assert.match(focusDesc, /framing|HOW to frame/i, '没说清 focus 管取景');
  assert.match(focusDesc, /not actually there|do not use it to add/i,
    '没写「不许加本来不在那儿的东西」—— 这条边界一松，真实性就没了');
  assert.deepEqual(tool.parameters.required ?? [], [], '都不能是必填 —— 不填就是脚下那张');
  assert.ok(tool.tags.includes('write'), '它会花钱、会写照片簿，不该标成只读');
  /*
   * 描述是模型挑工具时读的第一手材料。只写「拍一张照片」，她仍可能客气地
   * 让人去点按钮 —— 那正是这次反馈要堵的那句话。
   */
  assert.match(String(tool.description), /never tell them to press a button/i,
    '描述里没堵住「让他去点按钮」这条路');
  // 抬头那张的边界必须写在描述里，否则她会以为「要什么就有什么」。
  assert.match(String(tool.description), /view="sky"/i, '描述里没说清楚抬头怎么拍');
  assert.match(String(tool.description), /only when it is not overcast|Stars only show/i,
    '没说清星看天不看许愿 —— 她就会许诺一个阴天的星空');
});

test('她要拍天：镜头抬起来，事件照推，回执说清天上有没有星', async () => {
  const api = await fakeImageApi('b64');
  try {
    const { world, host } = await makeWorld({ imageApi: api.api, imageKey: 'sk-test' });
    const r = await photoTool(world).handler({ view: 'sky' });
    const photoEvents = host.events.filter((e) => e.type === 'journey.photo');
    assert.equal(photoEvents.length, 1, '抬头那张没推事件 —— 界面上就没有那张图');
    assert.match(r.text, /镜头抬起来/, '回执没说这是抬头拍的');
    assert.match(r.text, /别描述画面/, '回执没拦住她编画面');
    assert.match(r.text, /当地 \d+ 点/, '回执没给时刻，她只能拿身体编理由');
  } finally { await api.close(); }
});

test('他要照片：她直接拍，一路走到「宿主收到附件 + 照片簿记下」', async () => {
  const api = await fakeImageApi('b64');
  try {
    const { world, host } = await makeWorld({ imageApi: api.api, imageKey: 'sk-test' });
    const r = await photoTool(world).handler({});

    assert.equal(api.seen.length, 1, `工具调了 ${api.seen.length} 次请求`);
    const photoEvents = host.events.filter((e) => e.type === 'journey.photo');
    assert.equal(photoEvents.length, 1, '没有推照片事件 —— 界面上那张图就没了');
    assert.equal(photoEvents[0].blobs.length, 1, '事件里没有附件');
    assert.match(r.text, /拍好了/, `回执不是「拍到了」：${r.text}`);
    // 她没看过那张图（photo.ts 只给她提示词，不给她成品）。不拦一句她就会编画面。
    assert.match(r.text, /别描述画面/, '回执没拦住她编画面');
    /*
     * 2026-11-05 加的两条。只写「别描述画面」堵不住（20:03 那次照样说了
     * 「沟里的池子，树里亮着几盏灯」），因为她缺的不是禁令，是**一条能说出口的真话**：
     * 不知道几点、不知道这工具拍不了什么，就只能拿身体编理由。
     */
    assert.match(r.text, /当地 \d+ 点/, '回执没把当地时刻交给她 —— 她只能拿身体编理由');
    /*
     * 2026-11-06 改：原来是「别连着再调一次」，可以读成「以后都别拍了」。
     * 20:10 那次她就被这句话拦住 —— reasoning 原话「but the earlier journey_photo
     * said 这一张够了,别连着再调一次」，于是改口答应了「端上来我就拍给你看」，
     * 一个她兑现不了的未来。现在只拦**同一次回答里的第二张**，措辞换成「第二遍」。
     */
    assert.match(r.text, /别再调第二遍|别连着再调/, '没拦重复调用：实测一次请求连拍了两张，云端按张计费');
  } finally { await api.close(); }
});

test('她拍的这张和按钮同一套限制：半夜能拍，同城同日也能重拍', async () => {
  /*
   * 两条闸都是给「她自己决定要拍」设的成本闸：
   *   - 7–20 点（别半夜掏相机）
   *   - 一天一张（别给同一个景付两次钱）
   * 人明确要的那一张，两条都不该拦 —— 2026-11-01 就是被第一闸挡住，
   * 用户点了「补一张」却一声不响。
   *
   * 工具路径如果自己另写一套判定，这两条会漂：按钮松了、她那边还紧着。
   * 所以这里专门验「同一天、同一个城市、已经拍过一张」之后她再拍还能成。
   */
  const api = await fakeImageApi('b64');
  try {
    // 北京 22:00 —— 落在自动那条的时段之外
    const { world } = await makeWorld({ imageApi: api.api }, () => new Date('2026-10-31T14:00:00Z'));
    const city = cityById('lanzhou');

    // 先让「自动」那一张占掉今天这个城市的名额（15 点，合法时段）
    const first = await world.maybePhoto(city, 15, '2026-10-31', '', null);
    assert.equal(first.ok, true, `准备状态没拍成：${first.reason}`);
    assert.equal(api.seen.length, 1);

    // 22 点 + 今天已经拍过 —— 他还要一张，就该拍
    const r = await photoTool(world).handler({});
    assert.equal(api.seen.length, 2, `被时间窗或判重挡住了：${r.text}`);
    assert.doesNotMatch(r.text, /已经拍过/, '判重闸没让开');
    assert.doesNotMatch(r.text, /不在拍照时段/, '时间窗没让开');
    assert.match(r.text, /拍好了/);
  } finally { await api.close(); }
});

test('没配生图服务：回执要让他知道去哪儿填，不是一句「拍不了」', async () => {
  const { world } = await makeWorld({ imageApi: '' });
  const r = await photoTool(world).handler({});
  assert.match(r.text, /没配/, `没说清是没配：${r.text}`);
  assert.match(r.text, /设置/, '没告诉他去哪儿填');
  // 关键：不能让她先答应「稍等」再报错，也不能让她编一张照片。
  assert.doesNotMatch(r.text, /稍等/);
});

test('她在路上被要照片：拍窗外，不拍出发城市的街景', async () => {
  /*
   * 这条专防「复制一份判定」：面板那条早就改成拍窗外了（`hereId` 在 traveling
   * 时还是出发城市），工具如果自己算一遍，很容易把老的写法抄过来 ——
   * 表现是「按钮拍的对了，她拍的还是原地不动」。
   */
  const { StateStore, initialState } = await import('../src/state.ts');
  const api = await fakeImageApi();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'jr-phototool-road-'));
    new StateStore(dir).save({
      ...initialState('lanzhou'),
      phase: 'traveling',
      hereId: 'tianshui',
      leg: {
        id: 'leg-1', fromId: 'tianshui', toId: 'nanchang', modeId: 'train',
        km: 1200, durationWorldHours: 8,
        departedAt: '2026-11-03T00:00:00Z', arriveAt: '2026-11-03T08:00:00Z',
        speed: 1, viaIds: [], createdAt: '2026-11-03T00:00:00Z',
      },
      tripStartedAt: '2026-11-01T00:00:00Z',
    });
    const world = new JourneyWorld({
      cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', imageApi: api.api, imageKey: 'sk-test' },
      dataDir: dir, botName: '大肥鱼',
      now: () => new Date('2026-11-03T04:00:00Z'), // 当地 12:00
    });
    await world.start(fakeHost());

    await photoTool(world).handler({});

    const prompt = api.seen.at(-1)?.body?.prompt ?? '';
    assert.ok(prompt, '没有真的发出生图请求');
    assert.match(prompt, /火车上往外看/, `她拍的路上那张没写「窗外」：${prompt}`);
    assert.doesNotMatch(prompt, /天水的/, '还在拍出发城市的街景');
  } finally { await api.close?.(); }
});

/* ============================================================
 * 照片里出不出人（2026-11-04，0.5.34）
 *
 * 原来提示词末尾写死一句「画面里没有人物」。接本地二次元底模的人
 * 想拍角色出镜，那句话就是每次都在跟底模对着干。
 *
 * 这一组盯的不是「画得像不像」，是**提示词自相矛盾**：
 * 同一段里既说「有一个人」又说「没有人物」，出图会飘，而且没人看得出为什么。
 * ============================================================ */

test('人物设定留空：一个字都不提人，还是「画面里没有人物」', async () => {
  const { photoPrompt } = await import('../src/photo.ts');
  const p = photoPrompt({ city: '九寨沟', spot: '五花海', hour: 10 });
  assert.match(p, /人影|行人|画面里没有人物/, `默认行为变了：${p}`);
  assert.doesNotMatch(p, /画面里有一个人/, `没人设定却说有人：${p}`);
});

test('填了人物设定：说清有一个人，且不再说「没有人物」', async () => {
  const { photoPrompt } = await import('../src/photo.ts');
  const cast = '一个穿米色风衣、黑色短发的女孩';
  const p = photoPrompt({ city: '九寨沟', spot: '五花海', hour: 10, cast });
  assert.match(p, /画面里有一个人：一个穿米色风衣/, `人物没进提示词：${p}`);
  /*
   * 这条是重点。「画面里没有人物」和「画面里有一个人」同时出现的话，
   * 模型会挑一个听，出来的结果是随机的 —— 而且是那种「有时候有人有时候没有」
   * 的随机，用户只会觉得「不稳定」，根本想不到是提示词自己打架。
   */
  assert.doesNotMatch(p, /画面里没有人物|人影/, `两句打架了：${p}`);
  // 别画成一群人。
  assert.match(p, /只有这一个人/, `没拦住多画人：${p}`);
});

test('人物设定和自定义风格能共存，风格没被顶掉', async () => {
  const { photoPrompt } = await import('../src/photo.ts');
  const p = photoPrompt({
    city: '天水', spot: '麦积山石窟', hour: 15,
    style: 'anime style, cel shading',
    cast: 'a girl with fennec ears',
  });
  assert.ok(p.startsWith('anime style, cel shading：'), `风格前缀丢了：${p}`);
  assert.match(p, /a girl with fennec ears/);
  assert.doesNotMatch(p, /胶片颗粒|胶片质感/, '指定了风格还硬塞写实指令');
});

test('人物设定是空白串（只有空格）：按没人处理，不算填了', async () => {
  const { photoPrompt } = await import('../src/photo.ts');
  // 设置页里多敲个空格太常见了，不能因此就画个人出来。
  const p = photoPrompt({ city: '天水', hour: 10, cast: '   ' });
  assert.match(p, /人影|行人|画面里没有人物/, `空白串被当成有人了：${p}`);
  assert.doesNotMatch(p, /画面里有一个人/);
});

test('设了人物：不再硬塞「真实旅行照片 / 胶片质感 / 路人视角」', async () => {
  /*
   * 2026-11-04 实测：配了二次元角色，出图还是写实风 —— 因为
   * 「一张真实旅行照片：」+「胶片质感，自然光」把 cast 里的 anime style 压过去了。
   * 风格该跟着人物走。
   */
  const { photoPrompt } = await import('../src/photo.ts');
  const p = photoPrompt({
    city: '九寨沟', spot: '甘海子', hour: 20,
    cast: 'anime style, a girl with fennec ears',
  });
  assert.doesNotMatch(p, /一张真实旅行照片/, `写实前缀没去掉：${p}`);
  assert.doesNotMatch(p, /胶片颗粒|胶片质感/, `胶片质感没去掉：${p}`);
  assert.match(p, /anime style/, '人物风格丢了');
});

test('「路过的人」不能出现在提示词里 —— 它会真画出人来', async () => {
  /*
   * 原来那句「视角像路过的人随手举起手机拍的」是想表达"随手拍、不完美"，
   * 但模型把"路过的人"当画面内容了：明确写着「画面里只有这一个人」，
   * 它照样画了两个背影。人不能进这句。
   */
  const { photoPrompt } = await import('../src/photo.ts');
  const withCast = photoPrompt({ city: '九寨沟', spot: '甘海子', hour: 10, cast: '一个女孩' });
  const noCast = photoPrompt({ city: '九寨沟', spot: '甘海子', hour: 10 });
  for (const [label, p] of [['有人', withCast], ['没人', noCast]]) {
    assert.doesNotMatch(p, /路过的人/, `${label}那张还带着「路过的人」：${p}`);
  }
});

test('没人也没指定风格：写实那套词照旧保留', async () => {
  /*
   * 这是老行为，改上面两处的时候不能把它碰掉。
   *
   * 机位那一句 2026-11-11 跟着 1.4.0 的提示词瘦身改了措辞：
   * 「视角自然随意，略微不完美，有生活感」17 字 → 「自然随手拍」6 字。
   * 这条断言原来锁的是「有生活感」，于是瘦身当版就挂在这里 ——
   * 锁的应该是**写实那一套还在**，不是某一版的原文。
   */
  const { photoPrompt } = await import('../src/photo.ts');
  const p = photoPrompt({ city: '天水', spot: '麦积山石窟', hour: 10 });
  assert.match(p, /一张真实旅行照片/);
  /*
   * 2026-11-12：「胶片质感，自然光，景深自然」整句删了 —— 两个总体判断词
   * 排在最后，会把前面算出来的光全部推翻。现在只留「胶片颗粒，轻微过曝」。
   */
  assert.match(p, /胶片颗粒/);
  assert.doesNotMatch(p, /自然光/, '「自然光」又回来了 —— 它会把夜写成白天');
  assert.match(p, /随手拍/, `机位那句丢了：${p}`);
});

test('尺寸被拒时，按候选挑最近的宽高比（MOSS-Image 实测报错原文）', async () => {
  /*
   * 2026-11-04 用户换 MOSS-Image 直接 400：
   *   image_size must be one of: 1024x1024 (1:1), 832x1216 (2:3), ...
   * 配置里填的 1664x928 不在枚举里，而它又是必填。
   */
  const { nearestSize } = await import('../src/photo.ts');
  const err = '{"code":20015,"message":"image_size must be one of: 1024x1024 (1:1), 832x1216 (2:3), '
    + '1216x832 (3:2), 896x1152 (3:4), 1152x896 (4:3), 768x1344 (9:16), 1344x768 (16:9), 1568x672 (21:9)"}';

  // 1664x928 是 16:9 附近；要挑同比例的 1344x768，不能挑像素更接近但更宽的 1568x672
  assert.equal(nearestSize(err, '1664x928'), '1344x768', '16:9 挑错了，画面会被横向拉长');
  // 竖图要挑竖的
  assert.equal(nearestSize(err, '1024x1536'), '832x1216', '2:3 竖图没挑到竖的档');
  assert.equal(nearestSize(err, '1024x1024'), '1024x1024');
  assert.equal(nearestSize(err, '2048x512'), '1568x672', '超宽比例应该挑最宽的档');
});

test('报错里没有候选列表时返回 null，交给后面的重试去删尺寸', async () => {
  const { nearestSize } = await import('../src/photo.ts');
  assert.equal(nearestSize('{"message":"image_size is required"}', '1664x928'), null);
  assert.equal(nearestSize('随便一段话', '1664x928'), null);
  assert.equal(nearestSize('', '1664x928'), null);
});

test('目标写成别的分隔符也认', async () => {
  const { nearestSize } = await import('../src/photo.ts');
  const err = 'must be one of: 1024x1024, 1344x768';
  assert.equal(nearestSize(err, '1664 × 928'), '1344x768');
  assert.equal(nearestSize(err, '1664*928'), '1344x768');
});

/* ---------------- 口味：真的写进状态、真的落盘（2026-11-05） ---------------- */

const tasteTool = (world) => world.tools().find((t) => t.name === 'journey_taste');

test('口味：空表读一次、写三条、再读回来都在，而且落了盘', async () => {
  const { world, dir } = await makeWorld();
  const tool = tasteTool(world);
  assert.ok(tool, '工具表里没有 journey_taste');

  const empty = await tool.handler({});
  assert.match(empty.text, /还是空的/, `空表没说实话：${empty.text}`);

  const one = await tool.handler({ kind: 'place', name: '玉泉观', note: '黄昏最好看' });
  assert.match(one.text, /记下了/, `写一条没回执：${one.text}`);
  await tool.handler({ kind: 'food', name: '牦牛肉汤', note: '烫' });
  await tool.handler({ kind: 'scenery', name: '雪山', note: '冬天才对' });

  const all = await tool.handler({});
  assert.match(all.text, /玉泉观/);
  assert.match(all.text, /牦牛肉汤/);
  assert.match(all.text, /雪山/);

  /*
   * 换台机器也要还在：这是记忆，不是本机状态。
   * 位置跟着日记目录走（同一个同步盘文件夹），没配同步盘时就在 dataDir/diary 下。
   */
  const memFile = ['travel-memory.json', join('diary', 'travel-memory.json')]
    .map((f) => join(dir, f)).find((f) => existsSync(f));
  assert.ok(memFile, '记忆文件没落盘，换台机器就丢了');
  const saved = readFileSync(memFile, 'utf8');
  assert.ok(saved.includes('玉泉观'), '没写进 travel-memory.json，换台机器就丢了');
});

test('口味：类别写错时说清只有三类，不静默吞掉', async () => {
  const { world } = await makeWorld();
  const r = await tasteTool(world).handler({ kind: 'music', name: '民谣' });
  assert.match(r.text, /place/, '没告诉她合法的三类');
  assert.equal(r.text.includes('记下了'), false, '写错了还说记下了');
});
