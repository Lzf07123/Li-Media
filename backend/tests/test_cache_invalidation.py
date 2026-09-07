from pathlib import Path

from app.services.cache_invalidation import invalidate_nginx_proxy_cache


def test_nginx_proxy_cache_is_cleared_and_counted(tmp_path: Path) -> None:
    cache_root = tmp_path / "nginx_cache"
    nested = cache_root / "1" / "2"
    nested.mkdir(parents=True)
    (nested / "entry").write_bytes(b"cached")
    (cache_root / "top").write_bytes(b"cached")

    removed = invalidate_nginx_proxy_cache(cache_root)

    assert removed == 2
    assert cache_root.is_dir()
    assert not any(cache_root.rglob("*"))
