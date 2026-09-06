import mimetypes
import uuid
from typing import Literal
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from threading import Lock

from app.core.config import get_settings
from app.db.session import get_db
from app.models.memory import (
    Memory,
    MemoryFile,
    MemoryKind,
    MemoryStatus,
    RemoteThumbnailState,
)
from app.schemas.memory import MemorySummaryRead, to_memory_summary
from app.schemas.responses import (
    MemoryCounts,
    MemoryDirectLinkResponse,
    MemorySummaryListResponse,
)
from app.services.memory_thumbnails import (
    derivative_cache_path,
    read_image_dimensions,
    resolve_media_path,
)
from app.services.admin_logs import record_admin_operation
from app.services.baidu_pan import BaiduPanClient, BaiduPanError
from app.services.derivative_tasks import (
    run_local_derivative,
    run_remote_derivative,
)
from app.services.task_limits import (
    TaskRejected,
    TaskType,
    task_limiter,
    task_metrics,
)

router = APIRouter(prefix="/memories", tags=["memories"])
_stream_users: dict[str, int] = {}
_stream_users_lock = Lock()


def _task_http_error(exc: TaskRejected) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=str(exc),
        headers={"Retry-After": str(max(1, int(exc.retry_after)))},
    )


@router.get("/recommend", response_model=list[MemorySummaryRead])
def recommend_memories(
    response: Response,
    kind: MemoryKind | None = None,
    limit: int = Query(default=8, ge=1, le=24),
    db: Session = Depends(get_db),
) -> list[MemorySummaryRead]:
    statement = (
        select(Memory)
        .where(
            Memory.status == MemoryStatus.PUBLISHED,
            Memory.files.any(MemoryFile.source == "baidupan"),
        )
        .order_by(func.random())
    )

    if kind is not None:
        statement = statement.where(Memory.kind == kind)

    memories = db.scalars(statement.limit(limit)).all()
    # Recommendations are intentionally visit-scoped; do not let a browser reuse them.
    response.headers["Cache-Control"] = "no-store"
    return [to_memory_summary(memory) for memory in memories]


@router.get("", response_model=MemorySummaryListResponse)
def list_memories(
    kind: MemoryKind | None = None,
    keyword: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=24, ge=1, le=100),
    sort: str = Query(
        default="captured_desc",
        pattern="^(captured_desc|captured_asc|updated_desc)$",
    ),
    db: Session = Depends(get_db),
) -> MemorySummaryListResponse:
    statement = (
        select(Memory)
        .join(Memory.files)
        .where(
            Memory.status == MemoryStatus.PUBLISHED,
            MemoryFile.source == "baidupan",
        )
        .distinct()
    )

    if kind is not None:
        statement = statement.where(Memory.kind == kind)

    if keyword:
        statement = statement.where(
            (Memory.title.ilike(f"%{keyword}%"))
            | (Memory.description.ilike(f"%{keyword}%"))
            | (Memory.location.ilike(f"%{keyword}%"))
        )

    total = db.scalar(select(func.count()).select_from(statement.subquery())) or 0
    photo_count = (
        db.scalar(
            select(func.count()).select_from(
                statement.where(Memory.kind == MemoryKind.PHOTO).subquery()
            )
        )
        or 0
    )
    video_count = total - photo_count

    if sort == "captured_asc":
        primary_order = Memory.captured_at.asc().nulls_last()
        secondary_order = Memory.updated_at.asc()
    elif sort == "updated_desc":
        primary_order = Memory.updated_at.desc()
        secondary_order = Memory.captured_at.desc().nulls_last()
    else:
        primary_order = Memory.captured_at.desc().nulls_last()
        secondary_order = Memory.updated_at.desc()

    memories = db.scalars(
        statement.order_by(primary_order)
        .order_by(secondary_order)
        .order_by(Memory.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()

    return MemorySummaryListResponse(
        items=[to_memory_summary(memory) for memory in memories],
        total=total,
        page=page,
        page_size=page_size,
        counts=MemoryCounts(photo=photo_count, video=video_count),
    )


@router.get("/{memory_id}", response_model=MemorySummaryRead)
def get_memory(memory_id: uuid.UUID, db: Session = Depends(get_db)) -> MemorySummaryRead:
    memory = db.get(Memory, memory_id)

    if (
        memory is None
        or memory.status != MemoryStatus.PUBLISHED
        or not any(memory_file.source == "baidupan" for memory_file in memory.files)
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="memory not found"
        )

    return to_memory_summary(memory)


@router.get("/{memory_id}/direct-url", response_model=MemoryDirectLinkResponse)
def get_memory_direct_url(
    memory_id: uuid.UUID,
    response: Response,
    purpose: Literal["play", "download"] = Query(default="play"),
    db: Session = Depends(get_db),
) -> MemoryDirectLinkResponse:
    memory = db.get(Memory, memory_id)

    if (
        memory is None
        or memory.status != MemoryStatus.PUBLISHED
        or not any(memory_file.source == "baidupan" for memory_file in memory.files)
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="memory not found"
        )

    memory_file = db.scalar(
        select(MemoryFile).where(MemoryFile.memory_id == memory_id)
    )

    if memory_file is None or not memory_file.remote_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="memory file not found"
        )

    settings = get_settings()
    try:
        with task_limiter.slot(TaskType.DIRECT_PROBE):
            direct_url, ttl_seconds = BaiduPanClient(settings).resolve_direct_url(
                memory_file.remote_id
            )
    except TaskRejected as exc:
        raise _task_http_error(exc) from exc
    except BaiduPanError as exc:
        if str(exc) == "百度网盘接口限流，请稍后重试":
            task_metrics.record_rate_limited(TaskType.DIRECT_PROBE)
        task_metrics.record_failed(TaskType.DIRECT_PROBE)
        record_admin_operation(
            db,
            action="direct_url_failed",
            target_type="memory",
            target_id=memory.id,
            detail=str(exc),
        )
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc) or "远程媒体直链暂时不可用",
        ) from exc

    task_metrics.record_completed(TaskType.DIRECT_PROBE)

    record_admin_operation(
        db,
        action="direct_url_requested",
        target_type="memory",
        target_id=memory.id,
        detail=f"purpose={purpose};remote_resource=untouched",
    )
    # Direct URLs are short-lived and must not be persisted by browsers.
    response.headers["Cache-Control"] = "no-store"
    return MemoryDirectLinkResponse(
        direct_url=direct_url,
        expires_at=(
            datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
            if ttl_seconds > 0
            else None
        ),
        mime_type=memory_file.mime_type,
        size_bytes=memory_file.size_bytes,
    )


@router.api_route("/{memory_id}/file", methods=["GET"], response_model=None)
@router.api_route("/{memory_id}/stream", methods=["GET"], response_model=None)
def stream_memory(
    memory_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
) -> FileResponse | StreamingResponse:
    memory = db.get(Memory, memory_id)

    if (
        memory is None
        or memory.status != MemoryStatus.PUBLISHED
        or not any(memory_file.source == "baidupan" for memory_file in memory.files)
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="memory not found"
        )

    memory_file = db.scalar(
        select(MemoryFile).where(MemoryFile.memory_id == memory_id)
    )

    if memory_file is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="memory file not found"
        )

    settings = get_settings()
    media_root = Path(settings.media_root)
    target_path = resolve_media_path(media_root, memory_file.source_path)

    if target_path is not None and target_path.is_file():
        return FileResponse(
            target_path,
            media_type=memory_file.mime_type,
            filename=memory_file.remote_path,
        )

    try:
        task_slot = task_limiter.acquire(
            TaskType.STREAM,
            timeout=get_settings().stream_wait_timeout_seconds,
        )
    except TaskRejected as exc:
        raise _task_http_error(exc) from exc

    user_key = request.client.host or "unknown"
    with _stream_users_lock:
        if (
            _stream_users.get(user_key, 0)
            >= get_settings().stream_user_concurrency_limit
        ):
            task_limiter.release(task_slot)
            task_metrics.record_rejected(TaskType.STREAM)
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="同一用户的视频回退流已达上限",
                headers={"Retry-After": "1"},
            )
        _stream_users[user_key] = _stream_users.get(user_key, 0) + 1

    try:
        status_code, content_length, content_range, content_type, response = (
            BaiduPanClient(settings).open_stream(
                memory_file.remote_id or "",
                range_header=request.headers.get("range"),
            )
        )
    except BaiduPanError as exc:
        task_limiter.release(task_slot)
        with _stream_users_lock:
            _stream_users[user_key] -= 1
            if _stream_users[user_key] <= 0:
                del _stream_users[user_key]

        task_metrics.record_failed(TaskType.STREAM)
        record_admin_operation(
            db,
            action="stream_proxy_failed",
            target_type="memory",
            target_id=memory.id,
            detail=str(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc) or "远程媒体暂时无法播放",
        ) from exc

    def stream_response():
        try:
            yield from response.iter_bytes()
            task_metrics.record_completed(TaskType.STREAM)
        finally:
            response.close()
            task_limiter.release(task_slot)
            with _stream_users_lock:
                _stream_users[user_key] -= 1
                if _stream_users[user_key] <= 0:
                    del _stream_users[user_key]

    headers: dict[str, str] = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
    }
    if content_range:
        headers["Content-Range"] = str(content_range)
    if content_length is not None:
        headers["Content-Length"] = str(content_length)

    return StreamingResponse(
        stream_response(),
        status_code=206 if content_range else (status_code or 200),
        media_type=str(content_type),
        headers=headers,
    )


@router.get("/{memory_id}/thumbnail", response_model=None)
def get_memory_thumbnail(
    memory_id: uuid.UUID,
    request: Request,
    size: Literal["240", "480", "768", "1280"] = Query(default="480"),
    db: Session = Depends(get_db),
) -> FileResponse | Response:
    memory = db.get(Memory, memory_id)

    if (
        memory is None
        or memory.status != MemoryStatus.PUBLISHED
        or not any(memory_file.source == "baidupan" for memory_file in memory.files)
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="memory not found"
        )

    memory_file = db.scalar(
        select(MemoryFile).where(MemoryFile.memory_id == memory_id)
    )

    if (
        not memory.thumbnail_path
        and (
            memory_file is None
            or not memory_file.remote_id
            or memory_file.thumbnail_state == RemoteThumbnailState.MISSING
        )
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="memory thumbnail missing"
        )

    settings = get_settings()
    media_root = Path(settings.media_root)
    max_size = int(size)
    cache_headers = {
        "Cache-Control": "public, max-age=31536000, immutable",
        "ETag": f'"{memory_id}-{settings.media_derivative_version}-{max_size}"',
    }

    if request.headers.get("if-none-match") == cache_headers["ETag"]:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=cache_headers)

    target_path = derivative_cache_path(
        media_root,
        memory.id,
        max_size=max_size,
        version=settings.media_derivative_version,
    )

    if target_path is not None and target_path.is_file():
        if memory.width is None or memory.height is None:
            dimensions = read_image_dimensions(target_path.read_bytes())
            if dimensions is not None:
                memory.width, memory.height = dimensions
                db.commit()

        return FileResponse(
            target_path,
            media_type=mimetypes.guess_type(target_path.name)[0] or "image/webp",
            headers=cache_headers,
        )

    if memory_file is not None:
        local_source_path = resolve_media_path(media_root, memory_file.source_path)
        if local_source_path is not None and local_source_path.is_file():
            try:
                generated_path = run_local_derivative(
                    local_source_path,
                    media_root,
                    memory=memory,
                    max_size=max_size,
                    duration_seconds=memory.duration_seconds,
                )
            except TaskRejected as exc:
                raise _task_http_error(exc) from exc

            if generated_path:
                memory.thumbnail_path = generated_path
                memory_file.thumbnail_state = RemoteThumbnailState.READY
                if memory.width is None or memory.height is None:
                    dimensions = read_image_dimensions(target_path.read_bytes())
                    if dimensions is not None:
                        memory.width, memory.height = dimensions
                db.commit()
                return FileResponse(
                    target_path,
                    media_type=mimetypes.guess_type(target_path.name)[0] or "image/webp",
                    headers=cache_headers,
                )

    if memory_file is None or not memory_file.remote_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="memory thumbnail missing"
        )

    client = BaiduPanClient(settings)
    try:
        generated_path = run_remote_derivative(
            client,
            memory_file.remote_id or "",
            media_root,
            memory=memory,
            max_size=max_size,
            duration_seconds=memory.duration_seconds,
        )
    except TaskRejected as exc:
        raise _task_http_error(exc) from exc
    except BaiduPanError:
        generated_path = None

    if generated_path:
        memory.thumbnail_path = generated_path
        memory_file.thumbnail_state = RemoteThumbnailState.READY
        served_target = derivative_cache_path(
            media_root,
            memory.id,
            max_size=max_size,
            version=settings.media_derivative_version,
        )
        if served_target.is_file():
            if memory.width is None or memory.height is None:
                dimensions = read_image_dimensions(served_target.read_bytes())
                if dimensions is not None:
                    memory.width, memory.height = dimensions
            db.commit()
            return FileResponse(
                served_target,
                media_type=mimetypes.guess_type(served_target.name)[0] or "image/webp",
                headers=cache_headers,
            )

    memory_file.thumbnail_state = RemoteThumbnailState.FAILED
    task_metrics.record_failed(TaskType.DERIVATIVE)
    record_admin_operation(
        db,
        action="thumbnail_derivation_failed",
        target_type="memory",
        target_id=memory.id,
        detail="服务端派生失败，未回退到方形缩略图",
    )
    db.commit()
    raise HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail="远程媒体派生暂时无法加载",
    )
