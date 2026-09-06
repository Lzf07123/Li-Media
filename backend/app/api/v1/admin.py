import secrets
import shutil
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import (
    Body,
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Request,
    Response,
    status,
)
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.db.session import get_db, get_session_factory
from app.models.admin import AdminSession
from app.models.memory import (
    Memory,
    MemoryFile,
    MemoryFileStatus,
    MemoryStatus,
    RemoteScanStatus,
    RemoteScanTask,
    RemoteFileState,
    RemoteThumbnailState,
    RemoteStreamState,
)
from app.schemas.memory import MemoryRead, MemoryUpdate, to_memory_read
from app.schemas.responses import (
    AdminBaiduAuthorizeResponse,
    AdminBaiduCallbackRequest,
    AdminBaiduCallbackResponse,
    AdminCleanupRequest,
    AdminCleanupResponse,
    AdminCleanupStats,
    AdminMemoryListResponse,
    AdminLoginRequest,
    AdminMemoryBatchUpdateRequest,
    AdminMemoryBatchUpdateResponse,
    AdminMemoryExportRequest,
    AdminMemoryExportResponse,
    AdminRemoteConfigResponse,
    AdminSyncRequest,
    AdminSyncResponse,
    RemoteScanTaskRead,
)
from app.services.memory_thumbnails import (
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
from app.services.baidu_pan import BaiduPanClient
from app.services.baidu_pan import download_url_cache
from app.services.baidu_oauth import (
    BaiduOAuthError,
    build_baidu_authorize_url,
    create_baidu_oauth_state,
    exchange_baidu_code,
    load_baidu_credentials,
    save_baidu_credentials,
    verify_baidu_oauth_state,
)
from app.services.baidu_sync import (
    create_remote_scan_task,
    refresh_remote_entry,
    run_remote_scan_task,
)

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


def _ensure_remote_memory(memory: Memory) -> Memory:
    if not any(memory_file.source == "baidupan" for memory_file in memory.files):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="回忆不存在",
        )

    return memory


def _collect_cleanup_stats(db: Session, media_root: Path) -> AdminCleanupStats:
    memory_count = db.scalar(select(func.count(Memory.id))) or 0
    memory_file_count = db.scalar(select(func.count(MemoryFile.id))) or 0
    scan_task_count = db.scalar(select(func.count(RemoteScanTask.id))) or 0

    derived_files = 0
    nginx_cache_files = 0
    derived_bytes = 0
    for directory_name in ("thumbnails", "tmp"):
        directory = media_root / directory_name
        if not directory.exists():
            continue
        for path in directory.rglob("*"):
            if path.is_file():
                derived_files += 1
                try:
                    derived_bytes += path.stat().st_size
                except OSError:
                    continue

    nginx_cache_root = Path(get_settings().nginx_cache_root)
    if nginx_cache_root.exists():
        for path in nginx_cache_root.rglob("*"):
            if path.is_file():
                nginx_cache_files += 1
                try:
                    derived_bytes += path.stat().st_size
                except OSError:
                    continue

    return AdminCleanupStats(
        memories=memory_count,
        remote_file_indexes=memory_file_count,
        scan_tasks=scan_task_count,
        thumbnail_files=derived_files,
        nginx_cache_files=nginx_cache_files,
        estimated_bytes_to_free=derived_bytes,
    )


def _remove_derived_media(media_root: Path) -> tuple[int, int, str | None]:
    removed_files = 0
    removed_nginx_cache_files = 0
    for directory_name in ("thumbnails", "tmp"):
        directory = media_root / directory_name
        if not directory.exists():
            continue

        try:
            for path in directory.rglob("*"):
                if path.is_file():
                    removed_files += 1
            shutil.rmtree(directory)
            directory.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return removed_files, removed_nginx_cache_files, str(exc)

    nginx_cache_root = Path(get_settings().nginx_cache_root)
    if nginx_cache_root.exists():
        try:
            for path in nginx_cache_root.rglob("*"):
                if path.is_file():
                    removed_nginx_cache_files += 1
            shutil.rmtree(nginx_cache_root)
            nginx_cache_root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return removed_files, removed_nginx_cache_files, str(exc)

    return removed_files, removed_nginx_cache_files, None


@router.post("/cleanup", response_model=AdminCleanupResponse)
def cleanup_local_media(
    payload: AdminCleanupRequest,
    request: Request,
    db: Session = Depends(get_db),
    _: AdminSession = Depends(require_admin_session),
) -> AdminCleanupResponse:
    """Dry-run first; destructive deletion only happens with explicit confirmation."""

    settings = get_settings()
    media_root = Path(settings.media_root).resolve()
    stats = _collect_cleanup_stats(db, media_root)

    if not payload.confirm:
        return AdminCleanupResponse(dry_run=True, stats=stats)

    started_at = time.perf_counter()
    try:
        db.execute(delete(MemoryFile))
        db.execute(delete(Memory))
        db.execute(delete(RemoteScanTask))
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="本地媒体索引清理失败，数据库已回滚",
        ) from exc

    download_url_cache.clear()
    removed_files, removed_nginx_cache_files, file_cleanup_error = _remove_derived_media(
        media_root,
    )
    duration_seconds = time.perf_counter() - started_at
    record_admin_operation(
        db,
        action="cleanup_local_media",
        client_ip=_client_ip(request),
        detail=(
            f"memories={stats.memories};remote_file_indexes={stats.remote_file_indexes};"
            f"scan_tasks={stats.scan_tasks};derived_files={removed_files};"
            f"nginx_cache_files={removed_nginx_cache_files};"
            "remote_resource=untouched"
        ),
    )

    return AdminCleanupResponse(
        dry_run=False,
        stats=stats,
        duration_seconds=round(duration_seconds, 3),
        completed_at=datetime.now(timezone.utc),
        file_cleanup_error=file_cleanup_error,
    )


@router.get("/remote-config", response_model=AdminRemoteConfigResponse)
def get_remote_config(
    _: AdminSession = Depends(require_admin_session),
) -> AdminRemoteConfigResponse:
    settings = get_settings()
    credentials = load_baidu_credentials(settings)
    oauth_configured = bool(
        settings.baidu_oauth_client_id and settings.baidu_oauth_client_secret
    )
    redirect_uri = settings.baidu_oauth_redirect_uri or (
        settings.public_base_url.rstrip("/") + "/admin/baidu/callback"
    )
    return AdminRemoteConfigResponse(
        configured=bool(credentials or settings.baidu_access_token),
        oauth_configured=oauth_configured,
        authorized=credentials is not None,
        scan_dir=settings.baidu_sync_dir,
        redirect_uri=redirect_uri,
        docs_url="https://pan.baidu.com/union/doc/",
        token_expires_at=credentials.expires_at if credentials else None,
    )


@router.get("/baidu/authorize", response_model=AdminBaiduAuthorizeResponse)
def start_baidu_authorization(
    _: AdminSession = Depends(require_admin_session),
) -> AdminBaiduAuthorizeResponse:
    settings = get_settings()
    if not settings.baidu_oauth_client_id or not settings.baidu_oauth_client_secret:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="百度网盘 OAuth AppKey/SecretKey 未配置",
        )

    state = create_baidu_oauth_state(settings)
    try:
        authorize_url = build_baidu_authorize_url(settings, state=state)
    except BaiduOAuthError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    return AdminBaiduAuthorizeResponse(
        authorize_url=authorize_url,
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=600),
    )


@router.post("/baidu/callback", response_model=AdminBaiduCallbackResponse)
def complete_baidu_authorization(
    payload: AdminBaiduCallbackRequest,
    request: Request,
    db: Session = Depends(get_db),
    _: AdminSession = Depends(require_admin_session),
) -> AdminBaiduCallbackResponse:
    settings = get_settings()
    try:
        verify_baidu_oauth_state(settings, payload.state)
        credentials = exchange_baidu_code(settings, payload.code)
        save_baidu_credentials(settings, credentials)
    except BaiduOAuthError as exc:
        record_admin_operation(
            db,
            action="baidu_authorize_failed",
            client_ip=_client_ip(request),
            detail=str(exc),
        )
        db.commit()
        status_code = (
            status.HTTP_400_BAD_REQUEST
            if "授权状态" in str(exc)
            else status.HTTP_502_BAD_GATEWAY
        )
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc

    record_admin_operation(
        db,
        action="baidu_authorize",
        client_ip=_client_ip(request),
        detail=(
            f"scope={credentials.scope or 'unknown'};"
            f"expires_at={credentials.expires_at.isoformat() if credentials.expires_at else 'unknown'}"
        ),
    )
    db.commit()
    return AdminBaiduCallbackResponse(
        authorized=True,
        expires_at=credentials.expires_at,
    )


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
    background_tasks: BackgroundTasks,
    request: Request,
    payload: AdminSyncRequest | None = Body(default=None),
    db: Session = Depends(get_db),
    session_factory: sessionmaker[Session] = Depends(get_session_factory),
    _: AdminSession = Depends(require_admin_session),
) -> AdminSyncResponse:
    request_payload = payload or AdminSyncRequest()
    settings = get_settings()

    if not settings.baidu_access_token:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="百度网盘访问凭证未配置",
        )

    if request_payload.resume_task_id:
        task = db.get(RemoteScanTask, request_payload.resume_task_id)
        if task is None or task.status == RemoteScanStatus.COMPLETED:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="扫描任务不存在或已完成",
            )
    else:
        task = create_remote_scan_task(
            db,
            remote_dir=settings.baidu_sync_dir,
            max_depth=request_payload.max_depth,
            max_items=request_payload.max_items,
            delete_missing=request_payload.delete_missing,
        )

    background_tasks.add_task(
        run_remote_scan_task,
        session_factory,
        task.id,
        lambda: BaiduPanClient(settings),
    )
    record_admin_operation(
        db,
        action="scan_queued",
        client_ip=_client_ip(request),
        detail=(
            f"task={task.id};mode={'async-delete' if task.delete_missing else 'async-keep'}"
        ),
    )

    return AdminSyncResponse(
        discovered=task.discovered,
        matched=task.refreshed,
        deleted=0,
        failed=0,
        scan_task=RemoteScanTaskRead.model_validate(task),
    )


@router.get("/remote-scan/latest", response_model=RemoteScanTaskRead | None)
def get_latest_remote_scan(
    db: Session = Depends(get_db),
    _: AdminSession = Depends(require_admin_session),
) -> RemoteScanTaskRead | None:
    task = db.scalar(
        select(RemoteScanTask).order_by(RemoteScanTask.started_at.desc())
    )
    return RemoteScanTaskRead.model_validate(task) if task else None


@router.post("/remote-entries/{memory_file_id}/retry", response_model=MemoryRead)
def retry_remote_entry(
    memory_file_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    _: AdminSession = Depends(require_admin_session),
) -> Memory:
    memory_file = db.get(MemoryFile, memory_file_id)
    if memory_file is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="远程条目不存在",
        )

    if memory_file.source != "baidupan":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="只有网盘条目可以刷新远程状态",
        )

    settings = get_settings()
    try:
        memory_file = refresh_remote_entry(
            db,
            BaiduPanClient(settings),
            memory_file,
        )
    except BaiduPanError as exc:
        record_admin_operation(
            db,
            action="remote_retry_failed",
            target_type="memory_file",
            target_id=memory_file.id,
            client_ip=_client_ip(request),
            detail=str(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc

    memory = memory_file.memory or db.get(Memory, memory_file.memory_id)
    if memory is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="回忆不存在",
        )

    record_admin_operation(
        db,
        action="remote_retry",
        target_type="memory_file",
        target_id=memory_file.id,
        client_ip=_client_ip(request),
        detail=memory.title,
    )

    return to_memory_read(memory)


@router.get("/memories", response_model=AdminMemoryListResponse)
def list_admin_memories(
    db: Session = Depends(get_db),
    _: AdminSession = Depends(require_admin_session),
) -> AdminMemoryListResponse:
    statement = (
        select(Memory)
        .join(Memory.files)
        .where(MemoryFile.source == "baidupan")
        .distinct()
    )
    total = db.scalar(select(func.count()).select_from(statement.subquery())) or 0
    memories = db.scalars(statement.order_by(Memory.created_at.desc())).all()

    return AdminMemoryListResponse(
        items=[to_memory_read(memory) for memory in memories], total=total
    )


@router.patch("/memories/batch", response_model=AdminMemoryBatchUpdateResponse)
def batch_update_memories(
    payload: AdminMemoryBatchUpdateRequest,
    request: Request,
    db: Session = Depends(get_db),
    _: AdminSession = Depends(require_admin_session),
) -> AdminMemoryBatchUpdateResponse:
    changes = payload.model_dump(exclude={"ids"}, exclude_unset=True)
    if not changes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="至少选择一个要修改的字段",
        )

    memories = db.scalars(
        select(Memory).where(Memory.id.in_(payload.ids))
    ).all()
    if len(memories) != len(set(payload.ids)):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="部分回忆不存在",
        )

    for memory in memories:
        _ensure_remote_memory(memory)

    for memory in memories:
        for key, value in changes.items():
            setattr(memory, key, value)

    db.commit()
    status_value = changes.get("status")
    action = "batch_update"
    if status_value == MemoryStatus.PUBLISHED:
        action = "batch_publish"
    elif status_value == MemoryStatus.HIDDEN:
        action = "batch_hide"

    record_admin_operation(
        db,
        action=action,
        target_type="memory_batch",
        client_ip=_client_ip(request),
        detail=", ".join(sorted(changes)),
    )
    return AdminMemoryBatchUpdateResponse(updated=len(memories))


@router.post("/memories/export", response_model=AdminMemoryExportResponse)
def export_memories(
    payload: AdminMemoryExportRequest,
    db: Session = Depends(get_db),
    _: AdminSession = Depends(require_admin_session),
) -> AdminMemoryExportResponse:
    memories = db.scalars(
        select(Memory).where(Memory.id.in_(payload.ids))
    ).all()
    if len(memories) != len(set(payload.ids)):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="部分回忆不存在",
        )

    for memory in memories:
        _ensure_remote_memory(memory)

    return AdminMemoryExportResponse(
        exported_at=datetime.now(timezone.utc),
        items=[to_memory_read(memory) for memory in memories],
        total=len(memories),
    )


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

    _ensure_remote_memory(memory)

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

    _ensure_remote_memory(memory)

    # Remote-first deletion removes the local index only; Baidu files stay intact.
    record_admin_operation(
        db,
        action="delete",
        target_type="memory",
        target_id=memory.id,
        client_ip=_client_ip(request),
        detail=f"{memory.title};remote_resource=unchanged",
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
