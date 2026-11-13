/**
 * 同一家店，不能一边说有酒吧、一边说没有（2026-11-12 西安实测）。
 *
 * 那晚的真实经过：
 *   到达事件：西安钟楼智选假日酒店，「顶层有个小酒吧，晚上有人弹琴。出门拐个弯就是塔。」
 *   他说：去酒吧喝点酒咋样
 *   她（调 journey_hotel_night：bar）：这家没这个。今晚能干的：泡澡、在房间待着。
 *   她（正文）：**系统只给我泡澡和待屋里两个选项。**
 *
 * 三处错，分开钉：
 *
 * 1. **数据死了**：`hotel-facts.json` 里这家店 `flags` 明明有 `bar`、`around` 有钟楼 0.4km，
 *    但 `st.lodging.value` 存盘只挑 tier/kind/price/feel/name/address，
 *    `state.ts` 读回又是一道白名单 —— 两处都把 `amen`/`around` 丢了。
 *    `feel` 是字符串，活下来了；这两个是字段，死了。
 * 2. **不会自愈**：`pinned` 有 `name` → `pois` 置空 → `withHotel` 第一行 `return base`。
 *    所以只能按名字回 facts 查一次（`healLodgingFacts`）。
 * 3. **把门锁了**：`around` 一空，连「出门走走」都不给，选项退化成两项 ——
 *    「没有数据」和「确实远」是两回事。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { factsFor } = await import('../src/geo/hotel-facts.ts');
const { hotelNightOptions } = await import('../src/plan/leisure.ts');
const { StateStore } = await import('../src/state.ts');

const HOTEL = '西安钟楼智选假日酒店';

test('设施与周边存进 state 就读得回来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journey-lodging-'));
  try {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      version: 1,
      hereId: 'xian',
      lodging: {
        cityId: 'xian',
        stayKey: 'xian|2026-11-11T23:24:13.402Z',
        value: {
          tier: 'luxury',
          kind: '套房',
          name: HOTEL,
          address: '南大街70号',
          price: 2585,
          feel: '地毯厚，走过去听不见脚步；热水要放一会儿才来。顶层有个小酒吧，晚上有人弹琴。出门拐个弯就是塔。',
          amen: ['restaurant', 'bar', 'parking'],
          around: [{ n: "Xi'an Bell Tower", km: 0.4 }],
        },
      },
    }), 'utf8');

    const { state, problem } = new StateStore(dir).load('lanzhou');
    assert.equal(problem, null, `读状态就报错了：${problem}`);
    const v = state.lodging?.value;
    assert.ok(v, 'lodging 整条读没了');
    assert.deepEqual([...(v.amen ?? [])], ['restaurant', 'bar', 'parking'],
      '读回来丢了 amen —— 于是「这家有没有酒吧」永远答没有');
    assert.equal(v.around?.[0]?.km, 0.4, '读回来丢了 around —— 于是「出门转转」永远给不出来');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('事实表里这家店有 bar 和近处的地标', () => {
  const row = factsFor('xian').find((h) => h.name === HOTEL);
  assert.ok(row, 'hotel-facts.json 里找不到这家店，数据文件换过了？');
  assert.ok(row.amen.includes('bar'), `flags 里应该有 bar，实际是：${row.amen.join('/')}`);
  assert.ok(row.around?.length, '应该采到周边景点');
});

test('同一份设施，晚上就该给出酒吧和出门转转', () => {
  const row = factsFor('xian').find((h) => h.name === HOTEL);
  const whats = hotelNightOptions('luxury', row.amen, row.around).map((o) => o.what);
  assert.ok(whats.includes('bar'), `有 bar 设施却不给喝酒：${whats.join('/')}`);
  assert.ok(whats.includes('around'), `0.4 公里就有钟楼，却没给「出门转转」：${whats.join('/')}`);
  assert.ok(!whats.includes('spa'), `这家店没有 spa，不许给：${whats.join('/')}`);
});

test('没有周边数据不等于把门锁了', () => {
  const whats = hotelNightOptions('luxury', [], []).map((o) => o.what);
  assert.ok(whats.includes('around'), `周围没数据就把「出门走走」吞了：${whats.join('/')}`);
  for (const bad of ['pool', 'gym', 'spa', 'bar', 'onsen']) {
    assert.ok(!whats.includes(bad), `没有设施却冒出了「${bad}」`);
  }
});
