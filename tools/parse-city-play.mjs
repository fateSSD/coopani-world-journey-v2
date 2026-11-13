#!/usr/bin/env node
/*
 * 把问道采回来的「本地人晚上去哪」整理成 `data/city-play.json`（2026-11-09）。
 *
 * ## 为什么是文本文件 + 解析脚本
 *
 * 问道只有 MCP 工具，一次一轮对话，没法在脚本里直接批量调（凭据是加密存的）。
 * 所以走「人肉搬运」：把每批返回的原文追加进 `data/.play-inbox.txt`，
 * 再由这个脚本一次解析成 JSON。
 *
 * 这么做的好处是**原始文本留档** —— 哪天发现某城解析错了，能回头查原文，
 * 而不是只剩一份没人知道怎么来的 JSON。
 *
 * ## 清洗规则
 *
 * 问道返回的格式大体是 `城市｜地点｜一句话说明`，但有三种噪声：
 *
 * 1. **尖括号**：`兰州｜<兰山公园>｜…` —— 它是引用标记，不是地名的一部分
 * 2. **半角竖线当地名分隔**：`北京｜亮马河|蓝港码头｜…`
 * 3. **城市名带错字**：`弟弗罗茨瓦夫`（应为「弗罗茨瓦夫」）
 *
 * 用法：`node tools/parse-city-play.mjs`
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
/*
 * 原始文本放在 `tools/` 而不是 `data/` —— `package.json` 的 files 里有 `data`，
 * 放那儿会被打进 npm 包。这份原文是留档给人查的，不该占用户的包体积。
 */
const INBOX = join(ROOT, 'tools', '.play-inbox.txt');
const OUT = join(ROOT, 'data', 'city-play.json');

/*
 * 只去**引用标记**和首尾标点，别的原样保留。
 *
 * 第一版用「只留中文+字母数字」的白名单，把 `Äußere Neustadt` 削成了
 * `ußere Neustadt`（Ä 不在白名单里）—— 德累斯顿那条街名就这么残了。
 * 判据：**清洗只删确定是噪声的东西**，白名单留给不认识的字符是自伤。
 */
const clean = (s) =>
  String(s)
    .replace(/[<>《》]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[，,、：:\s]+/, '')
    .replace(/[，,、。：:\s]+$/, '')
    .trim();

const lines = readFileSync(INBOX, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/*
 * 这些行是模型自己加的说明（「以下为6个城市…」「货源来自网络」），不是数据。
 * 判据：没有竖线分隔，或者第一个字段不像城市名。
 */
const isNoise = (line) =>
  !/[｜|]/.test(line)
  || /^(以下|下面是|注意|说明|备注)/.test(line);

const rows = [];
let skipped = 0;
for (const raw of lines) {
  if (isNoise(raw)) { skipped++; continue; }
  /* 先按全角竖线切；不够三段再把半角竖线并进去 */
  let parts = raw.split('｜').map((x) => x.trim());
  if (parts.length < 3) parts = raw.split('|').map((x) => x.trim());
  if (parts.length < 3) { skipped++; continue; }
  if (parts.length > 3) {
    /*
     * 按全角切了超过三段，说明地名里还夹着半角竖线：
     * `北京｜亮马河|蓝港码头｜…`。用「·」接起来，比直接删掉好读。
     */
    parts = [parts[0], parts.slice(1, -1).join('·'), parts[parts.length - 1]];
  }
  /* 地名里残留的半角竖线一律换掉 ——「亮马河|蓝港码头」不该原样进文案 */
  if (parts.length === 3) parts[1] = parts[1].replace(/\s*\|\s*/g, '·');
  const city = clean(parts[0]);
  const name = clean(parts[1]);
  const desc = clean(parts[2]);
  if (!city || !name || !desc) { skipped++; continue; }
  rows.push({ city, name, desc });
}

const { CITIES } = await import('../src/geo/cities.ts');

/* 城市名 → id。精确优先，其次「包含」（处理「弟弗罗茨瓦夫」这种多字少字）。 */
const byName = new Map(CITIES.map((c) => [c.name, c.id]));
const resolve = (token) => {
  if (byName.has(token)) return byName.get(token);
  const hit = CITIES.find((c) => token.includes(c.name) || c.name.includes(token));
  return hit ? hit.id : null;
};

const out = {};
const unmatched = new Map();
for (const r of rows) {
  const id = resolve(r.city);
  if (!id) {
    unmatched.set(r.city, (unmatched.get(r.city) ?? 0) + 1);
    continue;
  }
  (out[id] ??= []).push({ n: r.name, d: r.desc });
}

/* 同一城同一地点只留一条（问道偶尔会重复）。 */
for (const id of Object.keys(out)) {
  const seen = new Set();
  out[id] = out[id].filter((x) => (seen.has(x.n) ? false : (seen.add(x.n), true)));
}

writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n', 'utf8');

const cities = Object.keys(out).length;
const spots = Object.values(out).reduce((n, a) => n + a.length, 0);
console.log(`解析 ${lines.length} 行 → 有效 ${rows.length} 行（跳过 ${skipped}）`);
console.log(`落盘：${cities} 城 / ${spots} 处  →  data/city-play.json`);
if (unmatched.size) {
  console.log(`对不上城市的 ${unmatched.size} 个：`);
  for (const [k, v] of [...unmatched].slice(0, 10)) console.log(`  ${k} × ${v}`);
}
const missing = CITIES.filter((c) => !out[c.id]);
console.log(`还没有数据的城市：${missing.length}（${missing.slice(0, 12).map((c) => c.name).join('、')}…）`);
