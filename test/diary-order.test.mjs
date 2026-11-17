/**
 * 日记列表必须**新的在前**（2026-11-17，Mr.Q 第三次提）。
 *
 * ## 现场
 *
 * 他截了图：左栏从 `2026-10-31 天水` 排到 `2026-11-13 西安` —— 想看今天的日记得滚到底，
 * 而他每天都要看今天。
 *
 * 前两次我核的是**模拟鱼生**那边的日记面板（那边确实有 `.reverse()`，本来就对），
 * 没注意他说的这一页是**旅行日记**。这一页漏了那一步。
 *
 * ## 为什么用读源码的方式断言
 *
 * 要真正跑一遍得构造 World 实例 + 写几天的日记文件，成本远高于这条的价值。
 * 这里要守的又恰好是**那一行有没有 `.reverse()`**，读原文最直接。
 *
 * 顺带守一句：`recent()` 本身是升序的（`sort()` 取末尾 n 个），别指望它自己反。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const webui = readFileSync(new URL('../src/world-webui.ts', import.meta.url), 'utf8');
const diary = readFileSync(new URL('../src/diary.ts', import.meta.url), 'utf8');

test('日记列表要反转，新的在前', () => {
  /*
   * 只认 `.recent(n).reverse()` 这个形状；写成两行拆开也认（先赋给变量再 reverse）。
   */
  const direct = /recent\(\s*\d+\s*\)\s*\.reverse\s*\(\s*\)/.test(webui);
  const viaVar = /const\s+\w+\s*=\s*this\.diary\.recent\([^)]*\)[\s\S]{0,80}?\.reverse\s*\(\s*\)/.test(webui);
  assert.ok(direct || viaVar, '日记面板没把 recent() 的结果反转 —— 列表会从最早的排到最新的');
});

test('recent() 自己返回升序，别指望它', () => {
  /*
   * 这条是给上面那条做注脚的：`sort()` 升序、`slice(-n)` 取末尾，结果还是升序。
   * 如果哪天真把 recent 改成降序了，上面那条断言就该重新审视（多反转一次会翻回去）。
   */
  assert.match(diary, /recent\(n: number\)[\s\S]{0,200}?\.sort\(\)\s*\.slice\(-/, 'recent() 的实现变了');
});
