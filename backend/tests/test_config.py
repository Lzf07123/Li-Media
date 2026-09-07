from app.core.config import Settings


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


def test_database_url_defaults_to_sqlite_without_postgres_host() -> None:
    settings = Settings(database_url="", postgres_host="")

    assert settings.database_url == "sqlite:///./data/app.db"
