/**
 * 碰面地址的多值与「读不成」判据（2026-11-21）。
 *
 * 两件事钉在一起，因为它们指向同一个 bug：
 *   ① 配置层认多值（为联邦留位置，运行时只连第一台）；
 *   ② 「配没配」不能只看字符串非空 —— 填了 `ftp://bad` 时非空为真，
 *      而所有请求一次都没发出去，面板却亮绿灯说「这段时间没别人」。
 *
 * 第 ② 条是**今天就在骗人**的那一处，不是多值引入的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { normalizeMeetTargets, MEET_MAX_TARGETS } = await import('../src/meet.ts');
const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

const NOW = new Date('2026-11-21T06:00:00.000Z');

/* ---------------- normalizeMeetTargets ---------------- */

test('没填：bases 空、error 空 —— 「没填」不是错', () => {
  for (const raw of ['', '   ', [], null, undefined]) {
    const f = normalizeMeetTargets(raw);
    assert.deepEqual(f.bases, [], `${JSON.stringify(raw)} 不该解析出地址`);
    assert.equal(f.error, '', `${JSON.stringify(raw)} 不该报错`);
    assert.equal(f.note, '');
  }
});

test('单值原样可用：行为与 normalizeMeetUrl 一致', () => {
  const f = normalizeMeetTargets('https://cooppetsjourney.top');
  assert.deepEqual(f.bases, ['https://cooppetsjourney.top']);
  assert.equal(f.total, 1);
  assert.equal(f.fixed, '');
  assert.equal(f.note, '', '单台不该多说一句');
});

test('分隔符：空格 / 逗号 / 分号 / 全角都能切', () => {
  for (const sep of [' ', ',', '，', ';', '；', '\n', '\t']) {
    const f = normalizeMeetTargets(`https://a.example${sep}https://b.example`);
    assert.deepEqual(f.bases, ['https://a.example', 'https://b.example'], `${JSON.stringify(sep)} 没切开`);
  }
});

test('尾逗号不产生空项 —— 空项若混进 bases，会被当成「配了一台」', () => {
  const f = normalizeMeetTargets('https://a.example,');
  assert.deepEqual(f.bases, ['https://a.example']);
  assert.equal(f.total, 1);
});

test('数组：手改 config.json 写数组也认', () => {
  const f = normalizeMeetTargets(['https://a.example', 'https://b.example']);
  assert.deepEqual(f.bases, ['https://a.example', 'https://b.example']);
  assert.equal(f.total, 2);
});

test('数组项里夹着逗号：再切一层', () => {
  const f = normalizeMeetTargets(['https://a.example,https://b.example']);
  assert.deepEqual(f.bases, ['https://a.example', 'https://b.example']);
});

test('去重：https://a 与 https://a/ 是同一条', () => {
  const f = normalizeMeetTargets('https://a.example,https://a.example/');
  assert.deepEqual(f.bases, ['https://a.example']);
  assert.equal(f.total, 1);
  assert.equal(f.note, '');
});

test('超过上限：只留前 3，并说清为什么', () => {
  const raw = ['a', 'b', 'c', 'd', 'e'].map((x) => `https://${x}.example`).join(',');
  const f = normalizeMeetTargets(raw);
  assert.equal(MEET_MAX_TARGETS, 3);
  assert.equal(f.bases.length, 3);
  assert.equal(f.total, 5);
  assert.match(f.note, /最多连 3 个城/, f.note);
});

test('两台：说「只连第一台」，并点名是哪一台', () => {
  const f = normalizeMeetTargets('https://a.example,https://b.example');
  assert.equal(f.bases.length, 2, '解析层要保留两台 —— 运行时取第一台是另一层的事');
  assert.match(f.note, /只连第一台：a\.example/, f.note);
  assert.match(f.note, /另外 1 个地址/, f.note);
});

test('全非法：bases 空、error 说原因', () => {
  const f = normalizeMeetTargets('ftp://bad');
  assert.deepEqual(f.bases, []);
  assert.match(f.error, /只认 http 和 https/, f.error);
});

test('部分非法：好的照用，坏的在 note 里说一句', () => {
  const f = normalizeMeetTargets('ftp://bad,https://a.example');
  assert.deepEqual(f.bases, ['https://a.example']);
  assert.equal(f.error, '', '有一条能用就不算全废');
  assert.match(f.note, /另有 1 个地址读不成/, f.note);
});

test('协议漏了照样补 —— 复用 normalizeMeetUrl，不重写', () => {
  const f = normalizeMeetTargets('a.example');
  assert.deepEqual(f.bases, ['https://a.example']);
  assert.match(f.fixed, /https:\/\//);
});

test('多出一条尾斜杠的重复项，不该被当成「填了两台」', () => {
  const f = normalizeMeetTargets('https://a.example/,https://a.example///');
  assert.equal(f.total, 1);
  assert.equal(f.note, '', '重复项不算多台，不该提示');
});

/* ---------------- 面板上的 social ---------------- */

function boot(cfg = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-meet-targets-'));
  new StateStore(dir).save({
    ...initialState('lanzhou'),
    phase: 'staying',
    hereId: 'luoyang',
    tripStartedAt: '2026-11-01T00:00:00.000Z',
    stayStartedAt: '2026-11-08T09:00:00.000Z',
  });
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', ...cfg },
    dataDir: dir,
    botName: '测试',
    now: () => NOW,
  });
  const host = {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    pushEvent: async (e) => ({ ...e, blobs: [] }),
    pushDeferred: () => {},
    store: {},
    drainPendingEvents: async () => [],
  };
  w.start(host);
  return w;
}

test('全非法地址：social 必须报不可用，不能亮绿灯', () => {
  /*
   * 这是修之前的样子：`configured` 只判非空 → true；
   * `meetOptions()` 返回 null → 请求全跳过 → `lastMeetOk` 停在 null；
   * `online = lastMeetOk !== false` → **true**。
   * 面板于是写「这段时间没别人」，用户以为只是没人。
   */
  const w = boot({ meetUrl: 'ftp://bad' });
  const s = w.uiSnapshot().social;
  assert.ok(s, '填了但读不成，也要出一条 —— 否则用户以为没生效');
  assert.equal(s.online, false, '读不成 ≠ 在线');
  assert.match(s.urlIssue, /只认 http 和 https/, `原因要带出来：${s.urlIssue}`);
});

test('没填：social 仍是 null，面板不多出一行空壳', () => {
  const w = boot({ meetUrl: '' });
  assert.equal(w.uiSnapshot().social, null);
});

test('填两台：主面板要出现「只连第一台」', () => {
  const w = boot({ meetUrl: 'https://a.example,https://b.example' });
  const s = w.uiSnapshot().social;
  assert.ok(s);
  assert.equal(s.online, true, '解析得出来就当在线，这跟「只连一台」是两件事');
  assert.match(s.urlNote, /只连第一台/, `主面板要看得见：${s.urlNote}`);
  assert.equal(s.urlIssue, '', '地址是好用的，不该报读不成');
});

test('单台不许多嘴：urlNote 为空', () => {
  const w = boot({ meetUrl: 'https://cooppetsjourney.top' });
  const s = w.uiSnapshot().social;
  assert.ok(s);
  assert.equal(s.urlNote, '');
  assert.equal(s.urlIssue, '');
});

test('meetUsable 是纯判断：不生成 uid 文件', () => {
  /*
   * `uiSnapshot()` 每次开面板都走一遍。如果里面调 `meetOptions()`，
   * 末尾的 `meetUid()` 会在首次读写 `meet-uid.txt` —— 渲染路径做文件 IO。
   */
  const w = boot({ meetUrl: 'https://a.example' });
  assert.equal(w.meetUsable(), true);
  assert.equal(w.uiSnapshot().social.online, true);
});
