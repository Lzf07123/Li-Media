import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.memory import Memory, MemoryKind, MemoryStatus
from app.schemas.memory import MemoryRead
from app.schemas.responses import MemoryListResponse

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
        items=memories, total=total, page=page, page_size=page_size
    )


@router.get("/{memory_id}", response_model=MemoryRead)
def get_memory(memory_id: uuid.UUID, db: Session = Depends(get_db)) -> Memory:
    memory = db.get(Memory, memory_id)

    if memory is None or memory.status != MemoryStatus.PUBLISHED:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="memory not found"
        )

    return memory
