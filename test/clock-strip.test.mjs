/**
 * 正文里的钟点和格子对不上时剥掉（2026-11-17，Donahue 第三批）。
 *
 * ## 现场
 *
 * 表上是「07:00 起床」，用户把它改成「六点半，赶拙政园开门头一趟」。
 * 格子还在 07:00，于是 `beatText` 拼出来是：
 *
 *   成都，当地 07:00。六点半，赶拙政园开门头一趟。
 *
 * 她读到的就是「七点起床、六点半又干一次」—— 用户说的「前后重复」。
 *
 * ## 这条守什么
 *
 * 1. 冲突的钟点要剥掉，且只剥那一小段（不能把整句吃掉）；
 * 2. 对得上的钟点一个字节都不动；
 * 3. 剥空了要退回原文 —— 「六点半」单独一格时剥掉等于把这一格删了；
 * 4. `beatText` 的头部本来就报了时刻，正文不该再出现第二个时间。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { stripClashClock, clockInText, beatText } = await import('../src/helpers.ts');

test('冲突的钟点剥掉，其余文字保留', () => {
  assert.equal(
    stripClashClock('起床，六点半，赶拙政园开门头一趟', 7),
    '起床，赶拙政园开门头一趟',
  );
  assert.equal(stripClashClock('6:30 出门', 7), '出门');
  // 剥完别留下开头的逗号
  assert.equal(stripClashClock('六点半，出门', 7), '出门');
});

test('对得上的钟点一个字都不动', () => {
  assert.equal(stripClashClock('六点半，出门', 6.5), '六点半，出门');
  assert.equal(stripClashClock('6:30 出门', 6.5), '6:30 出门');
  // 3 分钟以内的都算对得上（判冲突不要求精确到分钟）
  assert.equal(stripClashClock('7:02 起床', 7), '7:02 起床');
});

test('没有钟点的句子原样返回', () => {
  assert.equal(stripClashClock('出门，赶拙政园开门头一趟', 7), '出门，赶拙政园开门头一趟');
});

test('剥空了要退回原文 —— 否则等于把这一格删了', () => {
  assert.equal(stripClashClock('六点半', 7), '六点半');
  assert.equal(stripClashClock('6:30', 7), '6:30');
});

test('认钟点：两种写法都认，认不出的返回 null', () => {
  assert.equal(clockInText('6:30 出门'), 6.5);
  assert.equal(clockInText('六点半'), 6.5);
  assert.equal(clockInText('十二点'), 12);
  assert.equal(clockInText('出门'), null);
});

test('beatText 里不会出现两个时间', () => {
  /*
   * 用最少的 plan 形状 —— 这条只关心 `what` 怎么被拼进正文，
   * 不走日出的分支（那个读 `plan.sunriseHour`）。
   */
  const city = { id: 'chengdu', name: '成都', region: '四川', country: 'CN', tags: [], spots: [] };
  const plan = { beats: [], sunriseHour: null, lodging: { price: 180 } };
  const text = beatText(city, plan, 'wake', 7, '起床，六点半，赶拙政园开门头一趟');
  assert.ok(!text.includes('六点半'), `两个时间摆在一起了：${text}`);
  assert.match(text, /当地/, text);
  assert.match(text, /赶拙政园/, '把整句吃掉了');
});
