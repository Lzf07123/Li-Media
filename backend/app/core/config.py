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
    public_base_url: str = "http://127.0.0.1:8080"
    admin_token: str = ""
    admin_session_cookie_name: str = "limedia_admin_session"
    admin_session_ttl_minutes: int = 120
    admin_login_max_attempts: int = 5
    admin_login_base_delay: float = 0.2
    admin_login_max_delay: float = 2.0
    admin_cookie_secure: bool = False
    media_root: str = "./data/media"
    nginx_cache_root: str = "./data/nginx_cache"
    thumbnail_max_size: int = 1280
    thumbnail_quality: int = 82
    media_derivative_version: str = "20260906-ratio-v1"
    video_frame_offset_seconds: float = 0.0
    remote_thumbnail_source_max_bytes: int = 16 * 1024 * 1024
    remote_thumbnail_video_source_max_bytes: int = 1024 * 1024 * 1024
    remote_thumbnail_disk_quota_bytes: int = 4 * 1024 * 1024 * 1024
    remote_thumbnail_max_temp_files: int = 2
    scan_concurrency_limit: int = 1
    scan_queue_limit: int = 1
    scan_wait_timeout_seconds: float = 0.0
    direct_probe_concurrency_limit: int = 4
    direct_probe_queue_limit: int = 16
    direct_probe_wait_timeout_seconds: float = 3.0
    derivative_concurrency_limit: int = 1
    derivative_queue_limit: int = 32
    derivative_wait_timeout_seconds: float = 15.0
    stream_global_concurrency_limit: int = 16
    stream_user_concurrency_limit: int = 1
    stream_queue_limit: int = 32
    stream_wait_timeout_seconds: float = 1.0
    task_thread_pool_size: int = 24
    backend_memory_limit_bytes: int = 256 * 1024 * 1024
    database_pool_size: int = 8
    database_pool_max_overflow: int = 8
    database_pool_timeout_seconds: int = 30
    baidu_api_base_url: str = "https://pan.baidu.com/rest/2.0/xpan"
    baidu_access_token: str = ""
    baidu_oauth_client_id: str = ""
    baidu_oauth_client_secret: str = ""
    baidu_oauth_redirect_uri: str = ""
    baidu_oauth_scope: str = "basic,netdisk"
    baidu_oauth_authorize_url: str = "https://openapi.baidu.com/oauth/2.0/authorize"
    baidu_oauth_token_url: str = "https://openapi.baidu.com/oauth/2.0/token"
    baidu_credentials_path: str = "./data/config/baidu_token.json"
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
    baidu_thumbnail_size: str = "c1600_u1600"


@lru_cache
def get_settings() -> Settings:
    return Settings()
