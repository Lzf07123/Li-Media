"""预热端到端基准：本地源直接驱动 run_thumbnail_preheat，可在容器内复现。

用法（backend 镜像内，挂载仓库 scripts/）：
    docker compose run --rm --no-deps \
      -v "$(pwd)/scripts:/mnt/scripts:ro" \
      backend python /mnt/scripts/preheat_baseline.py \
      --photos 24 --videos 6 --sizes 240,480 --concurrency 2

无百度凭据也可运行：候选一律使用本地 source_path，远端客户端仅做构造
校验（settings 提供 benchmark-token）。输出 JSON 到 stdout，供
docs/preheat-baseline.md 固化对比。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
import time
from pathlib import Path
from uuid import UUID, uuid4

from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import Settings
from app.db.session import Base
from app.models.memory import (
    BrowserCompatibilityState,
    Memory,
    MemoryFile,
    MemoryKind,
    MemoryStatus,
    RemoteFileState,
    RemoteThumbnailState,
    RemoteStreamState,
)
from app.services.resource_metrics import collect_resource_metrics
from app.services.task_limits import task_metrics
from app.services.thumbnail_preheat import (
    ThumbnailPreheatRegistry,
    run_thumbnail_preheat,
)


def generate_photo(root: Path, index: int) -> Path:
    """生成一张 1600x1067 的确定性渐变 JPEG，模拟真实照片解码成本。"""

    width, height = 1600, 1067
    image = Image.new("RGB", (width, height))
    pixels = image.load()
    for y in range(0, height, 4):
        for x in range(0, width, 4):
            value = (x * 255 // width, y * 255 // height, (x + y + index * 31) % 256)
            for dy in range(4):
                for dx in range(4):
                    if x + dx < width and y + dy < height:
                        pixels[x + dx, y + dy] = value
    path = root / f"photo-{index}.jpg"
    image.save(path, format="JPEG", quality=88)
    return path


def generate_video(root: Path, index: int) -> Path:
    """生成 2 秒 640x360 testsrc 视频，覆盖 ffmpeg 取帧路径。"""

    path = root / f"video-{index}.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            f"testsrc=size=640x360:rate=15:duration=2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return path


def seed_database(
    session_factory: sessionmaker,
    media_root: Path,
    photo_paths: list[Path],
    video_paths: list[Path],
) -> int:
    """按公开口径种库：PUBLISHED + 远端 READY + 本地 source_path。"""

    entries: list[tuple[MemoryKind, Path]] = [
        (MemoryKind.PHOTO, path) for path in photo_paths
    ] + [(MemoryKind.VIDEO, path) for path in video_paths]

    with session_factory.begin() as session:
        for index, (kind, source_path) in enumerate(entries):
            memory_id = UUID(int=index + 1, version=4)
            relative_source = source_path.relative_to(media_root).as_posix()
            memory = Memory(
                id=memory_id,
                title=f"benchmark-{kind.value}-{index}",
                kind=kind,
                status=MemoryStatus.PUBLISHED,
                captured_at=datetime_staggered(index),
                duration_seconds=2 if kind == MemoryKind.VIDEO else None,
            )
            session.add(memory)
            session.add(
                MemoryFile(
                    memory_id=memory.id,
                    source="baidupan",
                    remote_id=f"benchmark-{index}",
                    remote_path=f"/cloud/{source_path.name}",
                    parent_path="/cloud",
                    filename=source_path.name,
                    mime_type=(
                        "image/jpeg" if kind == MemoryKind.PHOTO else "video/mp4"
                    ),
                    source_path=relative_source,
                    remote_state=RemoteFileState.READY,
                    thumbnail_state=RemoteThumbnailState.MISSING,
                    stream_state=RemoteStreamState.READY,
                    browser_compatibility=BrowserCompatibilityState.SUPPORTED,
                )
            )
    return len(entries)


def datetime_staggered(index: int):
    from datetime import datetime, timedelta, timezone

    return datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=index)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--photos", type=int, default=24)
    parser.add_argument("--videos", type=int, default=6)
    parser.add_argument("--sizes", type=str, default="240,480")
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--queue-limit", type=int, default=64)
    parser.add_argument("--derivative-concurrency", type=int, default=1)
    args = parser.parse_args()

    sizes = tuple(
        dict.fromkeys(int(size) for size in args.sizes.split(",") if size.strip())
    ) or (240,)

    with tempfile.TemporaryDirectory(prefix="limedia-preheat-bench-") as directory:
        root = Path(directory)
        media_root = root / "media"
        sources_dir = media_root / "sources"
        sources_dir.mkdir(parents=True)

        photo_paths = [generate_photo(sources_dir, index) for index in range(args.photos)]
        video_paths = [generate_video(sources_dir, index) for index in range(args.videos)]

        engine = create_engine(f"sqlite:///{root / 'bench.db'}")
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

        settings = Settings(
            media_root=str(media_root),
            baidu_access_token="benchmark-token",
            preheat_concurrency_limit=max(1, args.concurrency),
            preheat_queue_limit=max(0, args.queue_limit),
            derivative_concurrency_limit=max(1, args.derivative_concurrency),
        )

        total = seed_database(session_factory, media_root, photo_paths, video_paths)

        registry = ThumbnailPreheatRegistry()
        job, started = registry.start(
            sizes=sizes,
            kind=None,
            limit=0,
            concurrency=settings.preheat_concurrency_limit,
            queue_limit=settings.preheat_queue_limit,
        )
        if not started:
            raise SystemExit("预热任务未能启动：注册表已被占用")

        wall_started = time.perf_counter()
        run_thumbnail_preheat(
            job.id,
            session_factory=session_factory,
            settings=settings,
            registry=registry,
        )
        wall_seconds = time.perf_counter() - wall_started

        latest = registry.get(job.id)
        report = {
            "config": {
                "photos": args.photos,
                "videos": args.videos,
                "sizes": list(sizes),
                "preheat_concurrency": settings.preheat_concurrency_limit,
                "preheat_queue_limit": settings.preheat_queue_limit,
                "derivative_concurrency": settings.derivative_concurrency_limit,
            },
            "wall_seconds": round(wall_seconds, 3),
            "throughput_items_per_second": round(total / wall_seconds, 2)
            if wall_seconds > 0
            else None,
            "job": {
                "status": latest.status if latest else None,
                "total": latest.total if latest else 0,
                "processed": latest.processed if latest else 0,
                "generated": latest.generated if latest else 0,
                "cached": latest.cached if latest else 0,
                "failed": latest.failed if latest else 0,
                "skipped": latest.skipped if latest else 0,
                "source_bytes_downloaded": latest.source_bytes_downloaded if latest else 0,
                "derivative_duration_ms": latest.derivative_duration_ms if latest else 0,
                "size_results": latest.size_results if latest else {},
                "message": latest.message if latest else None,
            },
            "task_metrics": task_metrics.snapshot(),
            "resources": collect_resource_metrics(media_root),
        }

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
