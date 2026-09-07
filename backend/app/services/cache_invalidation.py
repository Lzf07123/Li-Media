"""Synchronized cache invalidation for public list responses."""

from __future__ import annotations

import shutil
from pathlib import Path

from app.core.config import get_settings


def invalidate_nginx_proxy_cache(root: Path | None = None) -> int:
    """Remove Nginx proxy-cache files after visibility-changing admin operations."""

    cache_root = Path(root or get_settings().nginx_cache_root)
    if not cache_root.exists():
        return 0

    removed_files = sum(1 for path in cache_root.rglob("*") if path.is_file())
    for path in cache_root.iterdir():
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)
    cache_root.mkdir(parents=True, exist_ok=True)
    return removed_files
