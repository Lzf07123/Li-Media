import pytest
from app.core.config import Settings
from sqlalchemy.engine import make_url
from pydantic import ValidationError


def test_database_url_prefers_explicit_setting() -> None:
    url = "postgresql+psycopg://media:secret@127.0.0.1:5432/media"

    assert Settings(database_url=url).database_url == url


def test_database_url_is_generated_from_postgres_settings() -> None:
    settings = Settings(
        database_url="",
        postgres_host="db",
        postgres_port=5432,
        postgres_user="media user",
        postgres_password="p@ss word/:'",
        postgres_db="media db",
    )

    assert settings.database_url == (
        "postgresql+psycopg://media%20user:p%40ss%20word%2F%3A%27@db:5432/media%20db"
    )
    assert make_url(settings.database_url).host == "db"


def test_database_url_allows_port_in_postgres_host() -> None:
    settings = Settings(database_url="", postgres_host="db:5433")

    assert settings.postgres_host == "db:5433"
    assert make_url(settings.database_url).port == 5433


def test_database_url_defaults_to_sqlite_without_postgres_host() -> None:
    settings = Settings(database_url="", postgres_host="")

    assert settings.database_url == "sqlite:///./data/app.db"


def test_runtime_resource_limits_accept_safe_boundaries_and_reject_invalid_values() -> None:
    settings = Settings(
        preheat_concurrency_limit=1,
        preheat_queue_limit=0,
        preheat_wait_timeout_seconds=0,
        scan_concurrency_limit=4,
        scan_queue_limit=0,
        scan_wait_timeout_seconds=0,
        direct_probe_concurrency_limit=16,
        direct_probe_queue_limit=1000,
        direct_probe_wait_timeout_seconds=30,
        derivative_concurrency_limit=4,
        derivative_queue_limit=0,
        derivative_wait_timeout_seconds=60,
        stream_global_concurrency_limit=64,
        stream_user_concurrency_limit=16,
        stream_queue_limit=0,
        stream_wait_timeout_seconds=0,
        remote_thumbnail_max_temp_files=0,
        remote_thumbnail_disk_quota_bytes=0,
    )
    assert settings.preheat_concurrency_limit == 1
    assert settings.scan_concurrency_limit == 4
    assert settings.remote_thumbnail_max_temp_files == 0
    assert settings.remote_thumbnail_disk_quota_bytes == 0

    invalid_values = (
        {"preheat_concurrency_limit": 0},
        {"preheat_concurrency_limit": 9},
        {"scan_concurrency_limit": 0},
        {"direct_probe_concurrency_limit": 17},
        {"derivative_concurrency_limit": 0},
        {"stream_global_concurrency_limit": 0},
        {"stream_user_concurrency_limit": 0},
        {"remote_thumbnail_max_temp_files": -1},
        {"remote_thumbnail_disk_quota_bytes": -1},
    )
    for value in invalid_values:
        with pytest.raises(ValidationError):
            Settings(**value)
