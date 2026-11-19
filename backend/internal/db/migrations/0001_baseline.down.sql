-- 0001_baseline 回滚:删除全部业务表与扩展(alembic_version 不在管辖内)。

DROP TABLE IF EXISTS public.memory_derivative_caches CASCADE;
DROP TABLE IF EXISTS public.memory_files CASCADE;
DROP TABLE IF EXISTS public.memories CASCADE;
DROP TABLE IF EXISTS public.remote_scan_tasks CASCADE;
DROP TABLE IF EXISTS public.admin_sessions CASCADE;
DROP TABLE IF EXISTS public.admin_operation_logs CASCADE;
DROP TABLE IF EXISTS public.admin_background_jobs CASCADE;
DROP EXTENSION IF EXISTS pg_trgm;
