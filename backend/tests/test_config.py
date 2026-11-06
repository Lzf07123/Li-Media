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


def test_weak_admin_token_is_rejected_at_startup() -> None:
    # 管理令牌是唯一凭证入口：示例值必须 fail-fast
    with pytest.raises(ValidationError):
        Settings(admin_token="change-me")


def test_admin_cookie_secure_is_auto_derived_from_public_base_url() -> None:
    # _env_file=None：隔离本机 .env，只测推导逻辑本身
    # 未显式配置：https 自动启用 Secure，本地 http 保持关闭
    assert Settings(_env_file=None).admin_cookie_secure_effective is False
    assert Settings(
        _env_file=None,
        public_base_url="https://media.example.com",
    ).admin_cookie_secure_effective is True
    # 显式配置永远优先
    assert Settings(
        _env_file=None,
        public_base_url="https://media.example.com",
        admin_cookie_secure=False,
    ).admin_cookie_secure_effective is False
    assert Settings(_env_file=None, admin_cookie_secure=True).admin_cookie_secure_effective is True


def test_credential_warnings_cover_weak_postgres_and_insecure_cookie() -> None:
    weak_db = Settings(
        _env_file=None, postgres_host="db", postgres_password="change-me"
    )
    assert any("POSTGRES_PASSWORD" in item for item in weak_db.credential_warnings())

    strong = Settings(
        _env_file=None,
        postgres_host="db",
        postgres_password="a-strong-random-password",
        admin_token="a-strong-random-token",
    )
    assert strong.credential_warnings() == []


def test_new_runtime_settings_reject_out_of_range_values() -> None:
    invalid_values = (
        {"task_thread_pool_size": 0},
        {"task_thread_pool_size": 129},
        {"database_pool_size": 0},
        {"database_pool_max_overflow": -1},
        {"database_pool_timeout_seconds": 0},
        {"admin_session_ttl_minutes": 0},
        {"admin_login_max_attempts": 0},
        {"thumbnail_max_size": 100},
        {"thumbnail_quality": 0},
        {"thumbnail_quality": 101},
        {"baidu_retry_attempts": 0},
    )
    for value in invalid_values:
        with pytest.raises(ValidationError):
            Settings(**value)
