from functools import lru_cache

from urllib.parse import quote, urlsplit

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError


class Settings(BaseSettings):
    """Runtime settings loaded from the environment or `.env`."""

    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    project_name: str = "Li&Media"
    version: str = "0.1.0"
    database_url: str = ""
    postgres_host: str = ""
    postgres_port: int = 5432
    postgres_user: str = "media"
    postgres_password: str = "change-me"
    postgres_db: str = "media"
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
    remote_thumbnail_video_source_max_bytes: int = 64 * 1024 * 1024
    remote_thumbnail_disk_quota_bytes: int = 4 * 1024 * 1024 * 1024
    remote_thumbnail_max_temp_files: int = 2
    browser_probe_max_bytes: int = 2 * 1024 * 1024
    browser_probe_timeout_seconds: float = 12.0
    scan_concurrency_limit: int = 1
    scan_queue_limit: int = 1
    scan_wait_timeout_seconds: float = 0.0
    direct_probe_concurrency_limit: int = 4
    direct_probe_queue_limit: int = 16
    direct_probe_wait_timeout_seconds: float = 3.0
    derivative_concurrency_limit: int = 1
    derivative_queue_limit: int = 32
    derivative_wait_timeout_seconds: float = 15.0
    preheat_concurrency_limit: int = Field(default=2, ge=1, le=8)
    preheat_queue_limit: int = Field(default=64, ge=0, le=1000)
    preheat_wait_timeout_seconds: float = Field(default=2.0, ge=0, le=30)
    stream_global_concurrency_limit: int = 16
    stream_user_concurrency_limit: int = 3
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

    @model_validator(mode="after")
    def resolve_database_url(self) -> "Settings":
        explicit_url = self.database_url.strip()
        if explicit_url:
            self.database_url = explicit_url
            self.validate_database_url()
            return self

        host, embedded_port = self.resolve_postgres_host()
        if not host:
            self.database_url = "sqlite:///./data/app.db"
            return self

        port = embedded_port if embedded_port is not None else self.postgres_port
        credentials = quote(self.postgres_user, safe="")
        if self.postgres_password:
            credentials += f":{quote(self.postgres_password, safe='')}"

        self.database_url = (
            f"postgresql+psycopg://{credentials}"
            f"@{host}:{port}/{quote(self.postgres_db, safe='')}"
        )
        self.validate_database_url()
        return self

    def resolve_postgres_host(self) -> tuple[str, int | None]:
        """兼容误写的 host:port、IPv6 和连接 URL，同时保留显式端口。"""
        value = self.postgres_host.strip()
        if not value:
            return "", None

        if "://" in value:
            parsed = urlsplit(value)
            return parsed.hostname or "", parsed.port

        if value.startswith("["):
            host, closing, tail = value[1:].partition("]")
            if closing and tail.startswith(":") and tail[1:].isdigit():
                return host, int(tail[1:])
            if closing and not tail:
                return host, None
            raise ValueError("POSTGRES_HOST 的 IPv6 地址格式无效")

        if value.count(":") == 1:
            host, tail = value.split(":", 1)
            if host and tail.isdigit():
                return host, int(tail)

        return value, None

    def validate_database_url(self) -> None:
        try:
            make_url(self.database_url)
        except ArgumentError as error:
            raise ValueError(
                "由 POSTGRES_* 生成的数据库连接串无效；"
                "POSTGRES_HOST 只填主机名或 IP，端口使用 POSTGRES_PORT"
            ) from error


@lru_cache
def get_settings() -> Settings:
    return Settings()
