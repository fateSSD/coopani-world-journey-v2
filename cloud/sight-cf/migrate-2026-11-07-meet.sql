-- 老库升级（2026-11-07）：邀约加「见面城」和「世界流速」两列。
--
-- 新装不用跑这个 —— `schema.sql` 里已经包含这两列。
-- 跑法（二选一）：
--   npx wrangler d1 execute coop-sight --remote --file=./migrate-2026-11-07-meet.sql
--   或在 D1 控制台的 SQL 编辑器里贴一次
--
-- **顺序：先这张表，再部署 worker。**
-- 反过来的话 worker 会去查一列还不存在的字段，`/sight/invite` 和
-- `/sight/status` 会一路 500，直到表补上为止。
--
-- SQLite 没有 `ADD COLUMN IF NOT EXISTS`，重复执行会报
-- 「duplicate column name」—— 那是**已经跑过了**，不是失败，忽略即可。

ALTER TABLE invites ADD COLUMN meet_city TEXT NOT NULL DEFAULT '';
ALTER TABLE invites ADD COLUMN pace INTEGER NOT NULL DEFAULT 0;
