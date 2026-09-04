from io import BytesIO
from pathlib import Path

from PIL import Image

from app.models.memory import MemoryKind
from app.services.memory_metadata import read_image_metadata


def test_read_image_metadata_uses_exif(tmp_path: Path) -> None:
    path = tmp_path / "photo.jpg"
    image = Image.new("RGB", (16, 9), "white")
    exif = Image.Exif()
    exif[40091] = "元数据标题".encode("utf-16le")
    exif[270] = "元数据描述".encode("utf-8")
    exif_ifd = exif.get_ifd(0x8769)
    exif_ifd[36867] = "2024:03:04 12:34:56"
    image.save(path, format="JPEG", exif=exif)

    metadata = read_image_metadata(path)

    assert metadata.title == "元数据标题"
    assert metadata.description == "元数据描述"
    assert metadata.captured_at is not None
    assert metadata.captured_at.year == 2024
    assert metadata.width == 16
    assert metadata.height == 9


def test_read_image_metadata_does_not_fail_on_plain_image(tmp_path: Path) -> None:
    path = tmp_path / "plain.png"
    Image.new("RGB", (8, 8), "white").save(path, format="PNG")

    metadata = read_image_metadata(path)

    assert metadata.title is None
    assert metadata.width == 8
    assert metadata.height == 8


def test_bytesio_photo_can_be_saved() -> None:
    image = Image.new("RGB", (4, 4), "white")
    buffer = BytesIO()
    image.save(buffer, format="PNG")

    assert buffer.getvalue().startswith(b"\x89PNG")
