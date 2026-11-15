/**
 * 她每回合看到的那段状态摘要（`nowSummary`）—— 2026-11-06
 *
 * 两件事都出在这一段上，也都不是「功能没做」，是**做了但她看不见**：
 *
 * ① 住宿只报类别不报店名。面板写「时尚睡吧快捷宾馆(避暑山庄店)（连锁商务酒店）· 240」，
 *    她手上只有「连锁商务酒店」——被问「你住哪家」只能报类别或者编一个。
 *    Mr.Q 截图里那两个对不上的数（240 / 560）就是两边措辞不同造成的。
 *
 * ② 车在 `st.car` 里，`planDay` 也确实在城里开车去景点，但这一段从来不提。
 *    群里被问「你在城里怎么走」，她答「只能靠腿」，用户以为功能坏了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');

function staying(carOver = null) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-now-'));
  const w = new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-06T13:00:00Z'),
  });
  w.st = { ...w.st, phase: 'staying', hereId: 'chengdu', car: carOver };
  return w;
}

test('有车就要说，别让她自己猜「靠腿」', () => {
  const w = staying({ fuel: 'oil', days: 3, km: 120 });
  const s = w.nowSummary();
  assert.match(s, /开着车/, `有车却没提：${s.slice(0, 200)}`);
  assert.match(s, /油车/, '没说是什么车');
});

test('电车说法不一样', () => {
  const w = staying({ fuel: 'ev', days: 3, km: 80 });
  assert.match(w.nowSummary(), /电车/, '电车说成油车就是另一回事了');
});

test('没车就不提车，别硬凑一句', () => {
  const w = staying(null);
  assert.doesNotMatch(w.nowSummary(), /开着车|靠腿/, '没车还说车，等于替她编');
});

test('住宿那一行与面板用同一个口径（含真店名与类别）', () => {
  /*
   * 这不是洁癖。`nowSummary` 用模板字符串手拼 `kind`，面板用 `lodgingLabel(l)` ——
   * 后者是「真名（类别）」，前者只有类别。两套措辞各长各的，用户一对比就发现
   * 「她说的和面板不一样」，而这类不一致每次都长得像数据出错。
   */
  const w = staying(null);
  w.plan = {
    dateKey: '2026-11-06',
    sunriseHour: 7,
    sunsetHour: 18,
    weather: null,
    lodging: { kind: '连锁商务酒店', name: '月牙酒店(成都春熙路店)', price: 240, feel: '干净，靠街有一点车声' },
    nightOption: null,
    beats: [],
    neighbors: [],
    invites: [],
    takenCount: 0,
  };
  const summary = w.nowSummary();
  const snap = w.uiSnapshot();
  assert.match(summary, /月牙酒店\(成都春熙路店\)（连锁商务酒店）/, `nowSummary 没带真店名和类别：${summary}`);
  assert.equal(snap.lodging?.name, '月牙酒店(成都春熙路店)');
  assert.equal(snap.lodging?.kind, '连锁商务酒店');
});
