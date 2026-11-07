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
    admin_session_ttl_minutes: int = Field(default=120, ge=1, le=10080)
    admin_login_max_attempts: int = Field(default=5, ge=1, le=20)
    admin_login_base_delay: float = Field(default=0.2, ge=0, le=10)
    admin_login_max_delay: float = Field(default=2.0, ge=0, le=60)
    # None=自动：public_base_url 为 https 时启用 Secure，本地 http 保持 False。
    admin_cookie_secure: bool | None = None
    media_root: str = "./data/media"
    nginx_cache_root: str = "./data/nginx_cache"
    thumbnail_max_size: int = Field(default=1280, ge=240, le=4096)
    thumbnail_quality: int = Field(default=82, ge=1, le=100)
    media_derivative_version: str = "20260906-ratio-v1"
    video_frame_offset_seconds: float = 0.0
    remote_thumbnail_source_max_bytes: int = 16 * 1024 * 1024
    remote_thumbnail_video_source_max_bytes: int = 64 * 1024 * 1024
    # 单次源文件下载的整体总时限：只看 connect/read 不够，慢流会长期
    # 占住预热 worker 与 tmp 配额；64MB 视频在慢链路下约需数分钟。
    source_download_timeout_seconds: float = Field(default=600, ge=30, le=3600)
    remote_thumbnail_disk_quota_bytes: int = Field(
        default=4 * 1024 * 1024 * 1024,
        ge=0,
        le=64 * 1024 * 1024 * 1024,
    )
    remote_thumbnail_max_temp_files: int = Field(default=8, ge=0, le=64)
    browser_probe_max_bytes: int = 2 * 1024 * 1024
    browser_probe_timeout_seconds: float = 12.0
    scan_concurrency_limit: int = Field(default=1, ge=1, le=4)
    scan_queue_limit: int = Field(default=1, ge=0, le=100)
    scan_wait_timeout_seconds: float = Field(default=0.0, ge=0, le=30)
    direct_probe_concurrency_limit: int = Field(default=4, ge=1, le=16)
    direct_probe_queue_limit: int = Field(default=16, ge=0, le=1000)
    direct_probe_wait_timeout_seconds: float = Field(default=3.0, ge=0, le=30)
    # 预热 worker 以等待下载的 IO 为主、ffmpeg/缩放单线程，默认并发取 3；
    # 派生槽位放宽到 2 兼顾访客按需派生。小机器可通过 env 调回。
    derivative_concurrency_limit: int = Field(default=2, ge=1, le=4)
    derivative_queue_limit: int = Field(default=32, ge=0, le=1000)
    derivative_wait_timeout_seconds: float = Field(default=15.0, ge=0, le=60)
    preheat_concurrency_limit: int = Field(default=3, ge=1, le=8)
    preheat_queue_limit: int = Field(default=64, ge=0, le=1000)
    preheat_wait_timeout_seconds: float = Field(default=2.0, ge=0, le=30)
    preheat_auto_after_scan: bool = Field(default=True)
    stream_global_concurrency_limit: int = Field(default=16, ge=1, le=64)
    stream_user_concurrency_limit: int = Field(default=3, ge=1, le=16)
    stream_queue_limit: int = Field(default=32, ge=0, le=1000)
    stream_wait_timeout_seconds: float = Field(default=1.0, ge=0, le=30)
    task_thread_pool_size: int = Field(default=24, ge=1, le=128)
    backend_memory_limit_bytes: int = Field(
        default=256 * 1024 * 1024,
        ge=0,
        le=8 * 1024 * 1024 * 1024,
    )
    database_pool_size: int = Field(default=8, ge=1, le=100)
    database_pool_max_overflow: int = Field(default=8, ge=0, le=100)
    database_pool_timeout_seconds: int = Field(default=30, ge=1, le=300)
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
    baidu_sync_page_size: int = Field(default=1000, ge=1, le=1000)
    baidu_sync_max_bytes: int = 2 * 1024 * 1024 * 1024
    baidu_scan_max_depth: int = Field(default=8, ge=1, le=32)
    baidu_scan_max_items: int = Field(default=5000, ge=1, le=100000)
    baidu_request_interval_seconds: float = Field(default=0.2, ge=0, le=30)
    baidu_retry_attempts: int = Field(default=3, ge=1, le=10)
    baidu_retry_base_delay: float = Field(default=0.5, ge=0, le=60)
    baidu_retry_max_delay: float = Field(default=8.0, ge=0, le=600)
    baidu_download_url_ttl_seconds: int = 300
    baidu_download_url_cache_size: int = Field(
        default=256,
        ge=16,
        le=4096,
    )
    baidu_thumbnail_size: str = "c1600_u1600"

    @model_validator(mode="after")
    def resolve_database_url(self) -> "Settings":
        # 弱管理令牌直接拒绝启动：ADMIN_TOKEN 是唯一管理凭证入口，
        # 照抄示例值上线等于无锁。空值合法（登录 fail-closed）。
        if self.admin_token.strip() == "change-me":
            raise ValueError(
                "ADMIN_TOKEN 仍为示例值 change-me；请设置强随机值后再启动"
            )

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

    @property
    def admin_cookie_secure_effective(self) -> bool:
        """会话 cookie 是否带 Secure：显式配置优先，未配置按部署 URL 自动推导。

        https 部署自动启用；本地 http 保持关闭（浏览器对 localhost 已按
        可信来源处理，但显式 False 仍是本地方便性的明确选择）。
        """

        if self.admin_cookie_secure is not None:
            return self.admin_cookie_secure
        return self.public_base_url.strip().lower().startswith("https://")

    def credential_warnings(self) -> list[str]:
        """启动期需要运维关注的弱凭证提示（不阻止启动，见 README 上线清单）。"""

        warnings: list[str] = []
        if self.postgres_host.strip() and self.postgres_password in ("", "change-me"):
            warnings.append(
                "POSTGRES_PASSWORD 为空或示例值 change-me：数据库未对外暴露时风险"
                "可控，但生产部署前必须更换为强随机值"
            )
        if self.admin_token and not self.admin_cookie_secure_effective:
            base = self.public_base_url.strip().lower()
            if base.startswith("https://"):
                warnings.append(
                    "public_base_url 为 https 但会话 cookie 未启用 Secure："
                    "请设置 ADMIN_COOKIE_SECURE=true 或移除该变量以自动推导"
                )
        return warnings


@lru_cache
def get_settings() -> Settings:
    return Settings()
