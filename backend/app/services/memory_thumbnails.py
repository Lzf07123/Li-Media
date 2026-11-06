import io
import subprocess
from collections.abc import Sequence
from resource import RUSAGE_CHILDREN, getrusage
from pathlib import Path
from uuid import UUID, uuid4

from PIL import Image, ImageOps

from app.core.config import get_settings
from app.models.memory import DerivativeFailureKind, MemoryKind
from app.services.task_limits import task_metrics
from app.services.task_limits import register_temporary_path, unregister_temporary_path


def resolve_media_path(media_root: Path, relative_path: str) -> Path | None:
    media_root = media_root.resolve()
    target_path = (media_root / relative_path).resolve()

    if not target_path.is_relative_to(media_root):
        return None

    return target_path


def read_image_dimensions(content: bytes) -> tuple[int, int] | None:
    try:
        with Image.open(io.BytesIO(content)) as image:
            image = ImageOps.exif_transpose(image)
            width, height = image.size
    except Exception:
        return None

    return (width, height) if width > 0 and height > 0 else None


def remove_media_file(media_root: Path, relative_path: str | None) -> None:
    if not relative_path:
        return

    target_path = resolve_media_path(media_root, relative_path)
    if target_path is not None and target_path.is_file():
        target_path.unlink()


def derivative_cache_path(
    media_root: Path,
    memory_id: UUID,
    *,
    max_size: int,
    version: str,
) -> Path:
    """Return the isolated cache path for one aspect-preserving derivative."""

    return media_root / "thumbnails" / str(memory_id) / version / f"{max_size}.webp"


def _cleanup_output(output_path: Path, temporary_path: Path) -> None:
    temporary_path.unlink(missing_ok=True)
    output_path.unlink(missing_ok=True)


def classify_derivative_exception(exc: Exception) -> str:
    stderr = getattr(exc, "stderr", b"")
    if isinstance(stderr, bytes):
        stderr = stderr.decode("utf-8", errors="ignore")
    message = f"{exc} {stderr}".lower()

    if isinstance(exc, subprocess.TimeoutExpired):
        return DerivativeFailureKind.TIMEOUT.value
    if "moov atom not found" in message:
        return DerivativeFailureKind.MOV_MOOV.value
    if "invalid data found" in message or "no video" in message:
        return DerivativeFailureKind.CODEC_UNSUPPORTED.value
    if isinstance(exc, Image.UnidentifiedImageError):
        return DerivativeFailureKind.FORMAT_UNSUPPORTED.value
    if isinstance(exc, OSError):
        return DerivativeFailureKind.TEMPORARY_IO.value
    return DerivativeFailureKind.UNKNOWN.value


def _create_photo_thumbnail(
    source_path: Path,
    output_path: Path,
    temporary_path: Path,
    *,
    max_size: int,
    quality: int,
) -> None:
    if _is_webp_source(source_path):
        _create_photo_thumbnail_with_ffmpeg(
            source_path,
            output_path,
            temporary_path,
            max_size=max_size,
        )
        return

    with Image.open(source_path) as source_image:
        source_image.draft("RGB", (max_size, max_size))
        image = ImageOps.exif_transpose(source_image)

        if image.mode not in {"RGB", "RGBA"}:
            image = image.convert("RGB")

        image.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
        image.save(temporary_path, format="WEBP", quality=quality, method=4)

    temporary_path.replace(output_path)


def _is_webp_source(source_path: Path) -> bool:
    try:
        with source_path.open("rb") as source_file:
            header = source_file.read(12)
    except OSError:
        return False
    return len(header) == 12 and header[:4] == b"RIFF" and header[8:] == b"WEBP"


def _create_photo_thumbnail_with_ffmpeg(
    source_path: Path,
    output_path: Path,
    temporary_path: Path,
    *,
    max_size: int,
) -> None:
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-threads",
        "1",
        "-i",
        str(source_path),
        "-frames:v",
        "1",
        "-map",
        "v:0",
        "-vf",
        (
            f"scale='if(gt(iw,ih),min({max_size},iw),-2)':"
            f"'if(gt(iw,ih),-2,min({max_size},ih))'"
        ),
        str(temporary_path),
    ]

    subprocess.run(command, check=True, capture_output=True, timeout=30)
    task_metrics.record_child_peak_kbytes(getrusage(RUSAGE_CHILDREN).ru_maxrss)
    temporary_path.replace(output_path)


def _create_video_poster(
    source_path: Path,
    output_path: Path,
    temporary_path: Path,
    *,
    duration_seconds: int | None,
    max_size: int,
) -> None:
    start_seconds = max(0.0, get_settings().video_frame_offset_seconds)
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-threads",
        "1",
        "-ss",
        f"{start_seconds:.2f}",
        "-i",
        str(source_path),
        "-frames:v",
        "1",
        "-map",
        "v:0",
        "-vf",
        (
            f"scale='if(gt(iw,ih),min({max_size},iw),-2)':"
            f"'if(gt(iw,ih),-2,min({max_size},ih))'"
        ),
        str(temporary_path),
    ]

    subprocess.run(command, check=True, capture_output=True, timeout=30)
    task_metrics.record_child_peak_kbytes(getrusage(RUSAGE_CHILDREN).ru_maxrss)
    temporary_path.replace(output_path)


def _run_ffmpeg_multi_size(
    source_path: Path,
    max_sizes: Sequence[int],
    outputs: dict[int, Path],
    temporaries: dict[int, Path],
    *,
    start_seconds: float | None,
    quality: int | None,
    failure_sink: dict[str, str] | None,
) -> dict[int, Path | None]:
    """单次 ffmpeg 解码输出多个尺寸；单尺寸产物缺失只影响该尺寸。"""

    results: dict[int, Path | None] = {}
    ordered_sizes = list(max_sizes)
    count = len(ordered_sizes)
    chain = [
        f"[0:v]split={count}"
        + "".join(f"[s{index}]" for index in range(count))
    ]
    for index, max_size in enumerate(ordered_sizes):
        chain.append(
            f"[s{index}]"
            "scale='if(gt(iw,ih),min({max_size},iw),-2)':"
            "'if(gt(iw,ih),-2,min({max_size},ih))'".format(max_size=max_size)
            + f"[o{index}]"
        )

    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-threads",
        "1",
    ]
    if start_seconds:
        command += ["-ss", f"{start_seconds:.2f}"]
    command += ["-i", str(source_path), "-filter_complex", ";".join(chain)]
    for index, max_size in enumerate(ordered_sizes):
        command += ["-map", f"[o{index}]", "-frames:v", "1"]
        if quality is not None:
            command += ["-quality", str(quality)]
        command.append(str(temporaries[max_size]))

    subprocess.run(command, check=True, capture_output=True, timeout=30)
    task_metrics.record_child_peak_kbytes(getrusage(RUSAGE_CHILDREN).ru_maxrss)

    for max_size in ordered_sizes:
        temporary_path = temporaries[max_size]
        try:
            if temporary_path.is_file() and temporary_path.stat().st_size > 0:
                temporary_path.replace(outputs[max_size])
                results[max_size] = outputs[max_size]
                continue
        except OSError as exc:
            _cleanup_output(outputs[max_size], temporary_path)
            results[max_size] = None
            if failure_sink is not None:
                failure_sink.setdefault("kind", classify_derivative_exception(exc))
            continue
        _cleanup_output(outputs[max_size], temporary_path)
        results[max_size] = None
    return results


def _create_photo_thumbnails_with_pil(
    source_path: Path,
    max_sizes: Sequence[int],
    outputs: dict[int, Path],
    temporaries: dict[int, Path],
    *,
    quality: int,
    failure_sink: dict[str, str] | None,
) -> dict[int, Path | None]:
    """单次解码生成多个尺寸：draft 以最大目标尺寸为准，避免上采样。"""

    results: dict[int, Path | None] = {}
    decode_target = max(max_sizes)
    with Image.open(source_path) as source_image:
        source_image.draft("RGB", (decode_target, decode_target))
        image = ImageOps.exif_transpose(source_image)
        if image.mode not in {"RGB", "RGBA"}:
            image = image.convert("RGB")

        for max_size in max_sizes:
            temporary_path = temporaries[max_size]
            try:
                work = image.copy()
                work.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
                work.save(temporary_path, format="WEBP", quality=quality, method=4)
                temporary_path.replace(outputs[max_size])
                results[max_size] = outputs[max_size]
            except Exception as exc:
                _cleanup_output(outputs[max_size], temporary_path)
                results[max_size] = None
                if failure_sink is not None:
                    failure_sink.setdefault(
                        "kind", classify_derivative_exception(exc)
                    )
    return results


def create_memory_derivatives(
    source_path: Path,
    media_root: Path,
    *,
    kind: MemoryKind,
    memory_id: UUID,
    max_sizes: Sequence[int],
    duration_seconds: int | None = None,
    failure_sink: dict[str, str] | None = None,
) -> dict[int, str | None]:
    """一次解码/单次 ffmpeg 生成多个尺寸，返回 {max_size: 相对路径|None}。

    解码级失败（无法开图、ffmpeg 整体失败）使全部尺寸失败；单尺寸保存
    失败只影响该尺寸。供预热批量路径使用，按需请求仍走单尺寸接口。
    """

    settings = get_settings()
    sizes = list(dict.fromkeys(max_sizes))
    outputs: dict[int, Path] = {}
    temporaries: dict[int, Path] = {}
    registered: list[Path] = []
    for max_size in sizes:
        output_path = derivative_cache_path(
            media_root,
            memory_id,
            max_size=max_size,
            version=settings.media_derivative_version,
        )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        outputs[max_size] = output_path
        temporaries[max_size] = output_path.parent / f".{memory_id}.{uuid4().hex}.tmp.webp"
        active_output_path = output_path.resolve()
        registered.append(active_output_path)
        register_temporary_path(active_output_path)

    try:
        if kind == MemoryKind.PHOTO:
            if _is_webp_source(source_path):
                size_results = _run_ffmpeg_multi_size(
                    source_path,
                    sizes,
                    outputs,
                    temporaries,
                    start_seconds=None,
                    quality=settings.thumbnail_quality,
                    failure_sink=failure_sink,
                )
            else:
                size_results = _create_photo_thumbnails_with_pil(
                    source_path,
                    sizes,
                    outputs,
                    temporaries,
                    quality=settings.thumbnail_quality,
                    failure_sink=failure_sink,
                )
        else:
            size_results = _run_ffmpeg_multi_size(
                source_path,
                sizes,
                outputs,
                temporaries,
                start_seconds=max(0.0, settings.video_frame_offset_seconds) or None,
                quality=settings.thumbnail_quality,
                failure_sink=failure_sink,
            )
    except Exception as exc:
        for max_size in sizes:
            _cleanup_output(outputs[max_size], temporaries[max_size])
        if failure_sink is not None:
            failure_sink.setdefault("kind", classify_derivative_exception(exc))
        return {max_size: None for max_size in sizes}
    finally:
        for active_output_path in registered:
            unregister_temporary_path(active_output_path)

    return {
        max_size: (
            outputs[max_size].relative_to(media_root).as_posix()
            if size_results.get(max_size) is not None
            else None
        )
        for max_size in sizes
    }


def create_memory_derivative(
    source_path: Path,
    media_root: Path,
    *,
    kind: MemoryKind,
    memory_id: UUID,
    max_size: int,
    duration_seconds: int | None = None,
    failure_sink: dict[str, str] | None = None,
) -> str | None:
    settings = get_settings()
    output_path = derivative_cache_path(
        media_root,
        memory_id,
        max_size=max_size,
        version=settings.media_derivative_version,
    )
    output_dir = output_path.parent
    temporary_path = output_dir / f".{memory_id}.{uuid4().hex}.tmp.webp"
    output_dir.mkdir(parents=True, exist_ok=True)
    active_output_path = output_path.resolve()
    register_temporary_path(active_output_path)

    try:
        if kind == MemoryKind.PHOTO:
            _create_photo_thumbnail(
                source_path,
                output_path,
                temporary_path,
                max_size=max_size,
                quality=settings.thumbnail_quality,
            )
        else:
            _create_video_poster(
                source_path,
                output_path,
                temporary_path,
                duration_seconds=duration_seconds,
                max_size=max_size,
            )
    except Exception as exc:
        _cleanup_output(output_path, temporary_path)
        if failure_sink is not None:
            failure_sink.setdefault(
                "kind",
                classify_derivative_exception(exc),
            )
        return None

    else:
        return output_path.relative_to(media_root).as_posix()
    finally:
        unregister_temporary_path(active_output_path)


def create_memory_thumbnail(
    source_path: Path,
    media_root: Path,
    *,
    kind: MemoryKind,
    memory_id: UUID,
    duration_seconds: int | None = None,
) -> str | None:
    """Compatibility wrapper for callers that use the configured maximum size."""

    return create_memory_derivative(
        source_path,
        media_root,
        kind=kind,
        memory_id=memory_id,
        max_size=get_settings().thumbnail_max_size,
        duration_seconds=duration_seconds,
    )
