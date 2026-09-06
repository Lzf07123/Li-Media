"""Shared bounded execution helpers for media derivatives."""

from pathlib import Path
from uuid import UUID

from app.core.config import get_settings
from app.models.memory import Memory
from app.services.memory_thumbnails import create_memory_derivative
from app.services.remote_thumbnails import create_remote_thumbnail
from app.services.task_limits import (
    TaskType,
    derivative_key,
    in_flight_derivatives,
    make_cancel_event,
    task_limiter,
)


def derivative_priority(max_size: int) -> int:
    return {240: 0, 480: 1, 768: 2, 1280: 3}.get(max_size, 50)


def run_local_derivative(
    source_path: Path,
    media_root: Path,
    *,
    memory: Memory,
    max_size: int,
    duration_seconds: int | None = None,
    priority: int | None = None,
) -> str | None:
    settings = get_settings()
    key = derivative_key(memory.id, settings.media_derivative_version, max_size)

    def operation() -> str | None:
        with task_limiter.slot(
            TaskType.DERIVATIVE,
            priority=(
                derivative_priority(max_size) if priority is None else priority
            ),
        ):
            return create_memory_derivative(
                source_path,
                media_root,
                kind=memory.kind,
                memory_id=memory.id,
                max_size=max_size,
                duration_seconds=duration_seconds,
            )

    return in_flight_derivatives.run(
        key,
        operation,
        task_type=TaskType.DERIVATIVE,
        wait_timeout=settings.derivative_wait_timeout_seconds,
    )


def run_remote_derivative(
    client: object,
    remote_id: str,
    media_root: Path,
    *,
    memory: Memory,
    max_size: int,
    duration_seconds: int | None = None,
    priority: int | None = None,
) -> str | None:
    settings = get_settings()
    key = derivative_key(memory.id, settings.media_derivative_version, max_size)

    def operation() -> str | None:
        with task_limiter.slot(
            TaskType.DERIVATIVE,
            priority=(
                derivative_priority(max_size) if priority is None else priority
            ),
        ):
            return create_remote_thumbnail(
                client,
                remote_id,
                media_root,
                kind=memory.kind,
                memory_id=memory.id,
                max_size=max_size,
                duration_seconds=duration_seconds,
                cancel_event=make_cancel_event(),
            )

    return in_flight_derivatives.run(
        key,
        operation,
        task_type=TaskType.DERIVATIVE,
        wait_timeout=settings.derivative_wait_timeout_seconds,
    )
