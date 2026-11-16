#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""加一座城：东莞。只追加，不改已有条目（九张表里的八张，PRICE_IDX 走默认 1.0）。"""
import re
import sys

PATH = 'src/geo/cities.ts'

BLOCKS = [
    # (表头, 锚点条目, 插入文本)
    ('const SPOTS: Record<string, readonly string[]> = {', '  changde: [', """  /*
   * 东莞（2026-11-16，读者来信点的：「东莞东城，想让大肥鱼记住我家城市的样貌」）。
   *
   * 东莞是「直筒子市」—— 下面不设区县，东城是街道。所以东城不进坐标，
   * 落成景点括号注：黄旗山、榴花、同沙、虎英四处都在东城街道。
   * 没有民航机场，往这儿来得先落广州或深圳，再换城际/高铁。
   */
  dongguan: [
    '黄旗山城市公园（东城）：山只有 189 米，石阶半小时上到山顶，一座红灯笼造型的观景台压在顶上，能 360 度看满城的平顶厂房和玻璃写字楼',
    '可园：青砖围墙里围着一池水，曲廊贴着水面折过去，园北角立着四层的邀山阁，旧时是全城最高的地方',
    '榴花公园（东城）：明代万历年间的榴花塔立在铜岭上，八角七层砖塔，塔下是抗日纪念亭和一方刻满名字的碑',
    '莞城振华路骑楼老街：两层骑楼连成长廊，柱子漆成灰白，拱廊下挨着凉茶铺、云吞面和修表摊，二楼还住着人',
    '同沙湖城市公园（东城）：环湖绿道十七公里，柏油路面贴着水走，沿途荷塘、观景桥和大片草坡，本地人叫它小洱海',
    '虎英公园（东城）：与黄旗山连成一片，八点四公里环山步道串起雕塑园、罗马柱廊和云雨桥，湖面两百多亩',
    '南社明清古村落（茶山）：两百多间明清民居沿水塘排开，青砖墙配红砂岩门框，祠堂的灰塑脊饰还留着颜色',
    '松山湖：湖面被绿道绕一圈，岸边成排的荔枝树和莞香树，远处是白色厂房和玻璃研发楼',
    '下坝坊（万江）：东江边一条旧村改的街区，青砖老屋改成酒吧和咖啡馆，晚上灯笼一串串挂在巷子上',
  ],
"""),
    ('const NIGHTS: Record<string, NightSpot> = {', '  changde:', """  dongguan: '九点以后莞城新光明市场整层开市，烧鹅濑、牛杂、卜卜贝挤在一条通道里，塑料凳摆到楼梯口；万江下坝坊的灯笼也在这时候全亮',
"""),
    ('const FOODS: Record<string, readonly string[]> = {', '  changde:', """  dongguan: ['烧鹅濑粉', '道滘肉丸粥', '冼沙鱼丸', '塘厦碌鹅', '糖不甩', '道滘裹蒸粽', '白沙油鸭'],
"""),
    ('const LORE: Record<string, string> = {', '  changde:', """  dongguan: '南朝梁时置县，因地处广州之东、境内盛产莞草得名；莞草晒干能编席，明清时这一带的席子顺着东江卖到广州',
"""),
    ('export const FEATURES: Record<string, CityFeature> = {', '  zhengzhou2:', """  dongguan: { flower: '玉兰', landmark: '黄旗山', food: '烧鹅濑粉' },
"""),
    ('const FESTIVALS: Record<string, readonly Festival[]> = {', '  changde:', """  dongguan: [
    { name: '茶园游会（茶山东岳庙会）', months: [4, 5], what: '农历三月廿五到廿八，东岳大帝的神像从庙里抬出来，青壮年抬着跑过茶山各村坊，后面跟着舞龙舞狮和扮成故事的孩童，晚上搭棚唱粤剧，家家请亲戚来看' },
    { name: '东莞龙舟月', months: [5, 6], what: '农历五月各镇轮着「招景」，河涌里龙舟一条接一条划过去，两岸站满人；万江、中堂的龙舟饭摆在村口，糯米饭里拌着虾米腊肉' },
  ],
"""),
    ('const SHOWS: Record<string, readonly string[]> = {', '  changde:', """  dongguan: ['东莞玉兰大剧院：南城鸿福路，歌剧厅和试验剧场两个厅，话剧、舞剧和音乐会轮着演'],
"""),
    ('export const VISTA: Record<string, string> = {', '  changde:', """  dongguan: '东江贴着城北流，振华路的骑楼柱刷成灰白，榕树气根垂到地面，远处平顶厂房连成一片',
"""),
    ('const SPOT_LOOK: Record<string, Record<string, string>> = {', '  foshan:', """  dongguan: {
    '黄旗山城市公园（东城）': '山顶一座红灯笼造型的观景台，红色钢架鼓成灯笼状，石阶两侧是荔枝林和榕树，山下是连片的平顶厂房',
    '可园': '青砖围墙内一池水，曲廊贴着水面折行，四层邀山阁立在园北角，满洲窗和木雕花罩嵌在厅堂上',
    '榴花公园（东城）': '铜岭上一座八角七层砖塔，塔身青砖灰缝，塔下石阶、纪念亭和一方黑石碑',
  },
"""),
    ('export const CITIES: readonly City[] = [', "  C('shenzhen'", """  C('dongguan', '东莞', '广东', 23.0207, 113.7518, ['制造业', '骑楼', '水乡', '龙舟', '荔枝'],
    { air: false, port: true },),
"""),
]


def entry_end(src, table_header, anchor):
    """锚点条目在表内结束的位置（下一条目起点或表尾）。

    ⚠ `];` 不只是 `};`：`CITIES` 是数组，结尾是 `];`。第一版只认 `};`，
    于是一路穿到下一张表（`TOWN_ALIAS`），把城市条目插进了别名表 —— 而且不报错。
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
    if 'dongguan' in src:
        raise SystemExit('dongguan 已经存在，别重复加')
    for header, anchor, block in BLOCKS:
        pos = entry_end(src, header, anchor)
        src = src[:pos] + block + src[pos:]
    open(PATH, 'w', encoding='utf-8', newline='\n').write(src)
    print('已插入 %d 处' % len(BLOCKS))


if __name__ == '__main__':
    main()
