from pydantic import BaseModel

from app.schemas.memory import MemoryRead


class MemoryListResponse(BaseModel):
    items: list[MemoryRead]
    total: int
    page: int
    page_size: int
