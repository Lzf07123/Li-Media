from pydantic import BaseModel

from app.schemas.media import MediaRead


class MediaListResponse(BaseModel):
    items: list[MediaRead]
    total: int
    page: int
    page_size: int

