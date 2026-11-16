#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""加一座城：孝感。只追加，不改已有条目（九张表里的八张，PRICE_IDX 走默认 1.0）。

读者来信（阿智，2026-11-16）：填了「孝感」，每次回来还是在兰州。
查下来跟东莞同一个病根 —— `CITIES` 里整座城不存在，`resolveHome()` 认不出来就回落兰州。
"""
import re

PATH = 'src/geo/cities.ts'

BLOCKS = [
    ('const SPOTS: Record<string, readonly string[]> = {', '  changde: [', """  /*
   * 孝感（2026-11-16，读者来信：「我填了孝感，但是每次回来还是在兰州」）。
   *
   * 城名来自东汉董永卖身葬父、孝行感天；南朝宋置孝昌县，五代后唐避讳改「孝感」。
   * 二十四孝里董永、黄香、孟宗三个故事都发生在这儿，是全国唯一以「孝」命名的地级市。
   * 没有民航机场，往这儿来得先落武汉天河，再换城际。
   */
  xiaogan: [
    '董永公园（孝南）：槐荫大道边上，园里按「卖身葬父—孝行感天—仙女下凡—百日姻缘」的顺序摆着孝子祠、槐荫树、理丝桥、仙女池和升仙台，汉白玉的七仙女像立在池边',
    '澴河文昌阁（孝南）：澴河南路河堤上的一座楼阁，砖木结构三层，翘檐压着河面，傍晚堤上全是散步的人',
    '双峰山国家森林公园（孝昌丰山）：两峰对峙，主峰 873 米，森林覆盖率八成八，好汉坡的石阶又陡又长，山里有唐代黄巢屯兵的白云古寨和一面二十四孝浮雕墙',
    '白兆山（安陆烟店）：李白「酒隐安陆、蹉跎十年」的地方，桃花岩下有洗笔池、读书台和绀珠泉，山顶祖师顶上一株千年银杏',
    '钱冲古银杏（安陆王义贞）：中原少见的天然古银杏群落，几百株千年树挤在山谷里，十一月中旬叶子黄透，铺到地上像一层毯子',
    '汤池温泉（应城汤池镇）：水温七十二度，日涌量过万吨，露天池子一个叠一个，冬天水面全是白气，本地人叫它「亚洲第一泉」',
    '观音湖（孝昌小悟）：两万六千亩水面被山围住，三十三座岛散在湖里，坐船上「九岛十八汊」转一圈要小半天',
    '天紫湖（孝南肖港）：传说七仙女下凡沐浴的地方，湖面平得像一面镜子，岸边一片温泉池和草坡',
    '孝感市博物馆（孝南）：国家二级馆，「孝感动天」主题展把三个孝子故事串起来，另有一整层马口窑陶器和历代铜镜',
  ],
"""),
    ('const NIGHTS: Record<string, NightSpot> = {', '  changde:', """  xiaogan: '八点以后城站路大天桥底下的米酒馆还开着，一碗糊汤米酒配两根油条；体育路董永美食城的摊位亮到十点，澴河堤上的灯也跟着亮',
"""),
    ('const FOODS: Record<string, readonly string[]> = {', '  changde:', """  xiaogan: ['孝感米酒', '孝感麻糖', '云梦鱼面', '安陆白花菜', '汉川荷月', '汉川藕带', '应城扒肉', '大悟臭豆腐'],
"""),
    ('const LORE: Record<string, string> = {', '  changde:', """  xiaogan: '东汉董永卖身葬父、孝行感天，地名就从这儿来；南朝宋置孝昌县，五代后唐避讳改成孝感。二十四孝里董永行孝、黄香扇枕、孟宗哭竹三个故事都发生在这片地方',
"""),
    ('export const FEATURES: Record<string, CityFeature> = {', '  zhengzhou2:', """  xiaogan: { flower: '桃花', landmark: '董永公园', food: '孝感米酒' },
"""),
    ('const FESTIVALS: Record<string, readonly Festival[]> = {', '  changde:', """  xiaogan: [
    { name: '杨店龙灯', months: [2, 3], what: '正月十二夜里给龙灯开光，十三出行、上庙、喝彩，家家门前摆香案迎龙；十四各湾的龙灯回去叩拜乡邻，一直闹到十五。龙身是竹篾扎的，里面点着蜡烛，几十个人举着走' },
    { name: '钱冲银杏季', months: [11, 12], what: '十一月中山谷里的古银杏一起变黄，落叶堆在石阶上，村里人摆摊卖银杏果和烤红薯，周末车停到几里外' },
    { name: '汉川龙舟', months: [5, 6], what: '端午前后汈汊湖和汉江边下水，各村组队，鼓声从早上响到傍晚，岸上支锅煮粽子' },
  ],
"""),
    ('const SHOWS: Record<string, readonly string[]> = {', '  changde:', """  xiaogan: ['孝感大剧院：孝南区复兴大道文化中心，保利运营，大剧场、音乐厅、多功能厅三个厅，话剧、舞剧、音乐会和非遗皮影轮着演'],
"""),
    ('export const VISTA: Record<string, string> = {', '  changde:', """  xiaogan: '澴河从城南绕过去，槐荫大道的法桐在头顶合拢，路口立着孝文化主题的雕塑，天晴时能看见北边双峰山的淡影',
"""),
    ('const SPOT_LOOK: Record<string, Record<string, string>> = {', '  foshan:', """  xiaogan: {
    '董永公园（孝南）': '园门内一株老槐树，树干用石栏围住，旁边是汉白玉的七仙女立像和一座翘檐的孝子祠，池上架着理丝桥',
    '双峰山国家森林公园（孝昌丰山）': '两座青灰色石峰并立，山腰一片马尾松和杉木，好汉坡的石阶顺着山脊往上排，山顶有石砌的古寨墙',
    '汤池温泉（应城汤池镇）': '露天汤池一层层铺在山坡上，水面浮着白气，池边铺着青石板，远处是矮矮的竹林',
  },
"""),
    ('export const CITIES: readonly City[] = [', "  C('wuhan'", """  C('xiaogan', '孝感', '湖北', 30.9246, 113.9167, ['孝文化', '米酒', '麻糖', '澴河', '温泉'],
    { air: false },),
"""),
]


def entry_end(src, table_header, anchor):
    """锚点条目在表内结束的位置（下一条目起点或表尾）。

    ⚠ `];` 不只是 `};`：`CITIES` 是数组，结尾是 `];`。第一版只认 `};`，
    于是一路穿到下一张表，把城市条目插进了上一张表 —— 而且不报错。
    另外 `C('xxx'` 这种调用式条目行首没有冒号，也要算边界。
    """
    h = src.index(table_header)
    a = src.index(anchor, h)
    lines = src[a:].split('\n')
    pos = a + len(lines[0]) + 1
    for line in lines[1:]:
        if re.match(r"^  [A-Za-z_'][\w'-]*: ", line) or re.match(r"^  C\('", line) or line.startswith('};') or line.startswith('];'):
            return pos
        pos += len(line) + 1
    raise SystemExit('没找到条目边界：%s' % anchor)


def main():
    src = open(PATH, encoding='utf-8').read()
    if 'xiaogan' in src:
        raise SystemExit('xiaogan 已经存在，别重复加')
    for header, anchor, block in BLOCKS:
        pos = entry_end(src, header, anchor)
        src = src[:pos] + block + src[pos:]
    open(PATH, 'w', encoding='utf-8', newline='\n').write(src)
    print('已插入 %d 处' % len(BLOCKS))


if __name__ == '__main__':
    main()
