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
    media_root: str = "./data/media"
    thumbnail_max_size: int = 1280
    thumbnail_quality: int = 82
    baidu_api_base_url: str = "https://pan.baidu.com/rest/2.0/xpan"
    baidu_access_token: str = ""
    baidu_sync_dir: str = "/apps/Li&Media"
    baidu_sync_page_size: int = 1000
    baidu_sync_max_bytes: int = 2 * 1024 * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
