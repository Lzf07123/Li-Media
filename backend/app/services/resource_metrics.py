"""Read lightweight Linux process and cgroup resource counters."""

from __future__ import annotations

import shutil
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


def collect_resource_metrics(media_root: Path) -> dict[str, object]:
    process = _read_proc_status()
    temporary_dir = media_root / "tmp"
    temp_paths = list(temporary_dir.rglob("*")) if temporary_dir.exists() else []
    temp_files = [path for path in temp_paths if path.is_file()]
    temp_bytes = sum(
        path.stat().st_size for path in temp_files if path.is_file()
    )
    disk_free_bytes: int | None = None
    try:
        disk_free_bytes = shutil.disk_usage(temporary_dir).free
    except OSError:
        disk_free_bytes = None

    return {
        "process": {
            **process,
            "pss_kbytes": _read_pss_kbytes(),
        },
        "cgroup": {
            "memory_current_bytes": _read_int("/sys/fs/cgroup/memory.current"),
            "memory_peak_bytes": _read_int("/sys/fs/cgroup/memory.peak"),
            "pids_current": _read_int("/sys/fs/cgroup/pids.current"),
            **_read_memory_events(),
        },
        "temporary": {
            "files": len(temp_files),
            "bytes": temp_bytes,
            "disk_free_bytes": disk_free_bytes,
        },
    }
