import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { scalePng } = await import('../src/png-crop.ts');
const { shootPhoto } = await import('../src/photo.ts');

/* ---------- 最小 PNG 生成（8 位 RGBA，filter 0） ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function makePng(w, h, fill = 0x80) {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w); v.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y += 1) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < stride; x += 1) raw[y * (stride + 1) + 1 + x] = fill;
  }
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw)))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const size = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const pngB64 = (n = 8) => Buffer.from(makePng(n, n)).toString('base64');
const pngDataUri = (n = 8) => `data:image/png;base64,${pngB64(n)}`;

function fakeFetch(handler) {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    return handler(calls.length, body);
  };
  return { calls, restore: () => { globalThis.fetch = prev; } };
}
const okJson = () => new Response(JSON.stringify({ data: [{ b64_json: pngB64() }] }), {
  status: 200, headers: { 'content-type': 'application/json' },
});

function makeWorld(dir, cfg = {}) {
  return new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, imageUseRefs: false, ...cfg },
    dataDir: dir,
    botName: '大肥鱼',
  });
}

/* ---------- 请求体 ---------- */

test('空 refs：请求体里没有 image 字段，与旧版逐字段一致', async () => {
  const { calls, restore } = fakeFetch(okJson);
  try {
    const base = { api: 'https://api.example.com/v1', key: 'k', prompt: 'p', size: '1024x1024' };
    await shootPhoto(base);
    // 空数组与不传，必须走同一条路：不能因为"配了个空列表"就多出字段
    await shootPhoto({ ...base, refs: [] });
    assert.equal(calls.length, 2);
    assert.equal('image' in calls[0].body, false, '没有参考图时不许出现 image 字段');
    assert.deepEqual(calls[1].body, calls[0].body, '空 refs 与不传 refs 的请求体必须一模一样');
  } finally { restore(); }
});

test('带 refs：image 是 data URI 数组，且只在传了才出现', async () => {
  const { calls, restore } = fakeFetch(okJson);
  try {
    const refs = [pngDataUri(6), pngDataUri(7), pngDataUri(8)];
    const out = await shootPhoto({ api: 'https://x/v1', key: 'k', prompt: 'p', refs });
    assert.deepEqual(calls[0].body.image, refs);
    assert.equal(calls[0].body.image.length, 3);
    assert.equal(out.refsDropped, undefined);
  } finally { restore(); }
});

test('服务端拒收 image：去掉后重发一次，并标记 refsDropped', async () => {
  const { calls, restore } = fakeFetch((n) => (n === 1
    ? new Response(JSON.stringify({ error: { message: 'image is not supported' } }), { status: 400 })
    : okJson()));
  try {
    const out = await shootPhoto({ api: 'https://x/v1', key: 'k', prompt: 'p', refs: [pngDataUri()] });
    assert.equal(calls.length, 2, '应该只重发一次');
    assert.ok('image' in calls[0].body);
    assert.equal('image' in calls[1].body, false, '重发时必须去掉 image');
    assert.equal(out.refsDropped, true);
  } finally { restore(); }
});

test('服务端拒收 image 且第二次仍失败：如实报错，不无限重试', async () => {
  const { calls, restore } = fakeFetch(() => new Response('bad', { status: 500 }));
  try {
    await assert.rejects(
      () => shootPhoto({ api: 'https://x/v1', key: 'k', prompt: 'p', refs: [pngDataUri()] }),
      /HTTP 500/,
    );
    assert.equal(calls.length, 1, '500 不是 image 的锅，不该重发');
  } finally { restore(); }
});

/* ---------- 压图 ---------- */

test('scalePng：长边超限按比例缩，短边跟着缩，仍是合法 PNG', () => {
  const src = makePng(300, 200);
  const out = scalePng(src, 160);
  const iv = new DataView(out.buffer, out.byteOffset + 16, 8);
  assert.equal(iv.getUint32(0), 160, '长边应缩到 160');
  assert.equal(iv.getUint32(4), 107, '短边按比例：200 × 160/300 ≈ 107');
  // 再缩一次不应该继续变（已经够小）
  assert.equal(scalePng(out, 160), out);
  // 不认识的东西原样返回，绝不抛错
  assert.equal(scalePng(new Uint8Array([1, 2, 3]), 160).length, 3);
});

/* ---------- 图鉴取图 ---------- */

test('collectRefPaths：默认关 / 开了才读 / 只取命中条目', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journey-refs-'));
  try {
    const root = join(dir, 'lib');
    const charDir = join(root, 'characters', 'fish');
    mkdirSync(charDir, { recursive: true });
    writeFileSync(join(charDir, 'entry.json'), JSON.stringify({
      id: 'fish', category: 'characters', name: '大肥鱼', aliases: ['肥鱼'],
      appearance: '蓝白配色', images: ['ref-1.png', 'ref-2.png', 'ref-3.png'],
    }));
    writeFileSync(join(charDir, 'ref-1.png'), makePng(8, 8));
    writeFileSync(join(charDir, 'ref-2.png'), makePng(8, 8));
    writeFileSync(join(charDir, 'ref-3.png'), makePng(8, 8));
    writeFileSync(join(dir, 'life-public.json'), JSON.stringify({ libraryDir: root }));

    const off = makeWorld(dir, { imageUseRefs: false, imageCast: '蓝白少女' });
    assert.deepEqual(off.collectRefPaths('ground', true, '', '大肥鱼', '').paths, [], '默认关：一张都不读');

    const on = makeWorld(dir, { imageUseRefs: true, imageCast: '蓝白少女' });
    const picked = on.collectRefPaths('ground', true, '', '大肥鱼', '');
    assert.equal(picked.paths.length, 2, '人物条目最多两张');
    assert.ok(picked.paths.every((p) => p.endsWith('.png')));

    // 抬头拍天不带人
    assert.deepEqual(on.collectRefPaths('sky', true, '', '大肥鱼', '').paths, []);

    /*
     * 手填补充（2026-11-20 改了口径）。
     *
     * 原来这条断言写的是「castOn=false 也要拿到手填的两张」—— 而那正是读者报的毛病：
     * 空镜照样带人物参考图，出来「有时画她有时不画」、多张还会复制出两条尾巴。
     * 现在手填跟图鉴同一条闸：这张有她才发；想让某张永远带（画风参考），行首加 `*`。
     */
    const manual = makeWorld(dir, { imageUseRefs: true, imageRefs: 'manual-a.png\n\nmanual-b.png' });
    assert.deepEqual(manual.collectRefPaths('ground', false, '', '', '').paths, [], '空镜不该带手填的参考图');
    const got = manual.collectRefPaths('ground', true, '', '', '');
    // 图鉴那条 `大肥鱼` 给 2 张，手填再补 2 张 —— 一共 4 张。
    assert.equal(got.paths.length, 4, `有她那张该是图鉴 2 + 手填 2，实际 ${got.paths.length}`);
    assert.ok(got.paths.some((p) => p.endsWith('manual-a.png')), '手填的那张没进名单');
    assert.ok(got.paths[0].startsWith(dir), '相对路径按 dataDir 解析');

    // `*` = 显式声明「任何一张都带」
    const starred = makeWorld(dir, { imageUseRefs: true, imageRefs: `*${join(dir, 'always.png')}\nmanual-c.png` });
    const dry = starred.collectRefPaths('ground', false, '', '', '');
    assert.deepEqual(dry.paths, [join(dir, 'always.png')], '带星号那张空镜也要发，没星号的照旧不发');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRefDataUrls：读不到 / 不是图片 / 太大都跳过，绝不抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journey-refs2-'));
  try {
    const good = join(dir, 'good.png');
    writeFileSync(good, makePng(12, 12));
    const junk = join(dir, 'junk.png');
    writeFileSync(junk, Buffer.from('not an image at all'));
    const missing = join(dir, 'missing.png');

    const w = makeWorld(dir);
    const pack = w.loadRefDataUrls([good, junk, missing]);
    assert.equal(pack.urls.length, 1, '只有那张好图能用');
    assert.equal(pack.urls[0].startsWith('data:image/png;base64,'), true);
    assert.deepEqual(pack.names, ['good.png']);
    assert.equal(pack.dropped.length, 2, '不是图片 + 读不到，各记一条');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refsAllowedBackend：只放行方舟系，别家一律不发图', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journey-refs3-'));
  try {
    const doubao = makeWorld(dir, { imagePreset: 'doubao' });
    assert.equal(doubao.refsAllowedBackend({ api: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-5-0-flash' }), true);

    const arkByModel = makeWorld(dir, { imagePreset: 'custom' });
    assert.equal(arkByModel.refsAllowedBackend({ api: 'https://example.com/v1', model: 'doubao-seedream-5-0-flash' }), true);

    const openai = makeWorld(dir, { imagePreset: 'openai' });
    assert.equal(openai.refsAllowedBackend({ api: 'https://api.openai.com/v1', model: 'gpt-image-1' }), false);

    const silicon = makeWorld(dir, { imagePreset: 'custom' });
    assert.equal(silicon.refsAllowedBackend({ api: 'https://api.siliconflow.cn/v1', model: 'Kwai-Kolors/Kolors' }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hasPersonRef：仅带 * 画风图或场景图时不清空人物文字描述；castFromRef 不塞写实胶片底色', async () => {
  const { photoPrompt } = await import('../src/photo.ts');
  const dir = mkdtempSync(join(tmpdir(), 'journey-refs4-'));
  try {
    const w = makeWorld(dir, { imageUseRefs: true, imageRefs: `*${join(dir, 'style.png')}` });
    const picked = w.collectRefPaths('ground', true, '', '蓝白少女', '');
    assert.equal(picked.paths.length, 1);
    assert.equal(picked.hasPersonRef, false, '带星号画风图不该算人物参考图');

    const prompt = photoPrompt({
      city: '成都',
      cityId: 'chengdu',
      hour: 14,
      castFromRef: true,
    });
    assert.doesNotMatch(prompt, /真实旅行照片|胶片颗粒/, `castFromRef 不该被硬塞写实底色：${prompt}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
