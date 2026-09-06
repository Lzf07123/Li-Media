from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from anyio import to_thread

from app.api.v1.router import api_router
from app.core.config import get_settings
from app.db.session import SessionLocal
from app.services.remote_thumbnails import cleanup_stale_remote_temporary_files
from app.services.source_zero import collect_source_zero_status


def log_source_zero_audit() -> None:
    """Record source-only invariant at startup; failures never hide startup state."""

    settings = get_settings()
    try:
        with SessionLocal() as db:
            status = collect_source_zero_status(db, Path(settings.media_root))
        print(
            "source_zero_audit "
            f"source_path_count={status['source_path_count']} "
            f"source_media_files={status['source_media_file_count']} "
            f"temporary_files={status['temporary_file_count']} "
            f"compliant={status['compliant']}",
            flush=True,
        )
    except Exception as exc:
        print(f"source_zero_audit_unavailable type={type(exc).__name__}", flush=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    cleanup_stale_remote_temporary_files(Path(settings.media_root))
    log_source_zero_audit()
    to_thread.current_default_thread_limiter().total_tokens = (
        settings.task_thread_pool_size
    )
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.project_name,
        version=settings.version,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )

    origins = [origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()]
    if origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PATCH", "DELETE"],
            allow_headers=["*"],
        )

    app.include_router(api_router, prefix="/api/v1")
    return app


app = create_app()
