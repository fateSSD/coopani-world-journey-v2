/**
 * 画面描述的语言要跟着配置走（2026-11-18，zzy1053 报的）。
 *
 * ## 现场
 *
 * 工具说明里写死「**Write it in English**」，理由是本地的 SDXL CLIP 读不了中文。
 * 那个理由只对 CLIP 系成立：用 Qwen-Image / Kolors 这类中文原生模型的人被逼着写英文，
 * 细节反而丢；而且 `describe` 有 60 字符上限，英文很容易断在单词中间
 * （他实测三张，三张都正好 60 字符砍断）。
 *
 * ## 这条守的是「整条链不断」
 *
 * 语言这件事跨了四处，缺任何一处都等于没做：
 *
 * ```
 * 配置页 imagePromptLang  →  envPromptVars 的 journey.imageLang  →  ENV_PROMPT 引用它  →  工具说明指过去
 * ```
 *
 * 所以这里逐个守，不测行为（构造 World 太重），只测**这四处还在**、且没有被改回写死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('默认值必须是英文 —— 老用户一个字节都不该变', async () => {
  const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
  assert.equal(JOURNEY_DEFAULTS().imagePromptLang, 'en');
});

test('配置页有这一项，且只在英文/中文之间选', async () => {
  const { journeyConfigGroups } = await import('../src/config.ts');
  const groups = journeyConfigGroups();
  const group = groups.find((g) => g.schema.properties?.['worlds.journey.imagePromptLang']);
  assert.ok(group, '配置里没有 imagePromptLang');
  const field = group.schema.properties['worlds.journey.imagePromptLang'];
  assert.deepEqual([...field.enum], ['en', 'zh']);
  /* 设置页不解析 markdown，描述里出现星号会原样露出来。 */
  assert.doesNotMatch(field.description, /\*\*/, '配置描述里有 markdown 加粗');
});

test('envPromptVars 按配置吐两种不同的说法', () => {
  const src = read('src/world-purse.ts');
  assert.match(src, /'journey\.imageLang'\s*:/, '没有 journey.imageLang 这个变量');
  assert.match(src, /imagePromptLang\s*===\s*'zh'/, '没按配置分支');
  assert.match(src, /CLIP|乱码/, '英文那支没说清为什么');
});

test('ENV_PROMPT 引用了它，否则变量白算', () => {
  const md = read('ENV_PROMPT.md');
  assert.match(md, /\{\{journey\.imageLang\}\}/, 'ENV_PROMPT 里没引用 journey.imageLang');
  /* 旧的「一律英文」这种硬话不许再出现。 */
  assert.doesNotMatch(md, /用英文写/, 'ENV_PROMPT 里还写着「用英文写」');
});

test('工具说明不再写死英文，而是要她去看语言那一行', () => {
  const src = read('src/describe.ts');
  /* 只匹配带 ** 的那句字面量 —— 注释里提到过原文，不该算。 */
  assert.doesNotMatch(src, /\*\*Write it in English/, 'describe 说明还在写死英文');
  assert.match(src, /journey\.imageLang/, 'describe 说明没指到 journey.imageLang');

  /* describe.json 是同一份说明的手工副本，两边必须一致。 */
  const decl = read('describe.json');
  assert.doesNotMatch(decl, /Write it in English/, 'describe.json 里的副本没同步');
  assert.match(decl, /journey\.imageLang/);
});
