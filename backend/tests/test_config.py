from app.core.config import Settings
from sqlalchemy.engine import make_url


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
