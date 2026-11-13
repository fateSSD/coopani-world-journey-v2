/**
 * 导出一份可编辑的 CSV，用来在资料库里双向同步行程数据。
 *
 * 和那张只读 HTML 的区别：这份是给人**改**的。
 * 每一格对应 cities.ts 里一条数据，改完我再读回来落进代码。
 *
 * 列的顺序刻意跟 `spotText` 的取值顺序一致（spots[0]…spots[5]），
 * 这样看一眼就知道改的是第几个位置，不用去猜。
 */
import { writeFileSync } from 'node:fs';
import { CITIES } from '../src/geo/cities.ts';

const FOREIGN = new Set(['tokyo', 'osaka', 'seoul', 'bangkok', 'singapore', 'hanoi', 'paris', 'london',
  'rome', 'moscow', 'newyork', 'losangeles', 'sydney', 'auckland', 'dubai', 'istanbul']);

/** CSV 单元格转义：逗号、引号、换行都得包起来。 */
const q = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const header = [
  '城市', '地点', '第1天上午', '第1天下午', '第2天上午', '第2天下午', '第3天上午', '第3天下午',
  '备用（第4天起）', '夜里（20:25）', '当地节日', '节日月份', '备注（你要改的写这儿）',
];

const lines = [header.map(q).join(',')];

for (const c of CITIES) {
  const s = c.spots;
  const where = FOREIGN.has(c.id) ? '国外' : (c.id === 'xianggang' || c.id === 'aomen' ? '港澳' : '国内');
  lines.push([
    c.name,
    where,
    s[0] ?? '', s[1] ?? '',
    s[2] ?? '', s[3] ?? '',
    s[4] ?? '', s[5] ?? '',
    s.slice(6).join(' / '),
    c.night ?? '',
    c.festival?.name ?? '',
    c.festival ? c.festival.months.join('、') + ' 月' : '',
    '',
  ].map(q).join(','));
}

writeFileSync(new URL('../spots-sync.csv', import.meta.url), lines.join('\n') + '\n', 'utf8');

const withNight = CITIES.filter((c) => c.night).length;
const withFest = CITIES.filter((c) => c.festival).length;
console.log(`CSV 已生成：${CITIES.length} 行 | 有夜间 ${withNight} | 有节日 ${withFest}`);
