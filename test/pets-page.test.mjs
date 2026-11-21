/**
 * 管鱼页的生成物必须和源文件一致 —— 2026-11-06
 *
 * `site/pets.html` 是唯一源文件，`cloud/sight-cf/src/pets-page.js` 是它转成的字符串模块
 * （Worker 用它来发 `/pets`）。中间多了一个生成步骤，就会有人忘记跑 ——
 * 忘了的表现是「改了页面、部署了、打开还是老的」，而且不报错。
 *
 * 所以这里盯两件事：
 *   1. 两份内容一致（忘了重新生成会当场红）
 *   2. Worker 真的能把 `/pets` 发出来，且是 HTML
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const html = readFileSync(join(root, 'site/pets.html'), 'utf8');
const { default: generated } = await import('../cloud/sight-cf/src/pets-page.js');
const { CITIES } = await import('../src/geo/cities.ts');

test('pets-page.js 和 site/pets.html 内容一致', () => {
  assert.equal(
    generated, html,
    '生成物和源文件不一致 —— 改完 site/pets.html 要跑 node cloud/sight-cf/build-pets.mjs',
  );
});

test('Worker 能发出管鱼页：是 HTML，且涵盖 /pets /pets/all /pets/life /pets/town 与双世界分离', async () => {
  const { default: worker } = await import('../cloud/sight-cf/src/worker.js');
  for (const route of ['/pets', '/pets/all', '/pets/life', '/pets/town']) {
    const r = await worker.fetch(new Request(`https://sight.test${route}`, {
      headers: { 'cf-connecting-ip': '1.1.1.1' },
    }), { DB: null });
    assert.equal(r.status, 200, `${route} 没发出来`);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
  }
  const r = await worker.fetch(new Request('https://sight.test/pets', {
    headers: { 'cf-connecting-ip': '1.1.1.1' },
  }), { DB: null });
  const body = await r.text();
  assert.ok(body.includes('ADMIN_KEY'), '发出来的不是管鱼页');
  assert.ok(body.includes('id="worldJourney"') && body.includes('id="worldLife"'), '缺少 Journey 与 Life 一级分区');
  assert.ok(body.includes("base + '/life'"), '缺少 /admin/life 请求以显示 Life 多少鱼');
  assert.ok(body.length > 8000, `页面太短，像是被截断了：${body.length}`);
});

test('城市表覆盖 CITIES 全部 —— 少一座就显示成英文 id', () => {
  /*
   * 2026-11-09 Mr.Q：「我的管理界面有几个外国城市名是英文」。
   *
   * 页面里那张表是手抄的，注释写着「127 座，改城市时记得重导」——
   * CITIES 早就 185 座了，没人记得。少的那几座就漏成 `warsaw`、`krakow`。
   *
   * 修法不是再手抄一遍（下次还会漏），是把「表对不对」变成一条会跑红的断言。
   * 表本身用 `npx tsx tools/regen-city-table.mjs` 从 CITIES 重新生成。
   */
  const m = /var CITY = (\{.*?\});/.exec(html);
  assert.ok(m, '页面里找不到 var CITY = {...}');
  const table = JSON.parse(m[1]);
  const missing = CITIES.filter((c) => !table[c.id] || table[c.id] !== c.name);
  assert.equal(
    missing.length,
    0,
    `${missing.length} 座城表里没有中文名（会显示成英文 id）：`
      + missing.slice(0, 8).map((c) => `${c.id}→${c.name}`).join(', ')
      + '\n跑 npx tsx tools/regen-city-table.mjs 重新生成',
  );
  /* 反向也要查：表里多出来的项会让人以为还有那些城。 */
  const extra = Object.keys(table).filter((id) => !CITIES.some((c) => c.id === id));
  assert.equal(extra.length, 0, `表里多了 CITIES 里没有的城市：${extra.slice(0, 8).join(',')}`);
});
