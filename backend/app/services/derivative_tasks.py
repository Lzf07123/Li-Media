"""Shared bounded execution helpers for media derivatives."""

from collections.abc import Sequence
from pathlib import Path
from threading import Event
from uuid import UUID

from app.core.config import get_settings
from app.models.memory import Memory
from app.services.memory_thumbnails import (
    create_memory_derivative,
    create_memory_derivatives,
)
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
    failure_sink: dict[str, str] | None = None,
    cancel_event: Event | None = None,
) -> str | None:
    settings = get_settings()
    key = derivative_key(memory.id, settings.media_derivative_version, max_size)

    def operation() -> str | None:
        with task_limiter.slot(
            TaskType.DERIVATIVE,
            priority=(
                derivative_priority(max_size) if priority is None else priority
            ),
            cancel_event=cancel_event,
        ):
            return create_memory_derivative(
                source_path,
                media_root,
                kind=memory.kind,
                memory_id=memory.id,
                max_size=max_size,
                duration_seconds=duration_seconds,
                failure_sink=failure_sink,
            )

    return in_flight_derivatives.run(
        key,
        operation,
        task_type=TaskType.DERIVATIVE,
        wait_timeout=settings.derivative_wait_timeout_seconds,
    )


def run_local_derivatives(
    source_path: Path,
    media_root: Path,
    *,
    memory: Memory,
    max_sizes: Sequence[int],
    duration_seconds: int | None = None,
    priority: int | None = None,
    failure_sink: dict[str, str] | None = None,
    cancel_event: Event | None = None,
) -> dict[int, str | None]:
    """一次 DERIVATIVE 槽位生成多个尺寸：单次解码/单次 ffmpeg 多输出。

    每 size 仍注册独立 in-flight key，按需请求可合并等待；槽位内解码级
    失败使全部尺寸失败，单尺寸保存失败只影响该尺寸。供预热批量路径使用。
    """

    settings = get_settings()
    sizes = list(dict.fromkeys(max_sizes))
    keys = [
        derivative_key(memory.id, settings.media_derivative_version, max_size)
        for max_size in sizes
    ]

    def operation() -> dict[str, str | None]:
        with task_limiter.slot(
            TaskType.DERIVATIVE,
            priority=(
                min(derivative_priority(size) for size in sizes)
                if priority is None
                else priority
            ),
            cancel_event=cancel_event,
        ):
            generated = create_memory_derivatives(
                source_path,
                media_root,
                kind=memory.kind,
                memory_id=memory.id,
                max_sizes=sizes,
                duration_seconds=duration_seconds,
                failure_sink=failure_sink,
            )
            return {
                key: generated.get(max_size)
                for key, max_size in zip(keys, sizes)
            }

    results = in_flight_derivatives.run_many(
        keys,
        operation,
        task_type=TaskType.DERIVATIVE,
    )
    return {
        max_size: results.get(key)
        for max_size, key in zip(sizes, keys)
    }


def run_remote_derivative(
    client: object,
    remote_id: str,
    media_root: Path,
    *,
    memory: Memory,
    max_size: int,
    duration_seconds: int | None = None,
    priority: int | None = None,
    failure_sink: dict[str, str] | None = None,
    cancel_event: Event | None = None,
    source_mime_type: str | None = None,
) -> str | None:
    settings = get_settings()
    key = derivative_key(memory.id, settings.media_derivative_version, max_size)

    def operation() -> str | None:
        with task_limiter.slot(
            TaskType.DERIVATIVE,
            priority=(
                derivative_priority(max_size) if priority is None else priority
            ),
            cancel_event=cancel_event,
        ):
            return create_remote_thumbnail(
                client,
                remote_id,
                media_root,
                kind=memory.kind,
                memory_id=memory.id,
                max_size=max_size,
                duration_seconds=duration_seconds,
                cancel_event=cancel_event or make_cancel_event(),
                source_mime_type=source_mime_type,
                failure_sink=failure_sink,
            )

    return in_flight_derivatives.run(
        key,
        operation,
        task_type=TaskType.DERIVATIVE,
        wait_timeout=settings.derivative_wait_timeout_seconds,
    )
