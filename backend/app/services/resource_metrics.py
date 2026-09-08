"""Read lightweight Linux process and cgroup resource counters."""

from __future__ import annotations

import shutil
import resource
import os
from time import monotonic
from pathlib import Path


def _read_int(path: str) -> int | None:
    try:
        return int(Path(path).read_text().strip())
    except (OSError, ValueError):
        return None


def _read_proc_status() -> dict[str, int | None]:
    try:
        text = Path("/proc/self/status").read_text()
    except OSError:
        return {"rss_kbytes": None, "threads": None}

    values: dict[str, int | None] = {"rss_kbytes": None, "threads": None}
    for line in text.splitlines():
        if line.startswith("VmRSS:"):
            values["rss_kbytes"] = int(line.split()[1])
        elif line.startswith("Threads:"):
            values["threads"] = int(line.split()[1])
    return values


def _read_pss_kbytes() -> int | None:
    try:
        text = Path("/proc/self/smaps_rollup").read_text()
    except OSError:
        return None

    for line in text.splitlines():
        if line.startswith("Pss:"):
            return int(line.split()[1])
    return None


def _read_memory_events() -> dict[str, int]:
    try:
        lines = Path("/sys/fs/cgroup/memory.events").read_text().splitlines()
    except OSError:
        return {"oom": 0, "oom_kill": 0}

    events = {"oom": 0, "oom_kill": 0}
    for line in lines:
        key, value = line.split()
        if key in events:
            events[key] = int(value)
    return events


def _read_stack_limits() -> dict[str, int | None]:
    soft, hard = resource.getrlimit(resource.RLIMIT_STACK)
    return {
        "soft_kbytes": soft if soft != resource.RLIM_INFINITY else None,
        "hard_kbytes": hard if hard != resource.RLIM_INFINITY else None,
    }


def _read_disk(temporary_dir: Path) -> dict[str, int | None]:
    try:
        # A clean deployment may not yet have media/tmp; still report the
        # filesystem visible to the container rather than misleading nulls.
        resolved_directory = temporary_dir.resolve()
        directory = (
            temporary_dir
            if temporary_dir.exists()
            else resolved_directory.parent
            if resolved_directory.parent.exists()
            else resolved_directory.anchor
        )
        usage = shutil.disk_usage(directory)
    except OSError:
        return {
            "free_bytes": None,
            "total_bytes": None,
            "used_bytes": None,
            "usage_ratio": None,
        }

    return {
        "free_bytes": usage.free,
        "total_bytes": usage.total,
        "used_bytes": usage.used,
        "usage_ratio": round(usage.used / usage.total, 4) if usage.total else None,
    }


def _read_directory_usage(
    directory: Path,
    *,
    max_files: int = 50_000,
    timeout_seconds: float = 2.0,
) -> dict[str, int | str]:
    """Count local cache files without exposing names or absolute paths."""

    started_at = monotonic()
    if not directory.exists():
        return {"files": 0, "bytes": 0, "status": "ok"}
    if not directory.is_dir():
        return {"files": 0, "bytes": 0, "status": "unavailable"}

    files = 0
    bytes_seen = 0
    stack: list[Path] = [directory]
    while stack:
        if files >= max_files:
            return {"files": 0, "bytes": 0, "status": "truncated"}
        if monotonic() - started_at > timeout_seconds:
            return {"files": 0, "bytes": 0, "status": "timeout"}

        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            return {"files": 0, "bytes": 0, "status": "unavailable"}

        for entry in entries:
            try:
                if entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    stack.append(Path(entry.path))
                    continue
                if not entry.is_file(follow_symlinks=False):
                    continue
                if files >= max_files:
                    return {"files": 0, "bytes": 0, "status": "truncated"}
                files += 1
                bytes_seen += entry.stat(follow_symlinks=False).st_size
                if monotonic() - started_at > timeout_seconds:
                    return {"files": 0, "bytes": 0, "status": "timeout"}
            except OSError:
                return {"files": 0, "bytes": 0, "status": "unavailable"}

    return {"files": files, "bytes": bytes_seen, "status": "ok"}


def collect_resource_metrics(
    media_root: Path,
    *,
    backend_memory_limit_bytes: int | None = None,
    temp_disk_quota_bytes: int | None = None,
    temp_max_files: int | None = None,
    nginx_cache_root: Path | None = None,
) -> dict[str, object]:
    process = _read_proc_status()
    temporary_dir = media_root / "tmp"
    temp_paths = list(temporary_dir.rglob("*")) if temporary_dir.exists() else []
    temp_files = [path for path in temp_paths if path.is_file()]
    temp_bytes = sum(
        path.stat().st_size for path in temp_files if path.is_file()
    )
    filesystem = _read_disk(media_root if media_root.exists() else temporary_dir)
    derived_cache = _read_directory_usage(media_root / "thumbnails")
    temporary_cache = _read_directory_usage(temporary_dir)
    nginx_cache = _read_directory_usage(nginx_cache_root or media_root / "nginx_cache")

    return {
        "process": {
            **process,
            "pss_kbytes": _read_pss_kbytes(),
        },
        "cgroup": {
            "memory_current_bytes": _read_int("/sys/fs/cgroup/memory.current"),
            "memory_peak_bytes": _read_int("/sys/fs/cgroup/memory.peak"),
            "memory_max_bytes": _read_int("/sys/fs/cgroup/memory.max"),
            "pids_current": _read_int("/sys/fs/cgroup/pids.current"),
            "pids_max": _read_int("/sys/fs/cgroup/pids.max"),
            **_read_memory_events(),
        },
        "temporary": {
            "files": len(temp_files),
            "bytes": temp_bytes,
            **_read_disk(temporary_dir),
        },
        "filesystem": filesystem,
        "caches": {
            "derived_thumbnails": derived_cache,
            "temporary": temporary_cache,
            "nginx": nginx_cache,
        },
        "stack": _read_stack_limits(),
        "limits": {
            "backend_memory_bytes": backend_memory_limit_bytes,
            "temp_disk_quota_bytes": temp_disk_quota_bytes,
            "temp_max_files": temp_max_files,
        },
    }
