import pytest
from fastapi import HTTPException

from app.models.memory import MemoryKind
from app.services.memory_files import guess_mime_type, infer_memory_kind


def test_infer_memory_kind_supports_photo() -> None:
    assert infer_memory_kind("photo.jpg", "image/jpeg") == MemoryKind.PHOTO


def test_infer_memory_kind_supports_video() -> None:
    assert infer_memory_kind("clip.mp4", "video/mp4") == MemoryKind.VIDEO


def test_infer_memory_kind_rejects_unsupported_file() -> None:
    with pytest.raises(HTTPException):
        infer_memory_kind("document.pdf", "application/pdf")


def test_guess_mime_type_prefers_known_suffix_over_generic_type() -> None:
    assert guess_mime_type("clip.mp4", "application/octet-stream") == "video/mp4"
    assert guess_mime_type("photo.jpg", "image/jpeg") == "image/jpeg"
