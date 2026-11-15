/**
 * 「这几天跟谁一起过」—— 2026-11-06
 *
 * Mr.Q 的原话：「我一开始不就是要让她和一群肥鱼一起旅行嘛？日记肯定要体现啊，
 * 行程肯定要安排啊。」
 *
 * 查下来：邀约（invite/accept）、约定（pledge）、一起待 N 天，机制**全都有**，
 * 但「一起」这件事只在 `journey.arrive` 那一条里说过一次。之后那 N 天的
 * `journey.day` 一个字不提 —— 她写日记时手上没有这个事实，只能写风景。
 *
 * 所以 `mateLine()` 要守住的是**什么时候能说、什么时候不能说**：
 * 人还在路上就说「一起过」，是替她提前见面；城不对还说，是把她钉在上一个地方。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { JourneyWorld } = await import('../src/world.ts');
const { JOURNEY_DEFAULTS } = await import('../src/config.ts');

function bare() {
  const dir = mkdtempSync(join(tmpdir(), 'jr-mate-'));
  return new JourneyWorld({
    cfg: { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州' },
    dataDir: dir,
    botName: '大肥鱼',
    now: () => new Date('2026-11-06T12:00:00Z'),
  });
}

const PLEDGE = {
  cityId: 'chengdu',
  days: 3,
  withPet: '诺艾尔的小银鱼',
  inviteId: 'inv-1',
  acceptedAt: '2026-11-05T02:00:00.000Z',
  arrivedAt: '2026-11-06T01:00:00.000Z',
};

test('已经一起待着：说清第几天、还剩几天', () => {
  const w = bare();
  const line = w.mateLine(PLEDGE, 'chengdu', 0);
  assert.match(line, /诺艾尔的小银鱼/, '没说跟谁');
  assert.match(line, /第 1 天/, `第一天没算对：${line}`);
  assert.match(line, /还剩 2 天/, `剩余天数没算对：${line}`);
});

test('最后一天要说「明天各走各的」，不能说「还剩 0 天」', () => {
  const w = bare();
  const line = w.mateLine(PLEDGE, 'chengdu', 2);
  assert.match(line, /第 3 天/, line);
  assert.match(line, /最后一天/, `最后一天没标出来：${line}`);
  assert.doesNotMatch(line, /还剩 0 天/, line);
});

test('人还在路上就不能说一起过', () => {
  const w = bare();
  const line = w.mateLine({ ...PLEDGE, arrivedAt: null }, 'chengdu', 0);
  assert.equal(line, '', '对方还没到就说「一起过」= 替她提前见面');
});

test('城对不上就不提 —— 那趟已经过去了', () => {
  const w = bare();
  assert.equal(w.mateLine(PLEDGE, 'xian', 0), '', '人已经走了还说一起过，会把她钉在上一个地方');
});

test('没有约定就是空串，别硬凑一句', () => {
  const w = bare();
  assert.equal(w.mateLine(null, 'chengdu', 0), '');
});

test('多个人一起时名字都要出现', () => {
  const w = bare();
  /*
   * 0.7 时代一条邀约只能成一对，所以只存一个名字。现在一条能让三只鱼接，
   * `withPets` 是后来加的 —— 只念 `withPet` 会把另外两个静默丢掉。
   */
  const line = w.mateLine({ ...PLEDGE, withPets: ['诺艾尔的小银鱼', '沃兔'] }, 'chengdu', 1);
  assert.match(line, /沃兔/, `同行的第三个人没出现：${line}`);
});

test('认领别人的邀约：按编号去重、途中不认领', async () => {
  /*
   * 两条都是 2026-11-06 的 144 天长跑抓出来的，而且**都不是报错**——
   * 跑得下去、不变量全绿，但状态是错的：
   *
   *   ① 同一条邀约被反复认领（`invite-taken-…` 重复推），pledge 常年占着，
   *      那 30 天里她一次都没机会去接别人的约。
   *   ② 途中认领别人接的邀约 → 面板上一边「在飞布宜诺斯艾利斯」
   *      一边「跟人说好去稻城亚丁」。飞机改不了航向，那份约定从建立起就兑现不了。
   */
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    list: [{ id: 'abcdef0123456789', pet: '小满', to: 'chengdu', days: 3, note: '一起吃火锅' }],
  }), { status: 200 });
  try {
    const now = new Date('2026-11-06T12:00:00Z');
    const meet = { url: 'https://x.app.tcloudbase.com', uid: '0123456789abcdef01234567', pet: '大肥鱼' };

    const onRoad = bare();
    onRoad.st = { ...onRoad.st, phase: 'traveling', hereId: 'lanzhou' };
    await onRoad.claimTakenInvite(meet, now);
    assert.equal(onRoad.st.pledge, null, '途中认领了 —— 那趟的去向已经定死，这份约定注定兑现不了');

    const settled = bare();
    settled.st = { ...settled.st, phase: 'staying', hereId: 'lanzhou' };
    await settled.claimTakenInvite(meet, now);
    assert.equal(settled.st.pledge?.inviteId, 'abcdef0123456789', '停留时应该正常认领');
    assert.ok(settled.st.claimedInvites.includes('abcdef0123456789'), '认领后编号没记进 claimedInvites');

    // 约定结束后服务端仍返回同一条，不能再认领第二遍
    settled.st = { ...settled.st, pledge: null };
    await settled.claimTakenInvite(meet, now);
    assert.equal(settled.st.pledge, null, '没按编号去重 —— 同一条邀约被重复认领了');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('一起待着的日子里有「她做了什么」—— 不只是天数', () => {
  /*
   * 2026-11-07 Mr.Q：「一起旅行的鱼得有互动（…互相打趣啥的）」。
   *
   * 原来这句只有「跟谁、几天、第几天」，全是约定的元数据 ——
   * 那个人在整趟行程里没有做过任何一件事。现在第二行必须是人做过的事，
   * 而且不许又退回「第几天」那种话。
   */
  const w = bare();
  const line = w.mateLine({ ...PLEDGE, withPet: '小满' }, 'chengdu', 1);
  const parts = line.split('\n');
  /*
   * 三行：元数据 / 今天做的事（打趣）/ 走到了哪一步（熟络度，2026-11-08 加）。
   * 后两行都不许退回「第几天」那种账目。
   */
  assert.equal(parts.length, 3, `行数不对（${parts.length}）：${line}`);
  for (const i of [1, 2]) {
    assert.match(parts[i], /小满/, `第 ${i + 1} 行没提到人：${parts[i]}`);
    assert.doesNotMatch(parts[i], /第 \d+ 天|还剩|待 \d+ 天/, `第 ${i + 1} 行又在报天数：${parts[i]}`);
  }
});

test('还在等的那几天不许编互动 —— 人还没露面', () => {
  const w = bare();
  const line = w.mateLine(
    { ...PLEDGE, arrivedAt: null, meetCityId: 'chengdu', meetArrivedAt: '2026-11-06T00:30:00.000Z' },
    'chengdu',
    2,
  );
  assert.match(line, /等着|人还没露面/);
  assert.equal(line.split('\n').length, 1, `等人期间冒出了互动：${line}`);
});
