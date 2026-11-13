/**
 * 密钥搬家（#659 第二条，2026-11-13）。
 *
 * 这组测试只问一件事：**什么时候我们允许把配置里那份清掉。**
 * 答错一次就是把用户的 key 抹掉，用户不会有任何提示 —— 只会发现
 * 「明明填了，怎么又没了」。所以每种失败路径都要有一条。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  AMAP_KEY_NAME, IMAGE_KEY_NAME, readKey, adoptKey,
} = await import('../src/secrets.ts');

/** 一个内存版宿主：`refuse` 模拟试挂载的空实现（写不抛错，但存不下来）。 */
function fakeHost(init = {}, { refuse = false } = {}) {
  const env = { ...init };
  return {
    env,
    ports: {
      read: (name) => env[name] ?? '',
      write: (name, value) => { if (!refuse) env[name] = value; },
    },
  };
}

test('读：.env 里有就用 .env，没有才看配置项', () => {
  const { ports } = fakeHost({ [AMAP_KEY_NAME]: 'from-env' });
  assert.equal(readKey(ports, AMAP_KEY_NAME, 'from-cfg'), 'from-env', '.env 被配置项盖住了');
  assert.equal(readKey(ports, AMAP_KEY_NAME, ''), 'from-env');
  assert.equal(readKey({}, AMAP_KEY_NAME, 'from-cfg'), 'from-cfg', '没有宿主口子时该回落到配置');
});

test('搬：配置里那份写进 .env，然后配置该清空', () => {
  const h = fakeHost();
  const next = adoptKey(h.ports, AMAP_KEY_NAME, '  k-123  ');
  assert.equal(h.env[AMAP_KEY_NAME], 'k-123', '值没进 .env，或者前后空格没去');
  assert.equal(next, '', '搬成功了却没让调用方清配置 —— 下次启动会一直重搬');
});

test('搬：试挂载的空实现（写不报错但存不下）**绝不能**清配置', () => {
  /*
   * 这条是最要命的。宿主的 dry-mount 给 `storeSecret` 的是 `() => {}`：
   * 不抛错，只是什么都不做。如果按「没抛错就算搬好了」判断，
   * 试挂载一跑，用户的 key 就从 config.json 里消失了。
   */
  const h = fakeHost({}, { refuse: true });
  const next = adoptKey(h.ports, AMAP_KEY_NAME, 'k-123');
  assert.equal(next, 'k-123', '写不进去还把配置清了 —— 用户的 key 就这么没了');
});

test('搬：写的时候抛错（值里有空白）也不清配置', () => {
  const ports = {
    read: () => '',
    write: () => { throw new Error('the value of JOURNEY_AMAP_KEY is empty or holds whitespace'); },
  };
  const warnings = [];
  const next = adoptKey(ports, AMAP_KEY_NAME, 'has space', { info: () => {}, warn: (m) => warnings.push(m) });
  assert.equal(next, 'has space', '写失败还把配置清了');
  assert.equal(warnings.length, 1, '失败了却不出声，用户查不出来');
  assert.match(warnings[0], /没能搬进/);
});

test('搬：已经在 .env 里了，只清配置，不重复写', () => {
  let writes = 0;
  const ports = {
    read: () => 'k-123',
    write: () => { writes += 1; },
  };
  assert.equal(adoptKey(ports, AMAP_KEY_NAME, 'k-123'), '', '搬家成功了却没清配置');
  assert.equal(writes, 0, '值一样还去写了 —— 每次启动都动一次 .env');
});

test('搬：配置为空就是没得搬，返回原值', () => {
  const h = fakeHost();
  assert.equal(adoptKey(h.ports, AMAP_KEY_NAME, ''), '', '空值居然被改成了别的东西');
  assert.deepEqual(h.env, {}, '空值也往 .env 里写了一条');
  assert.equal(adoptKey(h.ports, AMAP_KEY_NAME, '   '), '   ', '只有空格也被当成有值');
});

test('搬：没有宿主口子时什么都不做', () => {
  assert.equal(adoptKey(undefined, AMAP_KEY_NAME, 'k-123'), 'k-123');
});

test('两个密钥各有各的名字，不会互相盖住', () => {
  assert.notEqual(AMAP_KEY_NAME, IMAGE_KEY_NAME);
  const h = fakeHost();
  adoptKey(h.ports, AMAP_KEY_NAME, 'amap-value');
  adoptKey(h.ports, IMAGE_KEY_NAME, 'image-value');
  assert.equal(h.env[AMAP_KEY_NAME], 'amap-value');
  assert.equal(h.env[IMAGE_KEY_NAME], 'image-value');
});
