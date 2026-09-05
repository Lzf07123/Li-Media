import mimetypes
import uuid
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
from app.schemas.responses import MemoryListResponse
from app.services.memory_thumbnails import resolve_media_path
from app.services.admin_logs import record_admin_operation
from app.services.baidu_pan import BaiduPanClient, BaiduPanError

router = APIRouter(prefix="/memories", tags=["memories"])


@router.get("", response_model=MemoryListResponse)
def list_memories(
    kind: MemoryKind | None = None,
    keyword: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=24, ge=1, le=100),
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

    count_statement = select(func.count()).select_from(statement.subquery())
    total = db.scalar(count_statement) or 0

    memories = db.scalars(
        statement.order_by(Memory.captured_at.desc().nulls_last())
        .order_by(Memory.updated_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()

    return MemoryListResponse(
        items=[to_memory_read(memory) for memory in memories],
        total=total,
        page=page,
        page_size=page_size,
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
    target_path = (
        resolve_media_path(Path(settings.media_root), memory.thumbnail_path)
        if memory.thumbnail_path
        else None
    )

    if target_path is not None and target_path.is_file():
        return FileResponse(
            target_path,
            media_type=mimetypes.guess_type(target_path.name)[0] or "image/webp",
        )

    if memory_file is None or not memory_file.remote_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="memory thumbnail missing"
        )

    try:
        content, content_type = BaiduPanClient(settings).get_thumbnail(
            memory_file.remote_id
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
    db.commit()
    return Response(
        content=content,
        media_type=content_type,
        headers={"Cache-Control": "private, max-age=300"},
    )
