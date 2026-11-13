/**
 * 一次性：把 site/pets.html 里写死的城市表换成 CITIES 的全量。
 *
 * 起因（2026-11-09 Mr.Q）：「我的管理界面有几个外国城市名是英文」——
 * 那张表注释写着「127 座，改城市时记得重导」，而 CITIES 已经 185 座，没人记得。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CITIES } from '../src/geo/cities.ts';

const file = 'site/pets.html';
const html = readFileSync(file, 'utf8');

const map = Object.fromEntries(CITIES.map((c) => [c.id, c.name]));
const json = JSON.stringify(map);

const before = /var CITY = \{.*?\};/.exec(html);
if (!before) throw new Error('找不到 var CITY = {...};');
const oldCount = Object.keys(JSON.parse(before[0].slice('var CITY = '.length, -1))).length;

const html2 = html.replace(before[0], `var CITY = ${json};`);
writeFileSync(file, html2, 'utf8');

console.log(`城市表：${oldCount} → ${Object.keys(map).length}`);
const missing = CITIES.filter((c) => !c.name || c.name === c.id);
console.log('没有中文名的:', missing.length ? missing.map((c) => c.id).join(',') : '无');
