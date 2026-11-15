/**
 * 「AI 味重」是一个能被钉住的问题（2026-11-08，1.0.3）。
 *
 * ## 反馈原话
 *
 * 一位用户在 QQ 上说的：
 *
 * > 「环游世界的时候 ai 味还挺重的」
 * > 「提示词可能少了一句」
 * > 「请根据你的人设和上下文」
 * > 「因为我看到推的提示词也是很朴素的那种」
 * > 「有些懒癌模型会复述一遍」
 *
 * 他诊断得很准，而且指出的是**机制**不是文笔：手上那一段是十几行的结构化事实，
 * 清单会教模型照着清单说话 —— 给它十七行，它就说十七行，只不过换成通顺的散文。
 *
 * ## 这条测试守什么
 *
 * 三个位置各一句，缺一处存量用户就不受影响：
 *
 * 1. `ENV_PROMPT.md`（给新用户抄的模板）
 * 2. 工具描述（**存量用户也会读**，因为它是每次调用都带上的）
 * 3. `nowSummary` 末尾（数据本身，绕不过去）
 *
 * 第 2 和第 3 是关键：用户早就把人设写进角色卡了，**模板改了不会回溯生效**。
 */
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { readFileSync } = await import('node:fs');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const { JourneyWorld, JOURNEY_DESCRIBE } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');
const { StateStore, initialState } = await import('../src/state.ts');

const tpl = readFileSync(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8');

/** 造一个世界，`nowIso` 是世界时刻。 */
function boot(nowIso, seed = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flavor-'));
  new StateStore(dir).save(initialState('lanzhou'));
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', memoryDir: join(dir, 'diary') },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date(nowIso),
  });
  w.st = {
    ...w.st,
    tripStartedAt: '2026-10-31T10:25:01.249Z',
    ...seed,
  };
  return w;
}

/* ------------------------------------------------------------ 模板 */

test('模板里要有「这些是素材」那一句，而且要在清单之后', () => {
  /*
   * 位置有讲究：`{{journey.now}}` 是清单，说明必须在它**后面**——
   * 放前面的话，模型读完说明还要读十七行清单，最后读到的仍然是清单。
   */
  const i = tpl.indexOf('{{journey.now}}');
  const j = tpl.indexOf('不是你要说的话');
  assert.ok(j > 0, '模板里没有「这些是素材，不是你要说的话」');
  assert.ok(j > i, '说明放在了清单前面 —— 要紧的是最后读到的那个印象');
});

test('模板要有正面写法，不只是禁令', () => {
  /*
   * 全是「别写什么」，模型最容易的绕法就是**最小改动**：把事实改成通顺的句子。
   * 所以要给一句该怎么办 ——「先想清楚你是谁、跟他什么关系、他这会儿最想知道什么」。
   */
  assert.match(tpl, /你是谁/, '没让她先想自己是谁');
  assert.match(tpl, /跟他什么关系/, '没提关系');
  assert.match(tpl, /只问一件就答那一件/, '没说「只问一件就答一件」');
  assert.match(tpl, /别换套词把这份清单复述一遍/, '没点名禁止复述');
});

test('模板要有「先有人再有事实」这一条', () => {
  /* 「腿还在抖」比「门票 80 元」多的是那个人 —— 这是 AI 味和文学的分界。 */
  assert.match(tpl, /先有人再有事实/);
});

/* ------------------------------------------------------------ 工具描述 */

test('日记工具不再把「城市/路/吃了什么/房间」当写作清单', async () => {
  /*
   * 原来那句是 `Write what actually happened that day - the city, the road,
   * what she ate, how the room was`，本意是「别写成功能总结」，
   * 实际效果是**给了一张四项清单**，模型照着挨个写一遍，一天的日记就成了流水。
   */
  const tool = JOURNEY_DESCRIBE.tools.find((t) => t.name === 'journey_diary_write');
  assert.ok(tool, '找不到 journey_diary_write');
  const block = tool.description;
  assert.doesNotMatch(block, /the city, the road, what she ate, how the room was/, '还是那张四项清单');
  assert.match(block, /not a checklist/, '没写明「这不是清单」');
  assert.match(block, /not as a report of the day/, '没说明不是流水账');
});

test('journey_now 说明这是背景，不是要转述的文本', async () => {
  const tool = JOURNEY_DESCRIBE.tools.find((t) => t.name === 'journey_now');
  assert.ok(tool, '找不到 journey_now');
  const block = tool.description;
  assert.match(block, /not text to hand back/, '没说「不要照念」');
  assert.match(block, /reading the fields out/, '没点出「逐条念」这个具体行为');
});

/* ------------------------------------------------------------ 数据本身 */

test('在目的地：事实清单末尾那句必须在，而且不侵占内容', () => {
  const w = boot('2026-11-08T11:30:00.000Z', {
    phase: 'staying',
    hereId: 'chengdu',
    stayDateKey: '2026-11-08',
    stayStartedAt: '2026-11-06T04:18:14.669Z',
  });
  const s = w.nowSummary();
  assert.match(s, /这些是事实[^\n]*不用一条条报/, `末尾那句没了：${s.slice(-90)}`);
  /* 那句得在**最后一行**：模型读完就动笔，最后一句对基调影响最大。 */
  const lines = s.trim().split('\n');
  assert.match(lines[lines.length - 1], /不用一条条报/, '那句没在末尾');
  /* 但内容一条都不许少 —— 每一条都是修过具体缺口的。 */
  assert.match(s, /在 成都|在成都/);
  assert.match(s, /日记：/);
});

test('在家：同样有那句，不能说只有出门才需要', () => {
  const w = boot('2026-11-08T11:30:00.000Z', { phase: 'home', hereId: 'lanzhou' });
  const s = w.nowSummary();
  assert.match(s, /这些是事实[^\n]*不用一条条报/, `在家那支漏了：${s.slice(-90)}`);
});
