/**
 * 「碰面服务器」那一栏：填法与失败原因的归位（2026-11-13）。
 *
 * 起因：读者报「名片一直填不了」「约鱼发不出去，说没连上碰面服务器」，
 * 而线上服务实测全 200。追下去发现是漏一个 `https://` 就抛 `Invalid URL`，
 * 被 `catch` 压成同一句「没连上碰面服务器」——
 * 用户和模型都只能推「地址没填对」，真实那一层永远传不出来。
 *
 * 这里钉两件事：
 *   ① 能修的填法必须自己修好，修不了的说清哪里不对；
 *   ② 六种不同的网络失败，不能再说成同一句话。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { normalizeMeetUrl, explainNet, sendInvite } = await import('../src/meet.ts');

/* ---------------- 填法 ---------------- */

test('地址归一化：原样能用的不动', () => {
  const r = normalizeMeetUrl('https://cooppetsjourney.top');
  assert.equal(r.error, '');
  assert.equal(r.base, 'https://cooppetsjourney.top');
  assert.equal(r.fixed, '', '原样可用不该报「动过什么」');
});

test('地址归一化：漏了协议要自己补，不能让它抛', () => {
  for (const raw of ['cooppetsjourney.top', 'cooppetsjourney.top/sight', 'cooppetsjourney.top/sight/']) {
    const r = normalizeMeetUrl(raw);
    assert.equal(r.error, '', `${raw} 应该能修好`);
    assert.equal(r.base, 'https://cooppetsjourney.top', `${raw} 没补对：${r.base}`);
    assert.match(r.fixed, /https:\/\//, `${raw} 没告诉用户补了协议`);
  }
});

test('地址归一化：零宽字符与首尾引号是复制带来的，要清掉', () => {
  /* 从网页/聊天框/邮件里复制，这几个字符肉眼一个都看不见，而它们会让 URL 解析失败 */
  const r = normalizeMeetUrl('\u200b“ https://cooppetsjourney.top \ufeff”');
  assert.equal(r.error, '');
  assert.equal(r.base, 'https://cooppetsjourney.top');
});

test('地址归一化：误填到具体接口要剪回去', () => {
  const r = normalizeMeetUrl('https://cooppetsjourney.top/sight/status');
  assert.equal(r.base, 'https://cooppetsjourney.top', `没剪干净：${r.base}`);
  assert.match(r.fixed, /sight/, '剪了要说');
});

test('地址归一化：浏览器地址栏带来的 ? 和 # 不算地址的一部分', () => {
  const r = normalizeMeetUrl('https://cooppetsjourney.top/?from=bookmark#top');
  assert.equal(r.base, 'https://cooppetsjourney.top');
});

test('地址归一化：http 原样保留，不强行升 https（自建服务常用）', () => {
  const r = normalizeMeetUrl('http://192.168.1.5:8787');
  assert.equal(r.base, 'http://192.168.1.5:8787');
  assert.equal(r.error, '');
});

test('地址归一化：空 = 没填，不是错', () => {
  for (const raw of ['', '   ', null, undefined]) {
    const r = normalizeMeetUrl(raw);
    assert.equal(r.base, '');
    assert.equal(r.error, '', '没填不该报错，那是另一个状态');
  }
});

test('地址归一化：修不了的必须说清，不许静默改写', () => {
  assert.match(normalizeMeetUrl('ftp://cooppetsjourney.top').error, /http/, '非 http(s) 要说只认这两个');
});

/* ---------------- 失败原因 ---------------- */

test('网络失败：六种情况不能再说成同一句话', () => {
  const cases = [
    [{ name: 'TimeoutError' }, /5 秒没回话/],
    [{ cause: { code: 'ENOTFOUND' } }, /域名解析不了/],
    [{ cause: { code: 'EAI_AGAIN' } }, /DNS 这会儿查不了/],
    [{ cause: { code: 'ECONNREFUSED' } }, /端口/],
    [{ code: 'CERT_HAS_EXPIRED' }, /证书/],
    [{ message: 'Failed to parse URL from cooppetsjourney.top/sight' }, /https:\/\//],
  ];
  const seen = new Set();
  for (const [err, want] of cases) {
    const got = explainNet(err);
    assert.match(got, want, `${JSON.stringify(err)} 说成了「${got}」`);
    seen.add(got);
  }
  assert.equal(seen.size, cases.length, '有两种失败说成了同一句话 —— 那就等于没说');
});

test('网络失败：不认识的异常也要留原始码，便于回信定位', () => {
  const got = explainNet({ code: 'EAI_FAIL', message: 'boom' });
  assert.match(got, /EAI_FAIL/, '原始 code 丢了');
});

/* ---------------- 端到端：reason 里要能看出真实原因 ---------------- */

test('发邀约：网络层抛错时，reason 里要带得出是哪一层', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to parse URL from cooppetsjourney.top/sight/invite'); };
  try {
    const r = await sendInvite(
      { url: 'https://cooppetsjourney.top', uid: 'a'.repeat(24), pet: '大肥鱼' },
      { from: 'lanzhou', to: 'xian', days: 2, note: '一起走' },
    );
    assert.equal(r.ok, false);
    assert.match(r.reason, /没连上碰面服务器/, '原来那一句还得留着，用户认得出');
    assert.match(r.reason, /https:\/\//, `真实原因没带出来，用户还是只能猜：${r.reason}`);
  } finally {
    globalThis.fetch = real;
  }
});
