/**
 * 「她此刻」面板里的碰面入口 —— 2026-11-06，0.7.19
 *
 * Mr.Q 的原话：「好多人都不知道有这个功能（不看更新日志和介绍）」。
 *
 * 之前面板上只有一排数字（池子多少只、同城几只），而**没配服务器的人根本看不到那一排**
 * —— 于是整个功能对他们等于不存在。加了一块说明 + 一个能直接复制的地址，
 * 而且**只在没配服务器时出现**：配过之后她要的是「现在有几只」，不是再读一遍说明书。
 *
 * 这里没有 DOM 库，跑不了真渲染，所以盯三件事：
 *   1. 那块还在（`jr-meet`）、地址还是那个域
 *   2. 条件是 `!s.social`（配了就不显示）
 *   3. 文案表两种语言都有 key（漏一个英文用户会看到 undefined）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../dist/webui.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../dist/webui.css', import.meta.url), 'utf8');

test('面板里有碰面那块，地址指向作者的服务器', () => {
  assert.match(js, /jr-meet'/, '碰面区块的 class 没了');
  assert.match(js, /cooppetsjourney\.top/, '地址没了 —— 用户看到说明却不知道填什么');
  assert.match(js, /meetBox/, '区块变量没了');
});

test('只在没配服务器时出现', () => {
  // 配过之后还显示，就成了每次打开都要读一遍的说明书。
  const block = js.slice(js.indexOf('meetBox.replaceChildren()'), js.indexOf('meetBox.replaceChildren()') + 120);
  assert.match(block, /if \(!s\.social\)/, `条件不对：${block.slice(0, 80)}`);
});

test('中英文案都齐（漏一个就是 undefined 上屏）', () => {
  for (const key of ['meetTitle', 'meetLead', 'meetHint', 'meetCopy']) {
    const hits = js.split(new RegExp(`${key}:`, 'g')).length - 1;
    assert.equal(hits, 2, `${key} 只出现了 ${hits} 次（应该中英各一）`);
  }
});

test('样式跟着走 —— 没有 .jr-meet 就是一块没框的裸字', () => {
  assert.match(css, /\.jr-meet \{/);
  assert.match(css, /\.jr-meet-url \{/);
});

test('没内容时整块不占位 —— 不然面板底下留一个空白框', () => {
  /*
   * 2026-11-06 的实际 bug：配过碰面服务器的人，`social` 不是 null，
   * 这块就不填内容，但 `section` 本身还在 —— 面板底下多了一个空的白框。
   * Mr.Q 一眼看到：「我这里什么都不显示正常嘛」。
   */
  assert.ok(css.includes('.jr-meet:empty'), '空块没被隐藏');
  assert.ok(css.includes('display: none'), '隐藏规则没写 display');
});
