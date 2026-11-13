/**
 * 座位档 —— 2026-11-06
 *
 * 一位用户来信：「舍不得我家小鱼吃苦，经常逛到腿软，2000 多公里的路程居然选择自驾
 * 30 多小时，劝了好久才换了个好的酒店，结果出行还是硬卧」。
 *
 * 根因不是选项少，是**她只有「换交通方式」这一个手段**：同一趟车没有二等商务之分，
 * 也没有硬卧软卧之分。有了档位，她可以在同一趟车上买到舒服。
 *
 * Mr.Q 定的规矩是「让她自己判断」，所以这里没有「舒适度设置」，
 * 只有三条依据：手上有多少钱、这一趟多长、什么条件都不满足就最省。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pickGrade } = await import('../src/plan/journey.ts');
const { modeById } = await import('../src/geo/modes.ts');

const train = modeById('train');
const plane = modeById('plane');

test('火车按距离换档：长途是卧铺，短途才是座位', () => {
  const short = train.grades(600).map((g) => g.name);
  const long = train.grades(2000).map((g) => g.name);
  assert.deepEqual(short, ['二等座', '一等座', '商务座']);
  assert.deepEqual(long, ['硬卧', '软卧', '高级软卧']);
});

test('钱紧就只买最低档 —— 一次都不许升', () => {
  // 余钱只够一张半票：升舱等于赌她到站没钱吃饭
  for (let i = 0; i < 200; i++) {
    assert.equal(pickGrade(train, 2000, 1.2).name, '硬卧');
    assert.equal(pickGrade(plane, 2000, 1.2).name, '经济舱');
  }
});

test('钱松又长途：会买到商务座 / 公务舱', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(pickGrade(train, 800, 20).id);
  assert.ok(seen.has('business'), `300 次里一次都没买商务座：${[...seen].join('/')}`);
  const seenPlane = new Set();
  for (let i = 0; i < 300; i++) seenPlane.add(pickGrade(plane, 2000, 20).id);
  assert.ok(seenPlane.has('business-class'), `公务舱一次都没有：${[...seenPlane].join('/')}`);
});

test('短途不买顶档 —— 两个小时的车买商务座不值', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(pickGrade(train, 300, 50).id);
  assert.equal(seen.has('business'), false, '三百公里也买商务座，那不叫舍得，叫乱花');
});

test('不分档的方式返回 undefined，不是崩', () => {
  assert.equal(pickGrade(modeById('walk'), 10, 20), undefined);
  assert.equal(pickGrade(modeById('car'), 500, 20), undefined);
});

test('没记账（purse=null）也能给出一档，不当成没钱', () => {
  const g = pickGrade(train, 1500, null);
  assert.ok(g && g.id, 'null 应该按「不紧不松」算，不是直接回最低档');
});

test('每一档都有 feel —— 没有依据，她只能瞎猜', () => {
  for (const km of [300, 2000]) {
    for (const g of train.grades(km)) {
      assert.ok(g.feel && g.feel.length > 8, `${g.name} 没有体感描述`);
    }
  }
  for (const g of plane.grades(1000)) {
    assert.ok(g.feel && g.feel.length > 8, `${g.name} 没有体感描述`);
  }
});
