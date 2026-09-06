"""Generate a small real video and record single-frame derivative metrics."""

from __future__ import annotations

import json
import subprocess
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.models.memory import MemoryKind
from app.services.memory_thumbnails import create_memory_derivative
from app.services.resource_metrics import collect_resource_metrics
from app.services.task_limits import TaskType, task_limiter, task_metrics


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="limedia-baseline-") as directory:
        root = Path(directory)
        source = root / "small.mp4"
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
                "testsrc=size=320x180:rate=15",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                str(source),
            ],
            check=True,
            capture_output=True,
        )

        samples: list[dict[str, object]] = []
        for max_size in (240, 480, 1280):
            started = time.perf_counter()
            result = create_memory_derivative(
                source,
                root,
                kind=MemoryKind.VIDEO,
                memory_id=uuid.uuid4(),
                max_size=max_size,
            )
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            temporary_files = list((root / "tmp").rglob("*")) if (root / "tmp").exists() else []
            samples.append(
                {
                    "size": max_size,
                    "duration_ms": duration_ms,
                    "generated": result is not None,
                    "temporary_files": len(temporary_files),
                }
            )

        concurrent_started = time.perf_counter()

        def run_job(size: int) -> bool:
            with task_limiter.slot(TaskType.DERIVATIVE, priority=1):
                return create_memory_derivative(
                    source,
                    root,
                    kind=MemoryKind.VIDEO,
                    memory_id=uuid.uuid4(),
                    max_size=size,
                ) is not None

        with ThreadPoolExecutor(max_workers=6) as executor:
            concurrent_results = list(
                executor.map(run_job, [240, 480, 768, 1280, 240, 480])
            )
        concurrent_duration_ms = round(
            (time.perf_counter() - concurrent_started) * 1000,
            2,
        )
        temporary_files = list((root / "tmp").rglob("*")) if (root / "tmp").exists() else []

        print(
            json.dumps(
                {
                    "video": {"width": 320, "height": 180, "duration_seconds": 1},
                    "samples": samples,
                    "concurrency": {
                        "limit": 2,
                        "jobs": len(concurrent_results),
                        "completed": sum(concurrent_results),
                        "duration_ms": concurrent_duration_ms,
                        "temporary_files": len(temporary_files),
                        "metrics": task_metrics.snapshot(),
                    },
                    "resources": collect_resource_metrics(root),
                },
                ensure_ascii=False,
            )
        )


if __name__ == "__main__":
    main()
