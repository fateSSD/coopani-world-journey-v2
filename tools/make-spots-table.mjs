/**
 * 把 102 个城市的行程条目导出成一张能搜、能筛的 HTML 表。
 *
 * 目的：让 Mr.Q 一眼看出哪条不对、哪条要换 —— 不是给他看统计数字。
 * 所以按「三天」分组显示（他实际看到的就是这个），并把「吃」标出来：
 * 吃占一个上午是这一版最大的问题，得让它在表里显眼。
 */
import { writeFileSync } from 'node:fs';
import { CITIES } from '../src/geo/cities.ts';

const FOOD = /^(一碗|一份|一锅|一顿|一桌|一笼|一客|一串|一个|一块|一根|一壶|一碟|一套|一家|路边摊|早市|街头|西关的早茶|老孙家|老边|知味观|庐州)/;
const FOREIGN = new Set(['tokyo', 'osaka', 'seoul', 'bangkok', 'singapore', 'hanoi', 'paris', 'london',
  'rome', 'moscow', 'newyork', 'losangeles', 'sydney', 'auckland', 'dubai', 'istanbul']);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const rows = CITIES.map((c, i) => {
  const s = c.spots;
  const cell = (a, b) => {
    const one = (x) => {
      if (!x) return '<span class=gap>—</span>';
      const cls = FOOD.test(x) ? 'food' : '';
      return `<span class="item ${cls}">${esc(x)}</span>`;
    };
    return `${one(a)} ${one(b)}`;
  };
  const where = FOREIGN.has(c.id) ? '外' : (c.id === 'xianggang' || c.id === 'aomen' ? '港澳' : '内');
  return `<tr data-region="${where}" data-food="${s.some((x) => FOOD.test(x)) ? 1 : 0}">
    <td class=n>${i + 1}</td>
    <td class="city"><b>${esc(c.name)}</b><small>${esc(c.region)}</small></td>
    <td>${cell(s[0], s[1])}</td>
    <td>${cell(s[2], s[3])}</td>
    <td>${cell(s[4], s[5])}</td>
    <td class=rest>${s.slice(6).map((x) => `<span class="item ${FOOD.test(x) ? 'food' : ''}">${esc(x)}</span>`).join(' ') || '<span class=gap>—</span>'}</td>
    <td class=night>${c.night ? esc(c.night) : '<span class=gap>晚上回酒店</span>'}</td>
    <td class=fest>${c.festival
      ? `<span class="item fest">${esc(c.festival.name)}</span><small>${c.festival.months.join('、')} 月</small>`
      : '<span class=gap>—</span>'}</td>
  </tr>`;
}).join('\n');

const total = CITIES.reduce((n, c) => n + c.spots.length, 0);
const NIGHT_N = CITIES.filter((c) => c.night).length;
const FEST_N = CITIES.filter((c) => c.festival).length;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>城市行程条目一览 · ${CITIES.length} 城 ${total} 条</title>
<style>
  :root{--ink:#1c1a17;--soft:#6b635b;--line:#e2ddd5;--bg:#fbf9f6;--card:#fff;
        --accent:#b4552d;--food:#c47c1e;--ok:#3d7a52}
  @media (prefers-color-scheme:dark){:root{--ink:#eee9e2;--soft:#9c948a;--line:#3a3631;
        --bg:#191715;--card:#211e1b;--accent:#e08a5d;--food:#d8a055;--ok:#6ba57f}}
  *{box-sizing:border-box}
  body{margin:0;padding:28px 20px 60px;background:var(--bg);color:var(--ink);
    font:15px/1.65 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:1180px;margin:0 auto}
  h1{font-size:22px;margin:0 0 6px;font-weight:650;letter-spacing:.3px}
  .sub{color:var(--soft);font-size:13.5px;margin-bottom:20px}
  .bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:16px}
  input[type=search]{flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--line);
    border-radius:8px;background:var(--card);color:var(--ink);font-size:14px;outline:none}
  input[type=search]:focus{border-color:var(--accent)}
  .chip{padding:6px 13px;border:1px solid var(--line);border-radius:999px;background:var(--card);
    color:var(--soft);font-size:13px;cursor:pointer;user-select:none}
  .chip[aria-pressed=true]{border-color:var(--accent);color:var(--accent);font-weight:600}
  table{width:100%;border-collapse:collapse;background:var(--card);border-radius:10px;overflow:hidden;
    box-shadow:0 1px 2px rgba(0,0,0,.04)}
  th,td{padding:9px 11px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top;font-size:13.5px}
  th{background:color-mix(in srgb,var(--card) 88%,var(--ink));font-weight:600;font-size:12.5px;
    color:var(--soft);position:sticky;top:0;z-index:1;white-space:nowrap}
  tr:last-child td{border-bottom:none}
  td.n{color:var(--soft);font-size:12px;width:34px;text-align:right;padding-right:4px}
  td.city{white-space:nowrap;min-width:96px}
  td.city small{display:block;color:var(--soft);font-size:11.5px;font-weight:400}
  .item{display:inline-block;margin:0 4px 3px 0;padding:1px 7px;border-radius:5px;
    background:color-mix(in srgb,var(--card) 82%,var(--ink));white-space:nowrap}
  .item.food{background:color-mix(in srgb,var(--food) 16%,transparent);
    color:var(--food);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--food) 34%,transparent)}
  .gap{color:var(--soft);opacity:.45}
  td.rest{color:var(--soft);max-width:190px}
  td.night{max-width:190px;color:var(--ink)}
  td.fest{white-space:nowrap}
  td.fest small{display:block;color:var(--soft);font-size:11px}
  .item.fest{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok);
    box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ok) 34%,transparent)}
  .legend{margin-top:16px;font-size:13px;color:var(--soft);line-height:2}
  .legend b{color:var(--food)}
  .hide{display:none}
</style></head><body><div class=wrap>
<h1>城市行程条目一览</h1>
<p class=sub>${CITIES.length} 个城市 · ${total} 条 · 每城 6–8 条 ·
  有夜生活的 ${NIGHT_N} 城 · 有时节的 ${FEST_N} 城。表格按「住三天各排什么」分组，跟你实际看到的一致。</p>
<div class=bar>
  <input type=search id=q placeholder="搜城市或条目，比如「夜市」「兰州」">
  <button class=chip id=f-all aria-pressed=true>全部</button>
  <button class=chip id=f-in aria-pressed=false>国内</button>
  <button class=chip id=f-out aria-pressed=false>国外</button>
</div>
<table><thead><tr>
  <th></th><th>城市</th><th>第 1 天</th><th>第 2 天</th><th>第 3 天</th><th>备用（第 4 天起）</th><th>夜里（20:25）</th><th>时节</th>
</tr></thead><tbody id=tb>
${rows}
</tbody></table>
<p class=legend>
  <b>橙色</b>是「吃」—— 它还占着第 3 天上午那一格（下一步要挪到夜里，白天换成别处）。<br>
  <b>「夜里」</b>那列是 20:25 那条：只有当地真有晚上才成立的去处才填，写灰的「晚上回酒店」就是真没有。<br>
  <b>绿色</b>是当地时节，只在那几个月出现。农历藏历的节日只给了月份，没法精确到日。<br>
  港澳在「国内」筛选项里。
</p>
</div>
<script>
const q = document.getElementById('q'), tb = document.getElementById('tb');
let region = 'all';
function apply(){
  const kw = q.value.trim().toLowerCase();
  for (const tr of tb.rows){
    const txt = tr.textContent.toLowerCase();
    let ok = kw === '' || txt.includes(kw);
    if (ok && region !== 'all') ok = tr.dataset.region === region;
    tr.classList.toggle('hide', !ok);
  }
}
q.addEventListener('input', apply);
const chips = { all: document.getElementById('f-all'), in: document.getElementById('f-in'),
                out: document.getElementById('f-out') };
function pick(name){
  for (const [k, el] of Object.entries(chips)) el.setAttribute('aria-pressed', String(k === name));
}
chips.all.onclick = () => { region = 'all'; pick('all'); apply(); };
chips.in.onclick  = () => { region = '内'; pick('in'); apply(); };
chips.out.onclick = () => { region = '外'; pick('out'); apply(); };
</script></body></html>`;

// 输出到项目根，**不能进 dist/** —— package.json 的 files 里有 dist，
// 放进会被打上 npm（多 54KB 的无用文件，而且它不是扩展的运行时资源）。
writeFileSync(new URL('../spots-table.html', import.meta.url), html, 'utf8');
console.log(`已生成：${CITIES.length} 城 ${total} 条 | 有夜间去处 ${NIGHT_N} 城 | 有节日 ${FEST_N} 城`);
