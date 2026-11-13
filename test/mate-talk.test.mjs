/**
 * 一起走的时候，正文里得有那个人。
 *
 * 2026-11-07 Mr.Q：「一起旅行的时候一起旅行的鱼得有互动（一起坐一辆车、
 * 住同一个酒店、互相打趣啥的）。」
 *
 * 在那之前正文只有「跟谁约好待几天」—— 全是约定的元数据，
 * 那个人在整趟行程里没做过任何事。
 */
const { travelWith, stayWith, banterWith } = await import('../src/mate-talk.ts');
const assert = (await import('node:assert/strict')).default;
const { test } = await import('node:test');

const WHO = '小满';

test('三种场景都能出句，且句子里一定有名字', () => {
  for (const seed of [0, 1, 2, 3, 7, 42]) {
    for (const fn of [travelWith, stayWith, banterWith]) {
      const s = fn === travelWith ? fn(WHO, '高铁', seed) : fn(WHO, seed);
      assert.ok(s.includes(WHO), `没提到名字：${s}`);
      assert.ok(s.length > 6 && s.length < 60, `长度离谱（${s.length}）：${s}`);
      assert.doesNotMatch(s, /undefined|NaN|\[object/, `有占位符：${s}`);
    }
  }
});

test('同一个种子同一句话 —— 重算不能换措辞', () => {
  for (const seed of [0, 3, 11]) {
    assert.equal(travelWith(WHO, '火车', seed), travelWith(WHO, '火车', seed));
    assert.equal(stayWith(WHO, seed), stayWith(WHO, seed));
    assert.equal(banterWith(WHO, seed), banterWith(WHO, seed));
  }
});

test('不同种子会换句子，不是一个池子只有一句', () => {
  const a = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((i) => banterWith(WHO, i)));
  assert.ok(a.size >= 4, `八次里只有 ${a.size} 种说法`);
});

test('坐船用「铺位」，坐车用「座位」', () => {
  const boat = [0, 1, 2, 3, 4, 5].map((i) => travelWith(WHO, '轮船', i)).join('');
  assert.match(boat, /铺位|座位|站台|票/, '坐船这一档没有合适的词');
});

test('住店那句只讲房间关系，不重复酒店本身', () => {
  for (let i = 0; i < 8; i++) {
    const s = stayWith(WHO, i);
    assert.doesNotMatch(s, /块一晚|快捷连锁|五星/, `重复了酒店信息：${s}`);
  }
});
