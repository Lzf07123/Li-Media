-- disk_quota 表示临时目录容量不足,不代表文件本身不可用。旧版本把候选
-- 写成 retryable + disk_quota 后,预热冷却期会把它们全部排除在后续任务
-- 之外;这里把这类环境性失败恢复为未预热状态。
UPDATE public.memory_files
SET thumbnail_state = 'missing',
    thumbnail_failure_kind = NULL,
    updated_at = now()
WHERE thumbnail_failure_kind = 'disk_quota';
