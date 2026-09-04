from collections.abc import Generator
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import get_settings


settings = get_settings()

if settings.database_url.startswith("sqlite:///"):
    sqlite_path = settings.database_url.removeprefix("sqlite:///").partition("?")[0]
    if sqlite_path and sqlite_path != ":memory:":
        Path(sqlite_path).parent.mkdir(parents=True, exist_ok=True)

engine = create_engine(settings.database_url, pool_pre_ping=True)


class Base(DeclarativeBase):
    pass


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
