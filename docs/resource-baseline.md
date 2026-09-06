# Resource baseline

Recorded on 2026-09-07 with `scripts/resource_baseline.py` inside the backend image under `--memory 256m --memory-swap 256m --pids-limit 64`. The fixture is a real one-second, 320x180 H.264 video; no media file is committed or persisted after the run. Stack ceiling validation found that explicit `--ulimit stack` values from 8192 KiB through 32768 KiB caused Python 3.12 to segfault in this image, so Compose intentionally leaves the stack limit disabled. The task-thread pool, cgroup memory limit, and PID limit are the active guards; revisit stack tuning only with a different runtime or a validated startup sequence.

| Metric | Before | After | Result |
| --- | ---: | ---: | --- |
| 1280px single-frame duration | 70.05 ms | 35.60 ms | Faster one-frame extraction |
| Peak RSS | 58,784 KiB | 59,080 KiB | Stable |
| cgroup memory peak | 75,476,992 B | 80,941,056 B | 30.9% of the 256 MiB budget |
| FFmpeg child peak | 74,284 KiB | 64,096 KiB | Lower |
| OOM / OOM kill events | 0 | 0 | None |
| Temporary files remaining | 0 | 0 | None |

The after-run also executed six derivative jobs through the in-process two-slot derivative limiter. All six completed in 120.67 ms, queue depth returned to zero, and no temporary files remained. This is a small-library smoke benchmark, not a full production capacity result; production should continue using `/api/v1/admin/tasks/metrics` to compare live RSS/PSS, cgroup peak, thread, OOM, and temporary-directory counters against these margins.
