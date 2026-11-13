#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 data-research/*.json 里的城市数据并进 src/geo/cities.ts。

## 为什么要有这个脚本

2026-11-07 那天，用临时的 heredoc 改了三次 `cities.ts`，三次都写坏了：

1. 批量给 `F(...)` 补右括号时，把已有的**多行**调用也补了 —— 38 行语法坏掉；
2. 合并节日时用非贪婪正则 `\\[[\\s\\S]*?\\]`，把 `months: [3, 4]` 的 `]`
   当成了数组结尾 —— 25 条节日拼坏；
3. 修上面那个时，**按 `cid: [` 定位却没限定表**，把 54 座城的景点
   覆盖成了节日数据。靠 `npm pack coopani-world-journey@0.8.7` 从已发布的包里
   取回原文件才复原。

所以这个脚本的每一条规矩都是那三次的产物：

- **每张表先 `body_of(表头)` 把作用域框死**，任何查找、替换、插入都不许越界。
- **只追加，不改已有条目**。要改就单独写脚本，不混在合并里。
- **写完立刻回读验证**，不是「跑完没报错就当成了」。

## 用法

    python tools/merge_cities.py data-research/eu-central.json data-research/eu-west.json

幂等：id 已经存在的城市直接跳过，所以重复跑不会写两遍。
"""
import io
import json
import re
import sys

CITIES_TS = 'src/geo/cities.ts'

# 表头 → (是否字符串值, 是否数组值)
TABLES = {
    'const SPOTS: Record<string, readonly string[]> = {': 'array',
    'const NIGHTS: Record<string, string> = {': 'string',
    'const FOODS: Record<string, readonly string[]> = {': 'array',
    'const LORE: Record<string, string> = {': 'string',
    'const SHOWS: Record<string, readonly string[]> = {': 'array',
    'const FESTIVALS: Record<string, readonly Festival[]> = {': 'festivals',
    'export const VISTA: Record<string, string> = {': 'string',
    'const PRICE_IDX: Record<string, number> = {': 'number',
}


def q(x):
    """TS 单引号字符串。转义反斜杠和单引号 —— 中文名里有撇号的不多但会有。"""
    return "'" + str(x).replace('\\', '\\\\').replace("'", "\\'") + "'"


def body_of(src, head):
    """表体的 [开始, 结束) —— 结束指向结尾那个 `\\n};` 的位置。

    **所有操作都必须在这个区间里做**，这是这个脚本存在的主要理由。
    """
    i = src.index(head)
    if i < 0:
        raise SystemExit(f'找不到表头：{head}')
    j = src.index('\n};', i)
    return i, j


def insert_into_table(src, head, lines):
    """把若干行追加到某张表的末尾（`};` 之前）。"""
    if not lines:
        return src, 0
    _, hi = body_of(src, head)
    return src[:hi] + '\n' + '\n'.join(lines) + src[hi:], len(lines)


def festivals_literal(items, indent=2):
    """一个 Festival[] 的 TS 字面量。一条就单行，多条分列写。"""
    objs = []
    for f in items:
        months = ', '.join(str(int(m)) for m in (f.get('months') or []) if 1 <= int(m) <= 12)
        objs.append("{ name: %s, months: [%s], what: %s }"
                    % (q(f['name']), months, q(f.get('what') or '')))
    if len(objs) == 1:
        return "[%s]" % objs[0]
    pad = ' ' * (indent + 2)
    return "[\n%s%s,\n%s]" % (pad, (',\n' + pad).join(objs), ' ' * indent)


def f_call(c):
    """生成一条 `F(...)` 调用。"""
    hubs = []
    if c.get('air') is False:
        hubs.append('air: false')
    if c.get('rail') is False:
        hubs.append('rail: false')
    if c.get('port') is False:
        hubs.append('port: false')
    tags = ', '.join(q(t) for t in (c.get('tags') or []))
    head = "  F(%s, %s, %s, %s, %s, %s, [%s]" % (
        q(c['id']), q(c['name']), q(c['country']),
        c['lat'], c['lon'], q(c['tz']), tags,
    )
    if hubs:
        return head + ",\n    { %s },\n  )," % ', '.join(hubs)
    return head + "),"


def country_literal(src, countries):
    """把新国家代码并进 `City.country` 的联合类型。"""
    m = re.search(r"readonly country: ((?:'[A-Z]{2}' \| )*'[A-Z]{2}');", src)
    if not m:
        raise SystemExit('找不到 country 联合类型')
    have = re.findall(r"'([A-Z]{2})'", m.group(1))
    add = [c for c in countries if c not in have]
    if not add:
        return src, []
    merged = have + add
    lit = ' | '.join("%s" % q(c) for c in merged)
    return src[:m.start(1)] + lit + src[m.end(1):], add


def existing_ids(src):
    """已经出现在 CITIES 里的 id。"""
    return set(re.findall(r"\b[FC]\('([a-z0-9]+)'", src))


def main(paths):
    src = io.open(CITIES_TS, encoding='utf-8').read()
    have = existing_ids(src)

    cities = []
    for p in paths:
        d = json.load(io.open(p, encoding='utf-8'))
        for c in d['cities']:
            if c['id'] in have:
                print('  跳过（已存在）：', c['id'])
                continue
            have.add(c['id'])
            cities.append(c)
    if not cities:
        print('没有要合并的城市')
        return

    print('待合并', len(cities), '座')

    # ---- 国家类型 ----
    src, added = country_literal(src, sorted({c['country'] for c in cities}))
    print('  新增国家代码：', ' '.join(added) or '（无）')

    # ---- 七张表：只追加 ----
    plan = [
        ('const SPOTS: Record<string, readonly string[]> = {',
         ["  %s: [%s]," % (c['id'], ', '.join(q(x) for x in c['spots'])) for c in cities if c.get('spots')]),
        ('const NIGHTS: Record<string, string> = {',
         ["  %s: %s," % (c['id'], q(c['night'])) for c in cities if c.get('night')]),
        ('const FOODS: Record<string, readonly string[]> = {',
         ["  %s: [%s]," % (c['id'], ', '.join(q(x) for x in c['foods'])) for c in cities if c.get('foods')]),
        ('const LORE: Record<string, string> = {',
         ["  %s: %s," % (c['id'], q(c['lore'])) for c in cities if c.get('lore')]),
        ('const SHOWS: Record<string, readonly string[]> = {',
         ["  %s: [%s]," % (c['id'], ', '.join(q(x) for x in c['shows'])) for c in cities if c.get('shows')]),
        ('const FESTIVALS: Record<string, readonly Festival[]> = {',
         ["  %s: %s," % (c['id'], festivals_literal(c['festivals'])) for c in cities if c.get('festivals')]),
        ('export const VISTA: Record<string, string> = {',
         ["  %s: %s," % (c['id'], q(c['vista'])) for c in cities if c.get('vista')]),
        ('const PRICE_IDX: Record<string, number> = {',
         ["  %s: %s," % (c['id'], c['priceIdx']) for c in cities if c.get('priceIdx') is not None]),
    ]
    for head, lines in plan:
        src, n = insert_into_table(src, head, lines)
        print('  %-58s +%d' % (head.split('=')[0].strip(), n))

    # ---- CITIES 数组：插在结尾 `];` 之前 ----
    head = 'export const CITIES: readonly City[] = ['
    i = src.index(head)
    j = src.index('\n];', i)
    src = src[:j] + '\n' + '\n'.join(f_call(c) for c in cities) + src[j:]
    print('  CITIES 数组 +%d' % len(cities))

    io.open(CITIES_TS, 'w', encoding='utf-8', newline='').write(src)
    print('已写入', CITIES_TS)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit('用法：python tools/merge_cities.py <json> [...]')
    main(sys.argv[1:])
