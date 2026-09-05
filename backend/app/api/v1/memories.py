import mimetypes
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_db
from app.models.memory import Memory, MemoryFile, MemoryKind, MemoryStatus
from app.schemas.memory import MemoryRead, to_memory_read
from app.schemas.responses import MemoryListResponse
from app.services.memory_thumbnails import resolve_media_path

router = APIRouter(prefix="/memories", tags=["memories"])


@router.get("", response_model=MemoryListResponse)
def list_memories(
    kind: MemoryKind | None = None,
    keyword: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=24, ge=1, le=100),
    db: Session = Depends(get_db),
) -> MemoryListResponse:
    statement = select(Memory).where(Memory.status == MemoryStatus.PUBLISHED)

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

    if memory is None or memory.status != MemoryStatus.PUBLISHED:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="memory not found"
        )

    return to_memory_read(memory)


@router.get("/{memory_id}/file")
def get_memory_file(
    memory_id: uuid.UUID,
    db: Session = Depends(get_db),
) -> FileResponse:
    memory = db.get(Memory, memory_id)

    if memory is None or memory.status != MemoryStatus.PUBLISHED:
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
    target_path = resolve_media_path(Path(settings.media_root), memory_file.source_path)

    if target_path is None or not target_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="memory file missing"
        )

    return FileResponse(
        target_path,
        media_type=memory_file.mime_type,
        filename=memory_file.remote_path,
    )


@router.get("/{memory_id}/thumbnail")
def get_memory_thumbnail(
    memory_id: uuid.UUID,
    db: Session = Depends(get_db),
) -> FileResponse:
    memory = db.get(Memory, memory_id)

    if memory is None or memory.status != MemoryStatus.PUBLISHED:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="memory not found"
        )

    if not memory.thumbnail_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="memory thumbnail missing"
        )

    settings = get_settings()
    target_path = resolve_media_path(Path(settings.media_root), memory.thumbnail_path)

    if target_path is None or not target_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="memory thumbnail missing"
        )

    return FileResponse(
        target_path,
        media_type=mimetypes.guess_type(target_path.name)[0] or "image/webp",
    )
