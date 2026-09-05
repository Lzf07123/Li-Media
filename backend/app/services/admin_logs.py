import uuid

from sqlalchemy.orm import Session

from app.models.admin import AdminOperationLog


def record_admin_operation(
    db: Session,
    *,
    action: str,
    target_type: str | None = None,
    target_id: uuid.UUID | None = None,
    client_ip: str | None = None,
    detail: str | None = None,
) -> None:
    db.add(
        AdminOperationLog(
            action=action,
            target_type=target_type,
            target_id=target_id,
            client_ip=client_ip,
            detail=detail,
        )
    )
    db.commit()
