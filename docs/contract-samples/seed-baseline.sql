-- M0 契约基线种子数据:覆盖公开可见性(display_health)各状态组合。
-- 固定 UUID 与时间戳,保证新旧后端契约 diff 可复现。
TRUNCATE memory_derivative_caches, memory_files, memories, remote_scan_tasks CASCADE;

INSERT INTO memories (id, title, description, kind, status, captured_at, location, thumbnail_path, duration_seconds, width, height, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000001', '洱海日出', '清晨的第一缕光', 'photo', 'published', '2025-03-12T06:24:00+08:00', '云南·大理', NULL, NULL, 4032, 3024, '2025-03-12T08:00:00+08:00', '2025-03-15T09:30:00+08:00'),
  ('00000000-0000-4000-8000-000000000002', '巷口猫', '抓拍的瞬间', 'photo', 'published', '2025-04-02T15:10:00+08:00', '上海·弄堂', 'photos/2025/04/cat.jpg', NULL, 3024, 4032, '2025-04-02T15:20:00+08:00', '2025-04-02T18:00:00+08:00'),
  ('00000000-0000-4000-8000-000000000003', '海浪延时', '傍晚的浪', 'video', 'published', '2025-05-20T18:40:00+08:00', '福建·霞浦', NULL, 42, 1920, 1080, '2025-05-20T19:00:00+08:00', '2025-05-21T10:00:00+08:00'),
  ('00000000-0000-4000-8000-000000000004', '旧编码片段', '浏览器不支持的编码', 'video', 'published', '2025-01-08T12:00:00+08:00', NULL, NULL, 18, 1280, 720, '2025-01-08T12:10:00+08:00', '2025-01-08T12:10:00+08:00'),
  ('00000000-0000-4000-8000-000000000005', '未整理草稿', '', 'photo', 'draft', '2025-06-01T09:00:00+08:00', '浙江·杭州', NULL, NULL, 4032, 3024, '2025-06-01T09:05:00+08:00', '2025-06-01T09:05:00+08:00'),
  ('00000000-0000-4000-8000-000000000006', '待核验文件', 'remote_state 未验证', 'photo', 'published', '2025-07-10T11:00:00+08:00', '四川·稻城', NULL, NULL, 4032, 3024, '2025-07-10T11:10:00+08:00', '2025-07-10T11:10:00+08:00');

INSERT INTO memory_files (id, memory_id, source, remote_path, remote_id, source_path, mime_type, size_bytes, remote_md5, parent_path, filename, extension, modified_at, remote_state, thumbnail_state, thumbnail_failure_kind, stream_state, browser_compatibility, browser_compatibility_version, browser_format_summary, raw_metadata_summary, status, last_synced_at, created_at, updated_at) VALUES
  -- #1 主文件:photo ready + thumbnail ready → 公开
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'baidupan', '/photos/erhai/sunrise.jpg', '101', '', 'image/jpeg', 4821331, 'd41d8cd98f00b204e9800998ecf8427e', '/photos/erhai', 'sunrise.jpg', 'jpg', '2025-03-12T06:30:00+08:00', 'ready', 'ready', NULL, 'unavailable', 'unknown', 'v1', '{}', '{}', 'matched', '2025-03-12T07:00:00+08:00', '2025-03-12T07:00:00+08:00', '2025-03-12T07:00:00+08:00'),
  -- #1 副文件:md5 去重挂载,同样 ready(any-file 语义)
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'baidupan', '/backup/erhai/sunrise_copy.jpg', '102', '', 'image/jpeg', 4821331, 'd41d8cd98f00b204e9800998ecf8427e', '/backup/erhai', 'sunrise_copy.jpg', 'jpg', '2025-03-12T06:31:00+08:00', 'ready', 'ready', NULL, 'unavailable', 'unknown', 'v1', '{}', '{}', 'matched', '2025-03-12T07:01:00+08:00', '2025-03-12T07:01:00+08:00', '2025-03-12T07:01:00+08:00'),
  -- #2 photo ready + thumbnail failed + memory.thumbnail_path 兜底 → displayable
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'baidupan', '/photos/cat/alley_cat.jpg', '103', '', 'image/jpeg', 3145728, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '/photos/cat', 'alley_cat.jpg', 'jpg', '2025-04-02T15:11:00+08:00', 'ready', 'failed', 'source_truncated', 'unavailable', 'unknown', 'v1', '{}', '{}', 'matched', '2025-04-02T15:30:00+08:00', '2025-04-02T15:30:00+08:00', '2025-04-02T15:30:00+08:00'),
  -- #3 video ready + stream ready + browser supported → 公开
  ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000003', 'baidupan', '/videos/waves/delay.mp4', '104', '', 'video/mp4', 52428800, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '/videos/waves', 'delay.mp4', 'mp4', '2025-05-20T18:45:00+08:00', 'ready', 'ready', NULL, 'ready', 'supported', 'v1', '{"codec":"h264","container":"mp4"}', '{}', 'matched', '2025-05-20T19:00:00+08:00', '2025-05-20T19:00:00+08:00', '2025-05-20T19:00:00+08:00'),
  -- #4 video ready + stream ready + browser unsupported → displayable 但 public excluded
  ('10000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000004', 'baidupan', '/videos/legacy/old_clip.mov', '105', '', 'video/quicktime', 18874368, 'cccccccccccccccccccccccccccccccc', '/videos/legacy', 'old_clip.mov', 'mov', '2025-01-08T12:01:00+08:00', 'ready', 'ready', NULL, 'ready', 'unsupported', 'v1', '{"codec":"prores","container":"mov"}', '{}', 'matched', '2025-01-08T12:05:00+08:00', '2025-01-08T12:05:00+08:00', '2025-01-08T12:05:00+08:00'),
  -- #5 draft 的 ready 文件 → 后台可见,公开不可见
  ('10000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000005', 'baidupan', '/photos/hz/draft.jpg', '106', '', 'image/jpeg', 2097152, 'dddddddddddddddddddddddddddddddd', '/photos/hz', 'draft.jpg', 'jpg', '2025-06-01T09:01:00+08:00', 'ready', 'ready', NULL, 'unavailable', 'unknown', 'v1', '{}', '{}', 'matched', '2025-06-01T09:05:00+08:00', '2025-06-01T09:05:00+08:00', '2025-06-01T09:05:00+08:00'),
  -- #6 remote_state unverified → excluded
  ('10000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000006', 'baidupan', '/photos/dc/unchecked.jpg', '107', '', 'image/jpeg', 1048576, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '/photos/dc', 'unchecked.jpg', 'jpg', '2025-07-10T11:01:00+08:00', 'unverified', 'missing', NULL, 'unavailable', 'unknown', 'v1', '{}', '{}', 'pending', NULL, '2025-07-10T11:10:00+08:00', '2025-07-10T11:10:00+08:00'),
  -- 孤儿文件:memory_id NULL(ON DELETE SET NULL 场景)
  ('10000000-0000-4000-8000-000000000008', NULL, 'baidupan', '/orphans/lost.jpg', '108', '', 'image/jpeg', 524288, 'ffffffffffffffffffffffffffffffff', '/orphans', 'lost.jpg', 'jpg', '2025-02-01T08:00:00+08:00', 'ready', 'ready', NULL, 'unavailable', 'unknown', 'v1', '{}', '{}', 'missing', '2025-02-01T08:10:00+08:00', '2025-02-01T08:10:00+08:00', '2025-02-01T08:10:00+08:00');

-- 派生缓存:首页 240px 口径(media_derivative_version=20260906-ratio-v1)决定公开列表可见性
INSERT INTO memory_derivative_caches (id, memory_file_id, max_size, derivative_version, status, failure_kind, output_path, output_bytes, source_bytes, duration_ms, created_at, updated_at) VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 240, '20260906-ratio-v1', 'ready', NULL, 'media/derivatives/240/sunrise.jpg', 24576, 4821331, 356, '2025-03-12T08:00:00+08:00', '2025-03-12T08:00:00+08:00'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 240, '20260906-ratio-v1', 'ready', NULL, 'media/derivatives/240/sunrise_copy.jpg', 24576, 4821331, 361, '2025-03-12T08:00:00+08:00', '2025-03-12T08:00:00+08:00'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 240, '20260906-ratio-v1', 'ready', NULL, 'media/derivatives/240/alley_cat.jpg', 18432, 3145728, 312, '2025-04-02T16:00:00+08:00', '2025-04-02T16:00:00+08:00'),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000003', 480, '20260906-ratio-v1', 'ready', NULL, 'media/derivatives/480/alley_cat.jpg', 49152, 3145728, 528, '2025-04-02T16:00:00+08:00', '2025-04-02T16:00:00+08:00'),
  ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000004', 240, '20260906-ratio-v1', 'ready', NULL, 'media/derivatives/240/delay.jpg', 21504, 52428800, 892, '2025-05-20T19:00:00+08:00', '2025-05-20T19:00:00+08:00'),
  ('20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000005', 240, '20260906-ratio-v1', 'ready', NULL, 'media/derivatives/240/old_clip.jpg', 19456, 18874368, 640, '2025-01-08T12:05:00+08:00', '2025-01-08T12:05:00+08:00');

INSERT INTO remote_scan_tasks (id, remote_dir, status, cursor, max_depth, max_items, delete_missing, processed_items, scanned_files, scanned_directories, discovered, refreshed, skipped, failure_reason, started_at, completed_at, created_at, updated_at) VALUES
  ('30000000-0000-4000-8000-000000000001', '/photos', 'completed', NULL, 8, 5000, true, 8, 6, 3, 8, 0, 0, NULL, '2025-07-11T10:00:00+08:00', '2025-07-11T10:03:00+08:00', '2025-07-11T10:00:00+08:00', '2025-07-11T10:03:00+08:00');
