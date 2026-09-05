import secrets
import time
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import (
    Body,
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
    Request,
    Response,
    status,
)
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_db
from app.models.admin import AdminSession
from app.models.memory import Memory, MemoryFile, MemoryFileStatus, MemoryStatus
from app.schemas.memory import MemoryRead, MemoryUpdate, to_memory_read
from app.schemas.responses import (
    AdminMemoryListResponse,
    AdminLoginRequest,
    AdminSyncRequest,
    AdminSyncResponse,
)
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
from app.services.admin_logs import record_admin_operation
from app.services.admin_security import (
    AdminLoginLimitError,
    admin_login_rate_limiter,
    create_admin_session,
    get_valid_admin_session,
    revoke_admin_session,
    sleep_for_login_delay,
)
from app.services.baidu_pan import BaiduPanClient, BaiduPanError
from app.services.baidu_sync import sync_baidu_files

router = APIRouter(prefix="/admin", tags=["admin"])


def require_admin_session(
    request: Request,
    db: Session = Depends(get_db),
) -> AdminSession:
    settings = get_settings()
    session_token = request.cookies.get(settings.admin_session_cookie_name)
    admin_session = get_valid_admin_session(db, session_token)

    if admin_session is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="管理会话缺失或已过期",
        )

    return admin_session


def _client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


@router.post("/login", status_code=status.HTTP_204_NO_CONTENT)
def login_admin(
    payload: AdminLoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> None:
    settings = get_settings()
    client_ip = _client_ip(request)
    client_key = client_ip or "unknown"

    try:
        admin_login_rate_limiter.check(client_key)
    except AdminLoginLimitError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
            headers={"Retry-After": str(exc.retry_after_seconds)},
        ) from exc

    if (
        not settings.admin_token
        or not secrets.compare_digest(payload.token, settings.admin_token)
    ):
        delay = admin_login_rate_limiter.record_failure(client_key)
        sleep_for_login_delay(delay)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="管理令牌不正确",
        )

    admin_login_rate_limiter.reset(client_key)
    session_token = create_admin_session(
        db,
        settings,
        client_ip=client_ip,
    )
    record_admin_operation(
        db,
        action="login",
        client_ip=client_ip,
    )
    response.set_cookie(
        settings.admin_session_cookie_name,
        session_token,
        max_age=settings.admin_session_ttl_minutes * 60,
        httponly=True,
        samesite="lax",
        secure=settings.admin_cookie_secure,
        path="/",
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout_admin(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    _: AdminSession = Depends(require_admin_session),
) -> None:
    settings = get_settings()
    session_token = request.cookies.get(settings.admin_session_cookie_name)
    revoke_admin_session(db, session_token)
    record_admin_operation(
        db,
        action="logout",
        client_ip=_client_ip(request),
    )
    response.delete_cookie(settings.admin_session_cookie_name, path="/")


@router.post("/sync", response_model=AdminSyncResponse)
def trigger_baidu_sync(
    request: Request,
    payload: AdminSyncRequest | None = Body(default=None),
    db: Session = Depends(get_db),
    _: AdminSession = Depends(require_admin_session),
) -> AdminSyncResponse:
    request_payload = payload or AdminSyncRequest()
    settings = get_settings()

    if not settings.baidu_access_token:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="百度网盘访问凭证未配置",
        )

    try:
        summary = sync_baidu_files(
            db,
            BaiduPanClient(settings),
            Path(settings.media_root),
            remote_dir=settings.baidu_sync_dir,
            max_files=request_payload.max_files,
            max_bytes=settings.baidu_sync_max_bytes,
        )
    except BaiduPanError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc

    record_admin_operation(
        db,
        action="sync",
        client_ip=_client_ip(request),
        detail=f"discovered={summary.discovered};matched={summary.matched};failed={summary.failed}",
    )

    return AdminSyncResponse(
        discovered=summary.discovered,
        matched=summary.matched,
        failed=summary.failed,
    )


@router.get("/memories", response_model=AdminMemoryListResponse)
def list_admin_memories(
    db: Session = Depends(get_db),
    _: AdminSession = Depends(require_admin_session),
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
    request: Request,
    title: str | None = Form(default=None, max_length=255),
    description: str = Form(default=""),
    location: str | None = Form(default=None, max_length=255),
    captured_at: datetime | None = Form(default=None),
    file: UploadFile = File(),
    db: Session = Depends(get_db),
    _: AdminSession = Depends(require_admin_session),
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
    record_admin_operation(
        db,
        action="upload",
        target_type="memory",
        target_id=memory.id,
        client_ip=_client_ip(request),
        detail=memory.title,
    )
    return to_memory_read(memory)


@router.patch("/memories/{memory_id}", response_model=MemoryRead)
def update_memory(
    memory_id: uuid.UUID,
    payload: MemoryUpdate,
    request: Request,
    db: Session = Depends(get_db),
    _: AdminSession = Depends(require_admin_session),
) -> Memory:
    memory = db.get(Memory, memory_id)

    if memory is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="回忆不存在"
        )

    previous_status = memory.status
    changed_fields = sorted(payload.model_dump(exclude_unset=True).keys())
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(memory, key, value)

    db.commit()
    db.refresh(memory)
    action = "update"
    if memory.status != previous_status:
        action = "publish" if memory.status == MemoryStatus.PUBLISHED else "hide"

    record_admin_operation(
        db,
        action=action,
        target_type="memory",
        target_id=memory.id,
        client_ip=_client_ip(request),
        detail=", ".join(changed_fields),
    )
    return to_memory_read(memory)


@router.delete("/memories/{memory_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_memory(
    memory_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    _: AdminSession = Depends(require_admin_session),
) -> None:
    memory = db.get(Memory, memory_id)

    if memory is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="回忆不存在"
        )

    record_admin_operation(
        db,
        action="delete",
        target_type="memory",
        target_id=memory.id,
        client_ip=_client_ip(request),
        detail=memory.title,
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
