/**
 * 题材参数必须真的接到线上 —— 2026-11-06
 *
 * ## 现场
 *
 * 19:47:55 他对她说「让我看看你晚上吃的嘛~」
 * 19:47:55 她调 `journey_photo {"subject":"food"}`（reasoning 里写得明明白白）
 * 19:48:04 出的图标题是「**黄昏的宽窄巷子**」
 *
 * 她的下一句 reasoning 是：「The photo came: 黄昏的宽窄巷子… It didn't say food.」
 * 然后她只能改口说「吃的还没上桌」。
 *
 * ## 根因（两处，同一种病）
 *
 * 1. `takePhotoForUser(view, subject)` 收了 `subject`，调 `maybePhoto` 时没传——
 *    那个参数有默认值 `'ground'`，于是六个模板永远走第一套。
 * 2. `photoTitle(city, spot, hour, view)` 压根不认识 `subject`——
 *    就算图对了，回执里的标题还是「黄昏的XX」，而她只会照着标题说话。
 *
 * **这是第三次了。** 前两次是 0.8.2 的 `negative`、0.8.5 的 `subject` 本身。
 * 共同点：参数可选、默认值合法、漏传不报错、表现是「改了等于没改」。
 *
 * 所以这组测试不看行为，只看**源码里那条线断没断**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const world = readFileSync(new URL('../src/world-photo.ts', import.meta.url), 'utf8');

test('takePhotoForUser 把 subject 传给了 maybePhoto', async () => {
  /*
   * 行为断言：调用 takePhotoForUser('ground', 'food', ...) 时，
   * maybePhoto 收到的第 8 个参数（subject）必须是 'food'，而不是默认的 'ground'。
   */
  const dir = mkdtempSync(join(tmpdir(), 'jr-photo-wire-'));
  const w = new JourneyWorld({
    cfg: {
      ...JOURNEY_DEFAULTS(),
      enabled: true,
      imageProtocol: 'openai',
      imageApi: 'https://api.example.com/v1',
      imageModel: 'flux',
      imageKey: 'sk-test',
    },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-06T12:00:00Z'),
  });
  w.st = { ...w.st, phase: 'staying', hereId: 'chengdu', stayStartedAt: '2026-11-06T00:00:00Z' };
  let capturedSubject = null;
  w.maybePhoto = async (_city, _hr, _dk, _spot, _weather, _replace, _onRoad, _mode, _view, subject) => {
    capturedSubject = subject;
    return { ok: true, title: '成都的晚饭' };
  };
  await w.takePhotoForUser('ground', 'food', '', '');
  assert.equal(capturedSubject, 'food',
    'takePhotoForUser 没把 subject 传给 maybePhoto —— 六个题材模板全都用不上，「拍晚饭」出来的还是那处风景');
});

test('photoTitle 的每一处调用都带题材', () => {
  /* 定义那行不算调用。 */
  const calls = world.split('photoTitle(').slice(1);
  assert.ok(calls.length >= 1, 'world.ts 里找不到 photoTitle 调用');
  for (const [i, c] of calls.entries()) {
    const seg = c.slice(0, 200);
    assert.ok(
      seg.includes('subject'),
      `第 ${i + 1} 处 photoTitle 没传 subject —— 图对了，回执里的标题还是错的，`
      + '她会照着标题跟他说另一个地方',
    );
  }
});

test('标题跟着题材走，不是永远「黄昏的某处」', async () => {
  const { photoTitle } = await import('../src/photo.ts');
  const base = photoTitle('成都', '宽窄巷子', 20);
  assert.equal(base, '黄昏的宽窄巷子', 'ground 的老行为不该动');
  for (const s of ['food', 'street', 'detail', 'festival']) {
    const t = photoTitle('成都', '宽窄巷子', 20, 'ground', s);
    assert.notEqual(t, base, `题材 ${s} 的标题和 ground 一样 —— 她还是会说错话`);
  }
  /* 20 点吃的是晚饭，不是早饭。 */
  assert.equal(photoTitle('成都', '宽窄巷子', 20, 'ground', 'food'), '宽窄巷子的晚饭');
  assert.equal(photoTitle('成都', '宽窄巷子', 8, 'ground', 'food'), '宽窄巷子的早饭');
  /* 没景点名就用城市名，不能出现「的晚饭」这种半个词。 */
  assert.equal(photoTitle('成都', '', 20, 'ground', 'food'), '成都的晚饭');
});

