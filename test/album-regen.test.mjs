/**
 * 重新生成一张照片（2026-11-11，用户 TwoTwo 来信的后半句）。
 *
 * 原话：「AI 生成的照片有些不满意，能否加一个重新生成或者删除」。
 *
 * 重拍这件事本身不新（相册上一直有「补一张」），新的是**按这一张自己的条件重拍**：
 * 同一天、同一座城、同一段提示词，只是提示词可以被他改过。
 *
 * 所以这里锁的是四件事：
 *
 * 1. **原位替换** —— 重拍是同一张照片，不该因为重来一次就跳到相册最前面。
 * 2. **不误伤同城同日的别的记录** —— 补拍那条路会清掉当天旧的，重拍不该。
 * 3. **提示词要留下来** —— 它就是"不满意也没法改"的根：原来只在内存里活一次。
 * 4. **老记录没有提示词** —— 得能读、不能崩，前端据此把按钮置灰。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { PhotoBook } = await import('../src/photo-book.ts');

const rec = (handle, extra = {}) => ({
  handle,
  cityId: 'chengdu',
  cityName: '成都',
  dateKey: '2026-11-10',
  title: '翠湖的街',
  spot: '翠湖',
  at: '2026-11-10T12:00:00.000Z',
  ...extra,
});

test('重拍：原位替换，不跳到相册最前面', () => {
  const book = new PhotoBook(mkdtempSync(join(tmpdir(), 'jr-regen-')));
  book.add(rec('log:new.png'));      // 头插：先加的排在后面
  book.add(rec('log:old.png'));      // 后加的顶到最前面，这是要重拍的那张
  const before = book.list().map((p) => p.handle);
  assert.deepEqual(before, ['log:old.png', 'log:new.png']);

  assert.equal(book.update('log:old.png', rec('log:redo.png')), true);
  const after = book.list().map((p) => p.handle);
  assert.deepEqual(after, ['log:redo.png', 'log:new.png'], '重拍的那张留在原位，不该再顶一次');
});

test('重拍：同城同日的另一张不被顺手清掉', () => {
  const book = new PhotoBook(mkdtempSync(join(tmpdir(), 'jr-regen2-')));
  // 同一天同一座城的两条（补拍过一次留下的），重拍其中一张，另一张必须还在
  book.add(rec('log:second.png'));
  book.add(rec('log:first.png'));
  book.update('log:first.png', rec('log:first-new.png'));
  assert.deepEqual(book.list().map((p) => p.handle), ['log:first-new.png', 'log:second.png']);
});

test('重拍：handle 已经被 × 摘掉了，update 返回 false，不硬塞一条新的', () => {
  const book = new PhotoBook(mkdtempSync(join(tmpdir(), 'jr-regen3-')));
  book.add(rec('log:a.png'));
  assert.equal(book.update('log:gone.png', rec('log:b.png')), false);
  assert.deepEqual(book.list().map((p) => p.handle), ['log:a.png'], '找不到旧的就该交给调用方决定，不能偷偷 add');
});

test('提示词跟着记录落盘，重开还在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-regen4-'));
  const book = new PhotoBook(dir);
  book.add(rec('log:a.png', { prompt: '雨后的翠湖，胶片质感，没有人。' }));

  const again = new PhotoBook(dir);
  assert.equal(again.list()[0].prompt, '雨后的翠湖，胶片质感，没有人。', '重开面板要还能看见当时那段提示词');
});

test('老记录没有提示词：读得出来、不崩', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-regen5-'));
  new PhotoBook(dir).add(rec('log:old.png')); // 没有 prompt 这一格
  const again = new PhotoBook(dir);
  assert.equal(again.list().length, 1);
  assert.equal(again.list()[0].prompt, undefined, '缺这一格是正常的，别当损坏');
});
