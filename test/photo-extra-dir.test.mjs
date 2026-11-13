/**
 * 「照片额外存一份到」不该被「没设日记目录」挡住（2026-11-12，用户实报）
 *
 * ## 来信
 *
 * 【环游世界 1.6.14】设置里「照片额外存一份到（可留空）」这栏不生效
 *
 * - 拍照后主位置 `data/home/companion/data/media` 正常增加（340 → 389）
 * - 填的那栏目录一个文件都不多，还停在 11-10 的旧文件（9 个）
 * - 不是没重启（重启过两次）、不是中文路径（换纯英文也一样）
 * - `config.json` 里 photoDir 确实是新值，重启后读出来也是新值
 * - **是拷贝那一步没跑**
 *
 * ## 根因
 *
 * `archiveToJournal` 第一行：
 *
 * ```ts
 * if (!String(this.cfg.memoryDir ?? '').trim()) return;
 * ```
 *
 * 而额外副本那段写在函数**最底部**。没设日记目录的人一进门就被请走，
 * 下面永远跑不到。照片照进宿主媒体库（另一条路），所以他看到"主位置在涨"。
 *
 * 用户指对了位置（拷贝没跑），只是没看到门口那道早退。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JourneyWorld } from '../src/world.ts';
import { JOURNEY_DEFAULTS } from '../src/config.ts';

function mkWorld(cfgPatch) {
  const dir = mkdtempSync(join(tmpdir(), 'jr-extra-'));
  const cfg = { ...JOURNEY_DEFAULTS(), enabled: true, homeCity: '兰州', ...cfgPatch };
  const w = new JourneyWorld({ cfg, dataDir: dir, botName: '大肥鱼' });
  return { w, dir, cfg };
}

test('没设日记目录，额外副本照样要写', () => {
  const extraDir = mkdtempSync(join(tmpdir(), 'jr-photodir-'));
  const { w, dir } = mkWorld({ memoryDir: '', photoDir: extraDir });
  const body = Buffer.from('fake-image-bytes');

  w.archiveToJournal('media', 'abc123.png', body);

  const dst = join(extraDir, 'abc123.png');
  assert.ok(
    existsSync(dst),
    '额外目录里没有文件 —— photoDir 又被 memoryDir 的空值挡住了',
  );
  assert.equal(readFileSync(dst).toString(), body.toString());
  rmSync(dir, { recursive: true, force: true });
  rmSync(extraDir, { recursive: true, force: true });
});

test('photoDir 留空时不该往任何地方多写一份', () => {
  const { w, dir } = mkWorld({ memoryDir: '', photoDir: '' });
  /* 不抛错就是通过 —— 没有 photoDir 时这段应该是空操作。 */
  w.archiveToJournal('media', 'zzz.png', Buffer.from('x'));
  rmSync(dir, { recursive: true, force: true });
});

test('报告不进照片目录 —— 只复制 media', () => {
  const extraDir = mkdtempSync(join(tmpdir(), 'jr-photodir-'));
  const { w, dir } = mkWorld({ memoryDir: '', photoDir: extraDir });
  w.archiveToJournal('reports', '2026-11.md', '# 月报');
  assert.ok(
    !existsSync(join(extraDir, '2026-11.md')),
    '报告被塞进了照片目录 —— 那栏叫「照片额外存一份到」',
  );
  rmSync(dir, { recursive: true, force: true });
  rmSync(extraDir, { recursive: true, force: true });
});
