import secrets
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    UploadFile,
    status,
)
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_db
from app.models.memory import Memory, MemoryFile, MemoryFileStatus
from app.schemas.memory import MemoryRead, MemoryUpdate, to_memory_read
from app.schemas.responses import AdminMemoryListResponse
from app.services.memory_files import (
    guess_mime_type,
    infer_memory_kind,
    save_upload,
)
from app.services.memory_metadata import extract_memory_metadata
from app.services.memory_thumbnails import (
    create_memory_thumbnail,
    remove_media_file,
)

router = APIRouter(prefix="/admin", tags=["admin"])


def require_admin_token(
    x_admin_token: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
) -> None:
    settings = get_settings()
    provided_token = x_admin_token

    if not provided_token and authorization and authorization.lower().startswith(
        "bearer "
    ):
        provided_token = authorization[7:]

    if (
        not settings.admin_token
        or not provided_token
        or not secrets.compare_digest(provided_token, settings.admin_token)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="管理令牌缺失或不正确",
        )


@router.get("/memories", response_model=AdminMemoryListResponse)
def list_admin_memories(
    db: Session = Depends(get_db),
    _: None = Depends(require_admin_token),
) -> AdminMemoryListResponse:
    total = db.scalar(select(func.count()).select_from(Memory)) or 0
    memories = db.scalars(
        select(Memory).order_by(Memory.created_at.desc())
    ).all()

    return AdminMemoryListResponse(
        items=[to_memory_read(memory) for memory in memories], total=total
    )


@router.post("/memories", response_model=MemoryRead)
def create_memory(
    title: str | None = Form(default=None, max_length=255),
    description: str = Form(default=""),
    location: str | None = Form(default=None, max_length=255),
    captured_at: datetime | None = Form(default=None),
    file: UploadFile = File(),
    db: Session = Depends(get_db),
    _: None = Depends(require_admin_token),
) -> Memory:
    settings = get_settings()
    kind = infer_memory_kind(file.filename or "", file.content_type)
    media_root = Path(settings.media_root)
    target_path, size_bytes, relative_path = save_upload(
        file, media_root, kind=kind
    )
    metadata = extract_memory_metadata(target_path, kind)
    fallback_title = Path(file.filename or target_path.name).stem.strip()[:255]
    final_title = (title or metadata.title or fallback_title).strip()[:255]
    memory_id = uuid.uuid4()

    memory = Memory(
        id=memory_id,
        title=final_title or "未命名回忆",
        description=description or metadata.description or "",
        kind=kind,
        status="published",
        captured_at=captured_at or metadata.captured_at,
        location=location or metadata.location,
        width=metadata.width,
        height=metadata.height,
        duration_seconds=metadata.duration_seconds,
        thumbnail_path=create_memory_thumbnail(
            target_path,
            media_root,
            kind=kind,
            memory_id=memory_id,
            duration_seconds=metadata.duration_seconds,
        ),
    )
    memory_file = MemoryFile(
        memory_id=memory_id,
        source="upload",
        remote_path=file.filename or target_path.name,
        source_path=relative_path,
        mime_type=guess_mime_type(target_path.name, file.content_type),
        size_bytes=size_bytes,
        status=MemoryFileStatus.MATCHED,
    )

    db.add(memory)
    db.add(memory_file)
    db.commit()
    db.refresh(memory)
    return to_memory_read(memory)


@router.patch("/memories/{memory_id}", response_model=MemoryRead)
def update_memory(
    memory_id: uuid.UUID,
    payload: MemoryUpdate,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin_token),
) -> Memory:
    memory = db.get(Memory, memory_id)

    if memory is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="回忆不存在"
        )

    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(memory, key, value)

    db.commit()
    db.refresh(memory)
    return to_memory_read(memory)


@router.delete("/memories/{memory_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_memory(
    memory_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin_token),
) -> None:
    memory = db.get(Memory, memory_id)

    if memory is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="回忆不存在"
        )

    settings = get_settings()
    media_root = Path(settings.media_root).resolve()
    files = db.scalars(
        select(MemoryFile).where(MemoryFile.memory_id == memory_id)
    ).all()

    for memory_file in files:
        remove_media_file(media_root, memory_file.source_path)

    remove_media_file(media_root, memory.thumbnail_path)

    db.delete(memory)
    db.commit()
