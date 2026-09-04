import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict

from app.models.media import MediaKind, MediaStatus


class MediaRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    original_title: str | None
    kind: MediaKind
    status: MediaStatus
    year: int | None
    overview: str
    rating: Decimal | None
    poster_path: str | None
    backdrop_path: str | None
    created_at: datetime
    updated_at: datetime

