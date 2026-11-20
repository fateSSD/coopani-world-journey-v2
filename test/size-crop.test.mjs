/**
 * 出图尺寸 + 去水印。
 *
 * 这两块共同的风险是「错了也不报错」：
 * - 尺寸没生效 → 用户以为选项没用，图还是方的
 * - 裁切解错 → 出一条横向错位的图，看起来像模型抽风
 * 所以测的重点是「结果对不对」，不是「函数跑没跑」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';

const { parseSize, withSize, align8 } = await import('../src/comfy.ts');
const { cropBottom, WATERMARK_CROP_RATIO } = await import('../src/png-crop.ts');

/* ---------- 造一张最小的合法 PNG 用来测裁切 ---------- */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i += 1) c = (CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bitDepth
  ihdr[9] = 6;   // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y += 1) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < w; x += 1) {
      const o = y * (stride + 1) + 1 + x * 4;
      raw[o] = 20 + y; raw[o + 1] = 40; raw[o + 2] = 60; raw[o + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** 从 PNG 里读宽高，用来验证裁完真的变矮了。 */
function sizeOf(png) {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [v.getUint32(16), v.getUint32(20)];
}

/* ---------- 尺寸 ---------- */

test('尺寸解析：三种分隔符都认，越界和不认识的要拒', () => {
  assert.deepEqual(parseSize('1664x928'), [1664, 928]);
  assert.deepEqual(parseSize(' 928 × 1664 '), [928, 1664], '全角乘号 + 空格要认');
  assert.deepEqual(parseSize('1024*1024'), [1024, 1024], '星号要认');
  assert.equal(parseSize(''), null);
  assert.equal(parseSize('1024'), null, '缺高度');
  assert.equal(parseSize('abc'), null);
  assert.equal(parseSize('99x99'), null, '太小画不出，要拒');
  assert.equal(parseSize('9999x9999'), null, '太大直接吃满显存，要拒');
});

test('尺寸吸附到 8 的倍数（VAE 下采样 8 倍）', () => {
  assert.equal(align8(1365), 1368);
  assert.equal(align8(1664), 1664);
  assert.equal(align8(927), 928);
});

test('改尺寸只动根 latent 节点，放大节点一个不许碰', () => {
  /*
   * 放大节点也有 width/height。如果一起改成目标尺寸，
   * 工作流原本的「2 倍放大」就没了 —— 出来尺寸不对，而且零报错。
   */
  const wf = {
    '1': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '2': { class_type: 'LatentUpscale', inputs: { samples: ['9', 0], width: 2048, height: 2048, crop: 'disabled' } },
    '3': { class_type: 'SaveImage', inputs: { filename_prefix: 'x' } },
  };
  const n = withSize(wf, 1664, 928);
  assert.equal(n, 1, `应该只改一个节点，实际 ${n}`);
  assert.equal(wf['1'].inputs.width, 1664);
  assert.equal(wf['1'].inputs.height, 928);
  assert.equal(wf['2'].inputs.width, 2048, '放大节点被改坏了');
  assert.equal(wf['3'].inputs.filename_prefix, 'x', '无关节点被动了');
});

test('没有 latent 节点时返回 0，让上层能报错而不是假装成功', () => {
  assert.equal(withSize({ '1': { class_type: 'X', inputs: {} } }, 1024, 1024), 0);
});

/* ---------- 水印裁切 ---------- */

test('裁底边：高度变矮，宽度不变，还能正常解码', () => {
  const png = makePng(64, 64);
  assert.deepEqual(sizeOf(png), [64, 64]);
  const out = cropBottom(png, 0.25);
  const [w, h] = sizeOf(out);
  assert.equal(w, 64, '宽度不该变');
  assert.equal(h, 48, `高度应该是 64×0.75=48，实际 ${h}`);
  assert.equal(Buffer.from(out).subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 签名坏了');
});

test('裁完的像素值是对的 —— 不能被滤波搞歪', () => {
  /*
   * 这条是防「解出来的行是错位的」：错位不会报错，只会让画面出现横向条纹，
   * 看起来像是模型抽风。所以直接读回像素确认每一行的颜色还是原来的值。
   */
  const png = makePng(8, 8);
  const out = cropBottom(png, 0.4);   // 8 × 0.6 = 4.8 → 4 行
  const buf = Buffer.from(out);
  // 定位 IDAT
  let p = 8;
  let idat = null;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') { idat = buf.subarray(p + 8, p + 8 + len); break; }
    p += 12 + len;
  }
  assert.ok(idat, '没有 IDAT');
  const raw = inflateSync(idat);
  const stride = 8 * 4;
  assert.equal(raw.length, 4 * (stride + 1), '行数应该是裁完的 4 行');
  // 第 0 行第 0 个像素：原图是 (20, 40, 60)，Sub 滤波后第一个像素不减左边
  assert.equal(raw[1], 20, `R 通道不对：${raw[1]}`);
  assert.equal(raw[2], 40);
  assert.equal(raw[3], 60);
});

test('不认识的输入原样返回，绝不抛错', () => {
  // 裁不掉水印是小事，让拍照整个挂掉是大事。
  const junk = Buffer.from([1, 2, 3, 4]);
  assert.equal(cropBottom(junk, 0.08).length, 4, '非 PNG 应该原样返回');
  const png = makePng(32, 32);
  assert.equal(cropBottom(png, 0).length, png.length, 'ratio=0 应该原样返回');
  assert.equal(cropBottom(png, 0.9).length, png.length, 'ratio 大到离谱应该原样返回');
  assert.equal(cropBottom(Buffer.alloc(0), 0.08).length, 0);
});

test('水印切的比例够用：8% 落在实测的 6.8% 之上', () => {
  // 实测水印占底边 70/1024 = 6.8%。切少了会留一条上沿（第一版 6% 就是这个毛病）。
  assert.ok(WATERMARK_CROP_RATIO >= 0.068, `比例太小，会留残边：${WATERMARK_CROP_RATIO}`);
  assert.ok(WATERMARK_CROP_RATIO <= 0.12, `比例太大，白丢画面：${WATERMARK_CROP_RATIO}`);
});

test('多条并行支路的根 latent 都要改 —— 只改一路会出两张不同尺寸的图', () => {
  /*
   * 2026-11-04 跑真机时发现：注释写「只改主 latent」，实现却是全改。
   * 想清楚后保留全改 —— 用户填尺寸的意图是「出来的图都要这个尺寸」，
   * 而扩展只取返回的第一张图，另一路不改就白算了。
   */
  const wf = {
    '1': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '2': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  };
  const n = withSize(wf, 1664, 928);
  assert.equal(n, 2, `应该两条都改，实际改了 ${n} 条`);
  assert.equal(wf['1'].inputs.width, 1664);
  assert.equal(wf['2'].inputs.width, 1664, '第二条支路没改，会出一张尺寸不对的图');
});

/* ---------- 种子：必须每次不同，否则 ComfyUI 命中缓存秒回同一张 ---------- */

test('种子每次都要换 —— 固定种子会让 ComfyUI 一秒返回上一张', async () => {
  /*
   * 2026-11-04 Mr.Q：「点生成一张，1s 生成了 3 张」。
   * 根因是 workflow 里 seed 固定 42，同提示词必然命中执行缓存。
   * 附图影响：缓存一秒就回，maybePhoto 的「上一张没拍完」锁来不及挡连点。
   */
  const { randomizeSeed } = await import('../src/comfy.ts');
  const wf = {
    '1': { class_type: 'KSampler', inputs: { seed: 42, steps: 20 } },
    '2': { class_type: 'KSamplerAdvanced', inputs: { noise_seed: 42 } },
  };
  const n = randomizeSeed(wf, () => 0.5);
  assert.equal(n, 2, `应该改两个种子，实际 ${n}`);
  assert.notEqual(wf['1'].inputs.seed, 42, 'seed 没变 —— 会命中缓存');
  assert.notEqual(wf['2'].inputs.noise_seed, 42, 'noise_seed 没变');
  // 同一个随机源，两次结果必须一致（便于测试），但都不等于原值
  const wf2 = { '1': { class_type: 'KSampler', inputs: { seed: 42 } } };
  randomizeSeed(wf2, () => 0.5);
  assert.equal(wf2['1'].inputs.seed, wf['1'].inputs.seed);
});

test('连线过来的种子不许动 —— 那是用户自己安排的随机', async () => {
  const { randomizeSeed } = await import('../src/comfy.ts');
  const wf = { '1': { class_type: 'KSampler', inputs: { seed: ['12', 0] } } };
  const n = randomizeSeed(wf);
  assert.equal(n, 0, '连线的种子被当成字面量改了');
  assert.deepEqual(wf['1'].inputs.seed, ['12', 0]);
});

/* ---------- 照片簿：同一张图拍多次只能留一条 ---------- */

test('同一张图拍多次，照片簿只留一条', async () => {
  /*
   * 原来的 replaceDay 条件是 `handle !== keepHandle`，
   * 意味着同 handle 的旧记录一条都删不掉 —— 重复拍就堆 N 条一样的。
   */
  const { PhotoBook } = await import('../src/photo-book.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pb-'));

  const book = new PhotoBook(dir);
  const rec = (h, at) => ({ handle: h, cityId: 'jiuzhaigou', cityName: '九寨沟', dateKey: '2026-11-04', title: '黄昏的甘海子', spot: '甘海子', at });

  // 连拍三次，宿主的句柄完全相同（同一张图）
  book.add(rec('log:aaa.png', '2026-11-04T13:47:44Z'));
  book.add(rec('log:aaa.png', '2026-11-04T13:48:11Z'));
  book.add(rec('log:aaa.png', '2026-11-04T13:49:55Z'));
  assert.equal(book.count(), 3, '准备阶段应该是 3 条');
  book.replaceDay('2026-11-04', 'jiuzhaigou', 'log:aaa.png');
  assert.equal(book.count(), 1, `同城同日应该只剩 1 条，实际 ${book.count()} 条`);
  assert.equal(book.list()[0].at, '2026-11-04T13:49:55Z', '留下的应该是最新那条');
});

test('换成不同的 handle 时，旧记录照样被替换掉（原行为不能丢）', async () => {
  const { PhotoBook } = await import('../src/photo-book.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pb2-'));
  const book = new PhotoBook(dir);
  const mk = (h, city) => ({ handle: h, cityId: city, cityName: city, dateKey: '2026-11-04', title: 't', spot: '', at: '2026-11-04T00:00:00Z' });
  book.add(mk('log:old.png', 'jiuzhaigou'));
  book.add(mk('log:new.png', 'jiuzhaigou'));
  book.add(mk('log:other.png', 'lasa'));       // 别的城市，不该被动
  book.replaceDay('2026-11-04', 'jiuzhaigou', 'log:new.png');
  assert.equal(book.count(), 2, '应该剩「九寨沟新的 + 拉萨那张」');
  assert.ok(book.list().some((p) => p.handle === 'log:new.png'));
  assert.ok(book.list().some((p) => p.handle === 'log:other.png'), '别的城市被误删了');
  assert.ok(!book.list().some((p) => p.handle === 'log:old.png'));
});

/* ---------- 水印：该裁谁、不该裁谁（2026-11-20） ---------- */

test('水印：方舟系不用裁 —— 它认 watermark:false，而且固定出 JPEG', async () => {
  /*
   * 读者原话：「方舟回来是 JPEG 就裁不了（日志里会写一句）」。
   *
   * 查了官方文档，两件事都是写死的：
   *   - `watermark: false` = 不添加「AI生成」；
   *   - `doubao-seedream-4.5/4.0/3.0-t2i/seededit-3.0-i2i` 的**文件格式固定 jpeg，不支持自定义**。
   *
   * 所以那边根本没有水印可裁。原来 `auto` 按「是不是云端」判，等于对一个不需要裁的后端
   * 下了裁的命令 —— 裁不了、再记一句日志，让人以为功能坏了；真裁成了还会白丢 8% 画面。
   */
  const { shouldCropWatermark } = await import('../src/helpers.ts');
  assert.equal(shouldCropWatermark('auto', 'openai', true), false, '方舟系在 auto 下不该裁');
  assert.equal(shouldCropWatermark('auto', 'openai', false), true, '别家云端照旧裁');
  assert.equal(shouldCropWatermark('auto', 'comfyui', true), false, '本地本来就没有水印');
  /* 手填 crop 是显式要求：他就是要那条没，哪怕本来没水印。 */
  assert.equal(shouldCropWatermark('crop', 'openai', true), true);
  assert.equal(shouldCropWatermark('off', 'openai', false), false);
  /* 不传第三个参数 = 老行为，旧的调用处一个字都不用改。 */
  assert.equal(shouldCropWatermark('auto', 'openai'), true);
});

test('照片簿：参考图名单要能活过重启，否则重拍会换脸', async () => {
  /*
   * `load()` 是**白名单重建**：磁盘上有什么不算数，代码里列了几格才读得回来。
   * 2026-11-20 之前 `refs` 没在这一列里 —— 于是「重拍沿用当初那份名单」
   * 只在同一次运行里成立，重启 Core 之后退回当前配置：相册里那张还是旧的，
   * 人却换了一个，而且没有任何提示。
   */
  const { PhotoBook } = await import('../src/photo-book.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pb-refs-'));
  const rec = {
    handle: 'log:aaa.png', cityId: 'lasa', cityName: '拉萨', dateKey: '2026-11-20',
    title: '布达拉宫的清晨', spot: '布达拉宫', at: '2026-11-20T01:00:00Z',
    prompt: '一张真实旅行照片：拉萨布达拉宫。', refs: ['ref-1.png', 'ref-2.png'],
  };
  new PhotoBook(dir).add(rec);

  const reloaded = new PhotoBook(dir).list()[0];
  assert.deepEqual(reloaded.refs, ['ref-1.png', 'ref-2.png'], '参考图名单没过重载');
  assert.equal(reloaded.prompt, rec.prompt, '提示词也没过重载 —— 同一类漏项');
});

