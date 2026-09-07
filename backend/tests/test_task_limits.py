import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from time import sleep

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.session import Base
from app.models.memory import RemoteScanStatus, RemoteScanTask
from app.core.config import Settings
from app.services.task_limits import (
    InFlightRegistry,
    TaskLimiter,
    TaskRejected,
    TaskType,
    derivative_key,
    register_temporary_path,
    task_limiter,
    task_metrics,
    unregister_temporary_path,
)


def configure_limits(monkeypatch, **overrides) -> Settings:
    settings = Settings(**overrides)
    monkeypatch.setattr("app.services.task_limits.get_settings", lambda: settings)
    return settings


def test_queue_rejects_when_full(monkeypatch) -> None:
    configure_limits(
        monkeypatch,
        derivative_concurrency_limit=1,
        derivative_queue_limit=0,
        derivative_wait_timeout_seconds=0,
    )
    limiter = TaskLimiter()
    first = limiter.acquire(TaskType.DERIVATIVE, priority=10)

    with pytest.raises(TaskRejected):
        limiter.acquire(TaskType.DERIVATIVE, priority=20)

    limiter.release(first)
    assert limiter.stats()[TaskType.DERIVATIVE.value]["active"] == 0


def test_task_policy_reads_all_runtime_limits(monkeypatch) -> None:
    settings = configure_limits(
        monkeypatch,
        preheat_concurrency_limit=3,
        preheat_queue_limit=7,
        preheat_wait_timeout_seconds=1.5,
        derivative_concurrency_limit=1,
        derivative_queue_limit=9,
        derivative_wait_timeout_seconds=8.0,
    )
    limiter = TaskLimiter()

    assert limiter.stats()["preheat"] == {
        "active": 0,
        "queued": 0,
        "limit": 3,
        "queue_limit": 7,
        "wait_timeout_seconds": 1.5,
    }
    assert limiter.stats()["derivative"] == {
        "active": 0,
        "queued": 0,
        "limit": 1,
        "queue_limit": 9,
        "wait_timeout_seconds": 8.0,
    }


def test_queue_prioritizes_first_screen_jobs(monkeypatch) -> None:
    configure_limits(
        monkeypatch,
        derivative_concurrency_limit=1,
        derivative_queue_limit=2,
        derivative_wait_timeout_seconds=1,
    )
    limiter = TaskLimiter()
    active = limiter.acquire(TaskType.DERIVATIVE, priority=10)

    with ThreadPoolExecutor(max_workers=2) as executor:
        queued = executor.submit(
            limiter.acquire,
            TaskType.DERIVATIVE,
            priority=20,
        )
        while limiter.stats()[TaskType.DERIVATIVE.value]["queued"] < 1:
            sleep(0.01)

        urgent = executor.submit(
            limiter.acquire,
            TaskType.DERIVATIVE,
            priority=0,
        )
        while limiter.stats()[TaskType.DERIVATIVE.value]["queued"] < 2:
            sleep(0.01)

        with pytest.raises(TaskRejected):
            limiter.acquire(TaskType.DERIVATIVE, priority=20)

        limiter.release(active)
        urgent_slot = urgent.result(1)
        limiter.release(urgent_slot)
        queued_slot = queued.result(1)
        limiter.release(queued_slot)

    assert limiter.stats()[TaskType.DERIVATIVE.value]["queued"] == 0


def test_in_flight_registry_merges_duplicate_work() -> None:
    registry = InFlightRegistry()
    release = threading.Event()
    started = threading.Event()
    calls: list[str] = []

    def operation() -> str:
        calls.append("run")
        started.set()
        release.wait(1)
        return "generated"

    with ThreadPoolExecutor(max_workers=2) as executor:
        owner = executor.submit(
            registry.run,
            derivative_key("memory", "v1", 240),
            operation,
            task_type=TaskType.DERIVATIVE,
            wait_timeout=1,
        )
        started.wait(1)
        follower = executor.submit(
            registry.run,
            derivative_key("memory", "v1", 240),
            operation,
            task_type=TaskType.DERIVATIVE,
            wait_timeout=1,
        )
        release.set()

        assert owner.result(1) == "generated"
        assert follower.result(1) == "generated"
        assert calls == ["run"]


def test_cleanup_skips_active_temporary_file(tmp_path: Path) -> None:
    from app.api.v1.admin import _remove_derived_media

    temporary_dir = tmp_path / "media" / "tmp"
    temporary_dir.mkdir(parents=True)
    active_path = (temporary_dir / "active.tmp").resolve()
    inactive_path = temporary_dir / "inactive.tmp"
    active_path.write_bytes(b"active")
    inactive_path.write_bytes(b"inactive")
    register_temporary_path(active_path)

    try:
        removed_files, _, error = _remove_derived_media(tmp_path / "media")
        assert removed_files == 1
        assert error is None
        assert active_path.is_file()
        assert not inactive_path.exists()
    finally:
        unregister_temporary_path(active_path)


def test_remote_scan_does_not_run_concurrently(monkeypatch, tmp_path: Path) -> None:
    from app.services.baidu_sync import create_remote_scan_task, run_remote_scan_task

    configure_limits(
        monkeypatch,
        scan_concurrency_limit=1,
        scan_queue_limit=0,
        scan_wait_timeout_seconds=0,
    )
    engine = create_engine(f"sqlite:///{tmp_path / 'scan.db'}")
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine)

    class Client:
        def list_page(self, remote_dir, *, start, limit=None):
            from app.services.baidu_pan import BaiduListPage

            return BaiduListPage(items=[], next_start=None)

    with session_factory() as db:
        task = create_remote_scan_task(
            db,
            remote_dir="/apps/Li&Media",
            max_depth=1,
            max_items=10,
            delete_missing=False,
        )

    with task_limiter.slot(TaskType.SCAN):
        run_remote_scan_task(session_factory, task.id, Client)

    with session_factory() as db:
        assert db.get(RemoteScanTask, task.id).status == RemoteScanStatus.RUNNING

    run_remote_scan_task(session_factory, task.id, Client)
    with session_factory() as db:
        assert db.get(RemoteScanTask, task.id).status == RemoteScanStatus.COMPLETED
