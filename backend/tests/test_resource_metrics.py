from pathlib import Path

from app.services.resource_metrics import collect_resource_metrics


def test_resource_metrics_report_filesystem_and_local_cache_usage(tmp_path: Path) -> None:
    derived = tmp_path / "thumbnails"
    temporary = tmp_path / "tmp"
    nginx_cache = tmp_path / "nginx-cache"
    derived.mkdir()
    temporary.mkdir()
    nginx_cache.mkdir()
    (derived / "240.webp").write_bytes(b"a" * 24)
    (derived / "480.webp").write_bytes(b"b" * 32)
    (temporary / "active.part").write_bytes(b"c" * 8)

    metrics = collect_resource_metrics(
        tmp_path,
        nginx_cache_root=nginx_cache,
    )

    assert metrics["filesystem"]["total_bytes"] > 0
    assert metrics["filesystem"]["used_bytes"] > 0
    assert metrics["filesystem"]["free_bytes"] > 0
    assert metrics["caches"]["derived_thumbnails"] == {
        "files": 2,
        "bytes": 56,
        "status": "ok",
    }
    assert metrics["caches"]["temporary"] == {
        "files": 1,
        "bytes": 8,
        "status": "ok",
    }
    assert metrics["caches"]["nginx"] == {"files": 0, "bytes": 0, "status": "ok"}


def test_unreadable_cache_path_is_marked_unavailable(tmp_path: Path) -> None:
    invalid_cache = tmp_path / "nginx-cache"
    invalid_cache.write_text("not a directory")

    metrics = collect_resource_metrics(
        tmp_path,
        nginx_cache_root=invalid_cache,
    )

    assert metrics["caches"]["nginx"] == {
        "files": 0,
        "bytes": 0,
        "status": "unavailable",
    }
