from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings loaded from the environment or `.env`."""

    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    project_name: str = "Li&Media"
    version: str = "0.1.0"
    database_url: str = "sqlite:///./data/app.db"
    redis_url: str = "redis://localhost:6379/0"
    cors_origins: str = "http://localhost:5173,http://localhost:8080"
    admin_token: str = ""
    admin_session_cookie_name: str = "limedia_admin_session"
    admin_session_ttl_minutes: int = 120
    admin_login_max_attempts: int = 5
    admin_login_base_delay: float = 0.2
    admin_login_max_delay: float = 2.0
    admin_cookie_secure: bool = False
    media_root: str = "./data/media"
    thumbnail_max_size: int = 1280
    thumbnail_quality: int = 82
    baidu_api_base_url: str = "https://pan.baidu.com/rest/2.0/xpan"
    baidu_access_token: str = ""
    baidu_sync_dir: str = "/apps/Li&Media"
    baidu_sync_page_size: int = 1000
    baidu_sync_max_bytes: int = 2 * 1024 * 1024 * 1024
    baidu_scan_max_depth: int = 8
    baidu_scan_max_items: int = 5000
    baidu_request_interval_seconds: float = 0.2
    baidu_retry_attempts: int = 3
    baidu_retry_base_delay: float = 0.5
    baidu_retry_max_delay: float = 8.0
    baidu_download_url_ttl_seconds: int = 300


@lru_cache
def get_settings() -> Settings:
    return Settings()
