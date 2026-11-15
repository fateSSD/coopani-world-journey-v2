/**
 * 负向提示词必须真的传下去 —— 2026-11-06
 *
 * 用户（Jo）19:05 来信：
 * 「更新到 0.8.4 试了一下，补拍似乎负向提示词没生效。可以再调查一下吗」
 *
 * **他说得对。** 0.8.2 加负向的时候只改到了「出海报」那一条路，
 * 主拍照（也就是他说「补一张」走的那条）一个字都没传。设置填了、界面也认了，
 * 但请求里根本没有这个字段 —— 表现就是「填了没用」。
 *
 * 这类漏法的特点是**不报错**：参数是可选的，少传一个编译器不会说话。
 * 所以只能用静态检查守住：源码里每一处 `shootComfy({` 都必须带 `negative:`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { cityById } = await import('../src/geo/cities.ts');

const src = readFileSync(new URL('../src/world-photo.ts', import.meta.url), 'utf8');

test('maybePhoto 走 ComfyUI 时真的把负向提示词写进提交的工作流，且所有 shootComfy 调用都不漏传', async () => {
  const blocks = src.split('shootComfy({').slice(1);
  assert.ok(blocks.length >= 2, `只找到 ${blocks.length} 处 shootComfy —— 少了一条路径`);
  for (const [i, b] of blocks.entries()) {
    const seg = b.slice(0, 700);
    assert.ok(seg.includes('negative:'), `第 ${i + 1} 处 shootComfy 没传 negative —— 填了也不生效`);
    assert.ok(seg.includes('negativeNode:'), `第 ${i + 1} 处没传 negativeNode`);
  }

  // 行为断言：实际触发一次 ComfyUI 拍照，看提交给 /prompt 的工作流节点是否带上了用户配置的负向词
  const dir = mkdtempSync(join(tmpdir(), 'jr-neg-'));
  const wf = JSON.stringify({
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'pos' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'neg' } },
    '3': { class_type: 'KSampler', inputs: { positive: ['6', 0], negative: ['7', 0], seed: 1 } },
  });
  const w = new JourneyWorld({
    cfg: {
      ...JOURNEY_DEFAULTS(),
      enabled: true,
      imageProtocol: 'comfyui',
      imageApi: 'http://127.0.0.1:8188',
      imageWorkflow: wf,
      comfyNegative: 'watermark, extra fingers',
      comfyNegativeNode: '7',
    },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-06T08:00:00Z'),
  });
  let submitted = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/prompt')) {
      submitted = JSON.parse(String(init?.body ?? '{}'));
      return new Response('stop-after-capture', { status: 500 });
    }
    return new Response('err', { status: 500 });
  };
  try {
    await w.maybePhoto(cityById('chengdu'), 16, '2026-11-06', '宽窄巷子', null, true);
    assert.ok(submitted?.prompt?.['7']?.inputs?.text?.includes('watermark, extra fingers'),
      `提交给 ComfyUI 的负向节点里没有用户的负向提示词：${JSON.stringify(submitted?.prompt?.['7'])}`);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('每一处出图调用都接受超时配置', () => {
  /*
   * 同一个人 19:08 又提：「180 秒的渲染超时是否能扩展一些时间，
   * 有概率会图没渲染完导致失效」。
   *
   * 超时以前写死在代码里，大图根本等不完。现在走配置，
   * 每一条出图路径都得把 `timeoutMs` 传下去 —— 漏一条就是「改了没用」。
   */
  for (const fn of ['shootComfy({', 'shootPhoto({']) {
    const blocks = src.split(fn).slice(1);
    assert.ok(blocks.length >= 1, `没找到 ${fn}`);
    for (const [i, b] of blocks.entries()) {
      const seg = b.slice(0, 800);
      assert.ok(seg.includes('timeoutMs'), `${fn} 第 ${i + 1} 处没传 timeoutMs`);
    }
  }
});
