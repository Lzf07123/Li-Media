import mimetypes
import uuid
from typing import Literal
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_db
from app.models.memory import (
    Memory,
    MemoryFile,
    MemoryKind,
    MemoryStatus,
    RemoteThumbnailState,
)
from app.schemas.memory import MemoryRead, to_memory_read
from app.schemas.responses import (
    MemoryCounts,
    MemoryDirectLinkResponse,
    MemoryListResponse,
)
from app.services.memory_thumbnails import read_image_dimensions, resolve_media_path
from app.services.admin_logs import record_admin_operation
from app.services.baidu_pan import BaiduPanClient, BaiduPanError
from app.services.remote_thumbnails import create_remote_thumbnail

router = APIRouter(prefix="/memories", tags=["memories"])


@router.get("", response_model=MemoryListResponse)
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
) -> MemoryListResponse:
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

    return MemoryListResponse(
        items=[to_memory_read(memory) for memory in memories],
        total=total,
        page=page,
        page_size=page_size,
        counts=MemoryCounts(photo=photo_count, video=video_count),
    )


@router.get("/{memory_id}", response_model=MemoryRead)
def get_memory(memory_id: uuid.UUID, db: Session = Depends(get_db)) -> Memory:
    memory = db.get(Memory, memory_id)

    if (
        memory is None
        or memory.status != MemoryStatus.PUBLISHED
        or not any(memory_file.source == "baidupan" for memory_file in memory.files)
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="memory not found"
        )

    return to_memory_read(memory)


@router.get("/{memory_id}/direct-url", response_model=MemoryDirectLinkResponse)
def get_memory_direct_url(
    memory_id: uuid.UUID,
    response: Response,
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
        direct_url, ttl_seconds = BaiduPanClient(settings).resolve_direct_url(
            memory_file.remote_id
        )
    except BaiduPanError as exc:
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
        status_code, content_length, content_range, content_type, response = (
            BaiduPanClient(settings).open_stream(
                memory_file.remote_id or "",
                range_header=request.headers.get("range"),
            )
        )
    except BaiduPanError as exc:
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
        finally:
            response.close()

    headers: dict[str, str] = {"Accept-Ranges": "bytes"}
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
    size: Literal["small", "medium", "large", "detail"] = Query(default="medium"),
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
    cache_headers = {
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        "ETag": f'"{memory_id}-{size}"',
    }

    if request.headers.get("if-none-match") == cache_headers["ETag"]:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=cache_headers)

    target_path = (
        resolve_media_path(Path(settings.media_root), memory.thumbnail_path)
        if memory.thumbnail_path
        else None
    )

    if target_path is not None and target_path.is_file():
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
        generated_path = create_remote_thumbnail(
            client,
            memory_file.remote_id,
            Path(settings.media_root),
            kind=memory.kind,
            memory_id=memory.id,
            duration_seconds=memory.duration_seconds,
        )
    except BaiduPanError:
        generated_path = None

    if generated_path:
        memory.thumbnail_path = generated_path
        memory_file.thumbnail_state = RemoteThumbnailState.READY
        target_path = resolve_media_path(
            Path(settings.media_root), memory.thumbnail_path
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

    try:
        content, content_type = client.get_thumbnail(
            memory_file.remote_id,
            requested_size=size,
        )
    except BaiduPanError as exc:
        memory_file.thumbnail_state = RemoteThumbnailState.FAILED
        record_admin_operation(
            db,
            action="thumbnail_proxy_failed",
            target_type="memory",
            target_id=memory.id,
            detail=str(exc),
        )
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc) or "远程缩略图暂时无法加载",
        ) from exc

    memory_file.thumbnail_state = RemoteThumbnailState.READY
    if memory.width is None or memory.height is None:
        dimensions = read_image_dimensions(content)
        if dimensions is not None:
            memory.width, memory.height = dimensions
    db.commit()
    return Response(
        content=content,
        media_type=content_type,
        headers=cache_headers,
    )
