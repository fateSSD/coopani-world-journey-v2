/*
 * 把携程问道给的酒店（只有店名 + 挂牌星级，没有房价）并进 hotel-facts.json。
 *
 * ## 为什么单独一个脚本
 *
 * `data/hotel-facts.json` 是 `fetch-hotel-facts.mjs` 从 TourMind 拉的**真库存**
 * （店名 + 真价 + 设施 + 周边）。这 8 座城市 TourMind 没开库存，一家也拿不到。
 *
 * 问道给的是**内容**不是库存：店名可信、星级可信，但**问不出房价** ——
 * 六个城市十八家店，价格一栏全部答「不确定」。这一点很重要：
 *
 * > 挂了真名之后报一个推出来的价，用户一核对就是错的。
 * > 所以这里 **price 一律写 0**，让 `factsFor` 退回「这一档该花多少」的游戏内定价，
 * > 而不是伪造一个"真实房价"。
 *
 * 星级保留：没有价格时 `tierOfStar` 用它定档，这正是它存在的意义。
 *
 * 幂等：同一个 cityId 已有的问道店会被替换，不会重复堆。
 *
 * 用法：npx tsx tools/merge-wendao-hotels.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'hotel-facts.json');

/*
 * 问道原始回答的留档（2026-11-10）。
 * 每行：城市｜酒店名｜星级
 * 星级「不确定」的不收 —— 没有价格又没有星级，这条数据就只剩一个名字，进了也是噪声。
 */
const RAW = `
喀山｜喀山市中心希尔顿逸林酒店｜4
喀山｜喀山市中心温德姆华美达酒店｜4
伊尔库茨克｜商人院落｜4
伊尔库茨克｜中央历史酒店｜4
伊尔库茨克｜欧罗巴酒店｜4
符拉迪沃斯托克｜海参崴乐天酒店｜5
符拉迪沃斯托克｜诺富特海参崴酒店｜4
符拉迪沃斯托克｜马格南大皇宫酒店｜5
叶卡捷琳堡｜叶卡捷琳堡凯悦嘉轩酒店｜4
叶卡捷琳堡｜叶卡捷琳堡市中心诺富特酒店｜4
叶卡捷琳堡｜Suite Hotel｜3
加里宁格勒｜加里宁格勒丽笙酒店｜4
加里宁格勒｜加里宁格勒酒店｜3
加里宁格勒｜凯瑟霍夫酒店｜4
苏兹达尔｜普希卡斯卡娅斯洛博达｜4
苏兹达尔｜GTK苏兹达尔酒店｜3
苏兹达尔｜Sokol Hotel｜3
下诺夫哥罗德｜下诺夫哥罗德克里姆林宫喜来登｜5
下诺夫哥罗德｜下诺夫哥罗德 Marins 公园酒店｜4
下诺夫哥罗德｜雅罗斯拉夫 SPA 酒店｜4
库特纳霍拉｜库特纳霍拉宫廷｜4
库特纳霍拉｜U卡塔酒店｜3
库特纳霍拉｜兹拉塔斯特奥普酒店｜3
`;

/* 中文城市名 → 我们的 cityId。问过一次就别再问，写死比每次猜稳。 */
const CITY_ID = {
  喀山: 'kazan',
  伊尔库茨克: 'irkutsk',
  符拉迪沃斯托克: 'vladivostok',
  叶卡捷琳堡: 'yekaterinburg',
  加里宁格勒: 'kaliningrad',
  苏兹达尔: 'suzdal',
  下诺夫哥罗德: 'nizhnynovgorod',
  库特纳霍拉: 'kutnahora',
};

const clean = (s) => String(s).replace(/[<>《》]/g, '').trim();

const byCity = new Map();
for (const line of RAW.split('\n')) {
  const t = line.trim();
  if (!t) continue;
  const [cityRaw, nameRaw, starRaw] = t.split('｜');
  const cityId = CITY_ID[clean(cityRaw)];
  if (!cityId) throw new Error(`没配 cityId：${cityRaw}`);
  const star = Number(clean(starRaw));
  if (!Number.isFinite(star) || star <= 0) continue;
  if (!byCity.has(cityId)) byCity.set(cityId, []);
  byCity.get(cityId).push({ name: clean(nameRaw), star });
}

const db = JSON.parse(readFileSync(OUT, 'utf8'));
let added = 0;
for (const [cityId, list] of byCity) {
  const prev = db.cities[cityId]?.hotels ?? [];
  /* 只替掉问道自己加过的（id 以 `wd-` 开头），TourMind 的真库存一条不动。 */
  const kept = prev.filter((h) => !String(h.id).startsWith('wd-'));
  const mine = list.map((h, i) => ({
    id: `wd-${cityId}-${i + 1}`,
    name: h.name,
    star: h.star,
    /*
     * **0 = 没有真价。** 不是"免费"。`factsFor` 见到 0 就不覆盖价格，
     * 沿用游戏内这一档该花的钱 —— 绝不让它冒充真实房价。
     */
    price: 0,
    addr: '',
    amen: [],
    around: [],
    flags: [],
  }));
  db.cities[cityId] = {
    ...(db.cities[cityId] ?? { regionId: '', regionName: '', poolSize: 0, pool: [] }),
    hotels: [...kept, ...mine],
    srcWendao: true,
  };
  added += mine.length;
  console.log(`  ${cityId}: ${mine.length} 家（问道，无房价）`);
}

db.wendaoMergedAt = new Date().toISOString();
writeFileSync(OUT, `${JSON.stringify(db, null, 1)}\n`, 'utf8');
console.log(`合并完成：${byCity.size} 城 / ${added} 家 → ${OUT}`);
