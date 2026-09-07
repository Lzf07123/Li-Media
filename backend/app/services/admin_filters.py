"""Shared admin list, count and batch filtering helpers."""

from __future__ import annotations

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.models.memory import (
    BrowserCompatibilityState,
    Memory,
    MemoryFile,
    MemoryKind,
    MemoryStatus,
)
from app.schemas.responses import (
    BrowserCompatibilityCounts,
    DisplayHealthCounts,
    MemoryCounts,
    MemoryStatusCounts,
)
from app.services.display_health import displayable_files_condition


def base_remote_statement() -> object:
    return (
        select(Memory)
        .join(Memory.files)
        .where(MemoryFile.source == "baidupan")
        .distinct()
    )


def add_admin_filters(
    statement,
    *,
    kind: MemoryKind | None = None,
    keyword: str | None = None,
    display: str = "all",
    compatibility: str = "all",
    status: MemoryStatus | None = None,
):
    if kind is not None:
        statement = statement.where(Memory.kind == kind)
    if status is not None:
        statement = statement.where(Memory.status == status)
    if keyword:
        statement = statement.where(
            (Memory.title.ilike(f"%{keyword}%"))
            | (Memory.description.ilike(f"%{keyword}%"))
            | (Memory.location.ilike(f"%{keyword}%"))
        )
    if display == "displayable":
        statement = statement.where(displayable_files_condition())
    elif display == "excluded":
        statement = statement.where(~displayable_files_condition())

    if compatibility != "all":
        statement = statement.where(
            and_(
                Memory.kind == MemoryKind.VIDEO,
                MemoryFile.browser_compatibility
                == BrowserCompatibilityState(compatibility),
            )
        )

    return statement


def count_statement(db: Session, statement) -> int:
    return db.scalar(select(func.count()).select_from(statement.subquery())) or 0


def count_kind(db: Session, statement, kind: MemoryKind) -> int:
    return count_statement(db, statement.where(Memory.kind == kind))


def count_status(db: Session, statement, status: MemoryStatus) -> int:
    return count_statement(db, statement.where(Memory.status == status))


def count_displayable(db: Session, statement, *, displayable: bool) -> int:
    condition = displayable_files_condition()
    return count_statement(db, statement.where(condition if displayable else ~condition))


def count_browser_state(db: Session, statement, state: BrowserCompatibilityState) -> int:
    return count_statement(
        db,
        statement.where(
            Memory.kind == MemoryKind.VIDEO,
            MemoryFile.browser_compatibility == state,
        ),
    )


def collect_counts(db: Session, statement) -> dict[str, object]:
    total = count_statement(db, statement)
    photo = count_kind(db, statement, MemoryKind.PHOTO)
    published = count_status(db, statement, MemoryStatus.PUBLISHED)
    displayable = count_displayable(db, statement, displayable=True)
    supported = count_browser_state(
        db,
        statement,
        BrowserCompatibilityState.SUPPORTED,
    )
    unsupported = count_browser_state(
        db,
        statement,
        BrowserCompatibilityState.UNSUPPORTED,
    )
    video_total = count_kind(db, statement, MemoryKind.VIDEO)
    return {
        "total": total,
        "counts": MemoryCounts(photo=photo, video=total - photo),
        "status_counts": MemoryStatusCounts(
            published=published,
            unpublished=total - published,
        ),
        "display_counts": DisplayHealthCounts(
            displayable=displayable,
            excluded=total - displayable,
        ),
        "browser_counts": BrowserCompatibilityCounts(
            supported=supported,
            unsupported=unsupported,
            unknown=video_total - supported - unsupported,
        ),
    }
