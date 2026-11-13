/**
 * 「她是哪一版、最新是哪一版」（2026-11-08 Mr.Q）。
 *
 * 用户报障时第一句话永远是「我这是不是最新版」—— 面板上原来一个版本号都没有。
 * 这里守四条：
 *
 * 1. 比大小要看得懂 `1.0.10 > 1.0.9`（字符串比会翻车）；
 * 2. 查不到就**不许**说「已是最新」；
 * 3. 断网/超时不许抛，也不许把已有的结果冲掉；
 * 4. 别天天打 npm —— 六小时内只问一次。
 */
const { mkdtempSync, rmSync, readFileSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { compareVersion, VersionCheck } = await import('../src/version-check.ts');
const assert = (await import('node:assert/strict')).default;
const { test } = await import('node:test');

const dir = () => mkdtempSync(join(tmpdir(), 'vc-'));

test('比大小：1.0.10 比 1.0.9 新，预发布后缀不影响', () => {
  assert.equal(compareVersion('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersion('1.0.9', '1.0.10'), -1);
  assert.equal(compareVersion('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersion('v1.2.0', '1.1.9'), 1);
  assert.equal(compareVersion('1.0.0-beta.2', '1.0.0'), 0);
  assert.equal(compareVersion('0.9.13', '1.0.0'), -1);
});

test('问到更新的版本就说过时；问到同版就不过时', async () => {
  const d = dir();
  const fake = async () => new Response(JSON.stringify({ latest: '9.9.9' }), { status: 200 });
  const v = new VersionCheck({ dataDir: d, current: '1.0.0', fetchImpl: fake });
  assert.equal(v.state().outdated, false, '还没查之前不许说它过时');
  const after = await v.refresh();
  assert.equal(after.latest, '9.9.9');
  assert.equal(after.outdated, true);
  rmSync(d, { recursive: true, force: true });
});

test('查不到（断网/超时/5xx）就闭嘴：不抛错、不说「最新」、也不说「过时」', async () => {
  const d = dir();
  const boom = async () => { throw new Error('offline'); };
  const v = new VersionCheck({ dataDir: d, current: '1.0.0', fetchImpl: boom });
  const s = await v.refresh();
  assert.equal(s.latest, '', '查不到时 latest 必须是空串');
  assert.equal(s.outdated, false, '查不到时不许断言过时');

  const bad = async () => new Response('nope', { status: 500 });
  const v2 = new VersionCheck({ dataDir: dir(), current: '1.0.0', fetchImpl: bad });
  const s2 = await v2.refresh();
  assert.equal(s2.outdated, false);
  rmSync(d, { recursive: true, force: true });
});

test('六小时内只问一次 —— 开十次面板不该打十次 npm', async () => {
  const d = dir();
  let calls = 0;
  const fake = async () => { calls += 1; return new Response(JSON.stringify({ latest: '1.0.1' }), { status: 200 }); };
  const v = new VersionCheck({ dataDir: d, current: '1.0.0', fetchImpl: fake });
  await v.refresh();
  await v.refresh();
  await v.refresh();
  assert.equal(calls, 1, `问了 ${calls} 次`);
  const forced = await v.refresh(true);
  assert.equal(calls, 2, 'force 应该真的再问一次');
  assert.equal(forced.latest, '1.0.1');
  rmSync(d, { recursive: true, force: true });
});

test('结果落盘：重启之后不重查，但状态还在', async () => {
  const d = dir();
  const fake = async () => new Response(JSON.stringify({ latest: '1.0.5' }), { status: 200 });
  const a = new VersionCheck({ dataDir: d, current: '1.0.0', fetchImpl: fake });
  await a.refresh();

  let calls = 0;
  const spy = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const b = new VersionCheck({ dataDir: d, current: '1.0.0', fetchImpl: spy });
  assert.equal(b.state().latest, '1.0.5', '缓存没读到');
  assert.equal(b.state().outdated, true);
  await b.refresh();
  assert.equal(calls, 0, '缓存还新，不该再问一次');
  rmSync(d, { recursive: true, force: true });
});

test('版本号是 unknown 时根本不去问', async () => {
  let calls = 0;
  const spy = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const v = new VersionCheck({ dataDir: dir(), current: 'unknown', fetchImpl: spy });
  await v.refresh();
  assert.equal(calls, 0);
});

/* ---------------- 2026-11-08：启动那次必须真的去查 ---------------- */

test('启动检查：缓存刚查过才跳过，隔一会儿就必须重查', async () => {
  /*
   * 这是真的踩到的 bug：Mr.Q 的机器上是 1.0.2，市场已经 1.0.3，面板一声不响。
   *
   * 根因是启动时调的是 `refresh()`，它按 TTL 跳过 —— 而他下午刚查过（那时
   * latest 就是 1.0.2），六小时 TTL 让他一直看到旧结论。
   *
   * **「已是最新」这个判断是会过期的**，跟「有新版」不一样。
   */
  const dir = mkdtempSync(join(tmpdir(), 'ver-'));
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ latest: '9.9.9' }) };
  };

  /* 第一次：缓存是空的，必须查。 */
  const a = new VersionCheck({ dataDir: dir, current: '1.0.0', fetchImpl });
  await a.startupRefresh();
  assert.equal(calls, 1, '缓存空的时候居然没去查');
  assert.equal(a.state().latest, '9.9.9');

  /* 第二次：刚查过（同一个进程内），不该再打一次。 */
  await a.startupRefresh();
  assert.equal(calls, 1, '十五分钟内又查了一遍');

  /* 第三次：换一个实例，模拟「过了一阵子重启」—— 缓存里的时间很旧，必须重查。 */
  const raw = JSON.parse(readFileSync(join(dir, 'version-check.json'), 'utf8'));
  raw.checkedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  writeFileSync(join(dir, 'version-check.json'), JSON.stringify(raw), 'utf8');

  const b = new VersionCheck({ dataDir: dir, current: '1.0.0', fetchImpl });
  await b.startupRefresh();
  assert.equal(calls, 2, '隔了两小时重启，启动检查被缓存挡住了');
});

test('启动检查：缓存里的版本已经过时，也必须重查（这正是不提醒的场景）', async () => {
  /*
   * 用户的真实处境：下午查到 latest=1.0.2（他装的也是 1.0.2，所以「已是最新」），
   * 晚上我发了 1.0.3。如果启动时按 TTL 跳过，他永远看不到提示。
   */
  const dir = mkdtempSync(join(tmpdir(), 'ver2-'));
  /* 造一份「半小时前查过、结论是 1.0.2」的缓存。 */
  writeFileSync(join(dir, 'version-check.json'), JSON.stringify({
    latest: '1.0.2',
    checkedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
  }), 'utf8');

  let calls = 0;
  const v = new VersionCheck({
    dataDir: dir,
    current: '1.0.2',
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ latest: '1.0.3' }) };
    },
  });
  assert.equal(v.state().outdated, false, '还没查就已经说「过时」了');
  await v.startupRefresh();
  assert.equal(calls, 1, '半小时前的缓存挡住了启动检查');
  assert.equal(v.state().outdated, true, '查到 1.0.3 却没标成过时');
});

test('面板：版本徽章挂在标题上，不在页脚', () => {
  /*
   * Mr.Q：「放到标题上去，这里太不明显了」。
   * 页脚那行 11px 灰字，混在「日记 3 天 · 花销 1200」中间，等于没显示。
   */
  const js = readFileSync(new URL('../dist/webui.js', import.meta.url), 'utf8');
  /* 徽章要 append 到 eyebrow（标题那一行）。 */
  assert.match(js, /eyebrow\.append\(ver\)/, '版本徽章没挂在标题行');
  /* 页脚不许再画一次 —— 两处都显示，用户会以为版本对不上。 */
  assert.doesNotMatch(js, /foot\.append\(el\(\s*'p',\s*s\.versionOutdated/, '页脚还在画版本行');
  assert.match(js, /ver\.dataset\.new/, '没有给徽章打「有新版」的标记，样式挂不上');
});
