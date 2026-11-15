/**
 * 「她说累了，就真的歇下来」—— 2026-11-07
 *
 * 用户 ro-berry 的反馈（v0.7.1）：
 * 「发现不能让她安排自己的作息。她说累了要歇着，接下来还是按照作息出门了。」
 *
 * 这不是排程算错 —— 是**她说的话在世界里没有对应的动作**。
 * 「累了」只存在于对话里，排好的表一个字没动。跟「等端上来我就拍给你看」同类。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');

function world(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-rest-'));
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-07T06:30:00Z'), // 成都 14:30
  });
  w.st = { ...w.st, phase: 'staying', hereId: 'chengdu', ...over };
  /* 只要能取 `beats` 就够，不必造一个完整 DayPlan。 */
  w.plan = { beats: [{ kind: 'activity', at: 15, what: '去宽窄巷子' }] };
  return w;
}

test('她说歇着，状态里真的落下这件事', async () => {
  const w = world();
  const r = await w.restNow('走了两万步，脚起泡了');
  assert.equal(r.isError, undefined, `不该被拒：${r.text}`);
  assert.equal(w.st.rest?.dateKey, '2026-11-07', '没有落到今天');
  assert.equal(w.st.rest?.from, 14.5, `歇着的起点不对：${w.st.rest?.from}`);
  assert.match(w.st.rest?.reason ?? '', /脚起泡/, '理由没记下来');
  assert.match(r.text, /1 个点/, `回执没给出具体砍掉几个点：${r.text}`);
});

test('同一天再调一次，不重复记也不报错', async () => {
  const w = world();
  await w.restNow('累了');
  const r2 = await w.restNow('还是累');
  assert.match(r2.text, /已经歇着/, r2.text);
  assert.equal(w.st.rest?.reason, '累了', '第二次把第一次的理由覆盖了');
});

test('在路上歇不了 —— 这个动作只在停留时有用', async () => {
  const w = world({ phase: 'traveling' });
  const r = await w.restNow('累了');
  assert.equal(r.isError, true);
  assert.match(r.text, /路上|不在城里/, r.text);
});

test('今天本来就没什么点了，要照实说', async () => {
  const w = world();
  w.plan = { beats: [] };
  const r = await w.restNow('累了');
  assert.match(r.text, /没什么点|早点歇/, `没点了还编一个数字：${r.text}`);
});

test('作息推送必须跳过被歇掉的 activity，但晚饭照常推', async () => {
  /*
   * 只落一个状态是不够的 —— `advanceBeats` 不认这个标记，她照样会在
   * 「十五点 去宽窄巷子」那条事件里被叫出门。ro-berry 看到的就是这个。
   */
  const { cityById } = await import('../src/geo/cities.ts');
  const w = world();
  const pushed = [];
  w.host = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pushEvent: async (ev) => { pushed.push(ev); },
  };
  w.plan = {
    sunriseHour: 7,
    lodging: { price: 180, feel: '' },
    beats: [
      { kind: 'activity', at: 15, what: '去宽窄巷子' },
      { kind: 'dinner', at: 18.5, what: '晚饭，红油抄手' },
    ],
  };
  await w.restNow('走了两万步，脚起泡了');

  // 15:30 巡检：15 点的宽窄巷子已被歇掉，不该推出去
  await w.advanceBeats(new Date('2026-11-07T07:30:00Z'), cityById('chengdu'), 15.5, '2026-11-07');
  assert.equal(pushed.length, 0, `歇着之后还是推了出门节点：${JSON.stringify(pushed)}`);

  // 19:00 巡检：18:30 的晚饭不是景点，照常推
  await w.advanceBeats(new Date('2026-11-07T11:00:00Z'), cityById('chengdu'), 19.0, '2026-11-07');
  assert.equal(pushed.length, 1, '晚饭应该照常推');
  assert.match(pushed[0].text, /红油抄手/, `推的不是晚饭：${pushed[0].text}`);
});
