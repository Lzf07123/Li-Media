import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.media import Media, MediaKind, MediaStatus
from app.schemas.media import MediaRead
from app.schemas.responses import MediaListResponse

router = APIRouter(prefix="/media", tags=["media"])


@router.get("", response_model=MediaListResponse)
def list_media(
    kind: MediaKind | None = None,
    keyword: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=24, ge=1, le=100),
    db: Session = Depends(get_db),
) -> MediaListResponse:
    statement = select(Media).where(Media.status == MediaStatus.PUBLISHED)

    if kind is not None:
        statement = statement.where(Media.kind == kind)

    if keyword:
        statement = statement.where(Media.title.ilike(f"%{keyword}%"))

    count_statement = select(func.count()).select_from(statement.subquery())
    total = db.scalar(count_statement) or 0

    media = db.scalars(
        statement.order_by(Media.updated_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()

    return MediaListResponse(
        items=media, total=total, page=page, page_size=page_size
    )


@router.get("/{media_id}", response_model=MediaRead)
def get_media(media_id: uuid.UUID, db: Session = Depends(get_db)) -> Media:
    media = db.get(Media, media_id)

    if media is None or media.status != MediaStatus.PUBLISHED:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="media not found"
        )

    return media

