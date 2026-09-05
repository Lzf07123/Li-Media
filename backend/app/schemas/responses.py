from pydantic import BaseModel, Field

from app.schemas.memory import MemoryRead


class MemoryListResponse(BaseModel):
    items: list[MemoryRead]
    total: int
    page: int
    page_size: int


class AdminMemoryListResponse(BaseModel):
    items: list[MemoryRead]
    total: int


class AdminSyncRequest(BaseModel):
    max_files: int = Field(default=5, ge=1, le=20)


class AdminLoginRequest(BaseModel):
    token: str = Field(min_length=1, max_length=256)


class AdminSyncResponse(BaseModel):
    discovered: int
    matched: int
    failed: int
