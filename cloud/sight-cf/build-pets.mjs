#!/usr/bin/env node
/**
 * 把 `site/pets.html` 转成一个字符串模块 `src/pets-page.js`。
 *
 * ## 为什么不直接用 wrangler 的 Text rule
 *
 * 那样写 `import page from '../../../site/pets.html'` 打包没问题，但 **node 跑测试时 import 不到 .html**，
 * `sight-cf.test.mjs` 一加载 worker 就整片挂掉 —— 57 条测试连带失效，代价太大。
 *
 * 转成一个普通 `.js` 之后两边都能读。代价是「改完 html 要记得重新生成」，
 * 所以 `test/pets-page.test.mjs` 会盯着两份是否一致 —— 忘了就跑红，不会静默漂移。
 *
 * 用法（改完 site/pets.html 之后）：
 *   node cloud/sight-cf/build-pets.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '../../site/pets.html');
const out = join(here, 'src/pets-page.js');

const html = readFileSync(src, 'utf8');

/*
 * `JSON.stringify` 是这里唯一正确的转义方式：页面里有反引号、`${}`、正则反斜杠，
 * 手工拼模板字符串一定会踩到其中一个。JSON 字符串字面量在 JS 里是合法的。
 */
const literal = JSON.stringify(html);

const file = `/**
 * **不要手改这个文件。** 它由 \`cloud/sight-cf/build-pets.mjs\` 从 \`site/pets.html\` 生成。
 * 改页面去改那个 html，然后跑一次：
 *
 *   node cloud/sight-cf/build-pets.mjs
 *
 * \`test/pets-page.test.mjs\` 会校验这份和源文件一致 —— 忘了重新生成会当场红。
 */
export default ${literal};
`;

writeFileSync(out, file, 'utf8');
console.log(`pets-page.js 已生成：${html.length} 字符`);
