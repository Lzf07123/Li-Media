import pytest
from fastapi import HTTPException

from app.models.memory import MemoryKind
from app.services.memory_files import infer_memory_kind


def test_infer_memory_kind_supports_photo() -> None:
    assert infer_memory_kind("photo.jpg", "image/jpeg") == MemoryKind.PHOTO


def test_infer_memory_kind_supports_video() -> None:
    assert infer_memory_kind("clip.mp4", "video/mp4") == MemoryKind.VIDEO


def test_infer_memory_kind_rejects_unsupported_file() -> None:
    with pytest.raises(HTTPException):
        infer_memory_kind("document.pdf", "application/pdf")
