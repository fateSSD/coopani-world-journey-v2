/**
 * 相册里拿掉一张（2026-11-11，用户 TwoTwo 来信）。
 *
 * 原话：「大肥鱼环游世界通过 ai 生成的照片有些不太满意，能否加一个那张重新生成
 * 或者删除选项，如果已经有相关功能可能是我没有找到，请忽略」。
 *
 * 他猜对了一半：**重拍已经有了**（相册上的补拍按钮，`replaceDay` 那条路），
 * 缺的是删除。而删除比「从数组里滤掉一条」多三件必须想清楚的事：
 *
 * 1. **媒体文件删不删。** 不删 —— 内容寻址，别的会话可能引用同一张；
 *    已经生成的月报 HTML 里嵌的就是它，删了字节那边就裂。
 * 2. **同一天拍的第二张会不会被顺手带走。** 不会：按 handle 精确匹配。
 * 3. **删完面板拿到的是什么。** 整份新列表，前端不用自己猜哪条没了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { PhotoBook } = await import('../src/photo-book.ts');

const rec = (handle, dateKey = '2026-11-10') => ({
  handle, cityId: 'chengdu', cityName: '成都', dateKey, title: '翠湖的街', spot: '翠湖',
  at: `${dateKey}T12:00:00.000Z`,
});

test('拿掉一张：只摘记录，别的都还在', () => {
  const book = new PhotoBook(mkdtempSync(join(tmpdir(), 'jr-photo-')));
  book.add(rec('log:a.png'));
  book.add(rec('log:b.png'));
  assert.equal(book.list().length, 2);

  assert.equal(book.remove('log:a.png'), true);
  assert.deepEqual(book.list().map((p) => p.handle), ['log:b.png']);
});

test('拿掉不存在的 handle：返回 false，不误删别人', () => {
  const book = new PhotoBook(mkdtempSync(join(tmpdir(), 'jr-photo2-')));
  book.add(rec('log:a.png'));
  assert.equal(book.remove('log:zzz.png'), false);
  assert.equal(book.list().length, 1);
});

test('同一天的第二张不受影响', () => {
  const book = new PhotoBook(mkdtempSync(join(tmpdir(), 'jr-photo3-')));
  book.add(rec('log:new.png'));
  book.add(rec('log:old.png'));
  book.remove('log:new.png');
  assert.deepEqual(book.list().map((p) => p.handle), ['log:old.png']);
});

test('删完写盘，重新打开还在（不是只改了内存）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-photo4-'));
  const book = new PhotoBook(dir);
  book.add(rec('log:a.png'));
  book.add(rec('log:b.png'));
  book.remove('log:a.png');

  const again = new PhotoBook(dir);
  assert.deepEqual(again.list().map((p) => p.handle), ['log:b.png']);
});
