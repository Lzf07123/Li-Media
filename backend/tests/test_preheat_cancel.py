from uuid import uuid4
from contextlib import nullcontext
from threading import Barrier, Event, Lock
from uuid import UUID

from app.services.thumbnail_preheat import (
    ThumbnailPreheatRegistry,
    run_thumbnail_preheat,
)


def test_registry_cancels_active_job_only_once() -> None:
    registry = ThumbnailPreheatRegistry()
    job, _ = registry.start(max_size=240, kind=None, limit=1)

    assert registry.request_cancel(job.id) is True
    assert job.cancel_event.is_set()
    assert registry.request_cancel(job.id) is True

    registry.mark_cancelled(job.id, "processed=0;total=1")
    assert registry.request_cancel(job.id) is False
    assert registry.get(job.id).status == "cancelled"


def test_preheat_uses_configured_worker_bound(monkeypatch) -> None:
    registry = ThumbnailPreheatRegistry()
    job, _ = registry.start(
        max_size=240,
        kind=None,
        limit=0,
        concurrency=3,
        queue_limit=2,
    )
    active = 0
    max_active = 0
    lock = Lock()
    barrier = Barrier(3)

    def process_candidate(_session_factory, **_kwargs):
        nonlocal active, max_active
        with lock:
            active += 1
            max_active = max(max_active, active)
        barrier.wait(timeout=1)
        try:
            return "generated"
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(
        "app.services.thumbnail_preheat._candidate_pairs",
        lambda *_args, **_kwargs: [
            (UUID(int=index), UUID(int=index + 100)) for index in range(6)
        ],
    )
    monkeypatch.setattr(
        "app.services.thumbnail_preheat._process_candidate",
        process_candidate,
    )

    run_thumbnail_preheat(
        job.id,
        session_factory=lambda: nullcontext(None),
        settings=None,
        registry=registry,
    )

    assert max_active == 3
    assert job.processed == 6
    assert job.generated == 6
    assert job.status == "completed"


def test_preheat_cancels_pending_work_without_counting_it(monkeypatch) -> None:
    registry = ThumbnailPreheatRegistry()
    job, _ = registry.start(
        max_size=240,
        kind=None,
        limit=0,
        concurrency=1,
        queue_limit=1,
    )
    processed = 0
    lock = Lock()

    def process_candidate(_session_factory, *, cancel_event, **_kwargs):
        nonlocal processed
        with lock:
            processed += 1
        cancel_event.set()
        return "cancelled"

    monkeypatch.setattr(
        "app.services.thumbnail_preheat._candidate_pairs",
        lambda *_args, **_kwargs: [
            (UUID(int=index), UUID(int=index + 100)) for index in range(4)
        ],
    )
    monkeypatch.setattr(
        "app.services.thumbnail_preheat._process_candidate",
        process_candidate,
    )

    run_thumbnail_preheat(
        job.id,
        session_factory=lambda: nullcontext(None),
        settings=None,
        registry=registry,
    )

    assert processed < 4
    assert job.status == "cancelled"
    assert job.cancel_event.is_set()


def test_run_preheat_returns_immediately_for_cancelled_job(monkeypatch) -> None:
    registry = ThumbnailPreheatRegistry()
    job, _ = registry.start(max_size=240, kind=None, limit=1)
    registry.request_cancel(job.id)

    def fail_candidates(*args, **kwargs):
        raise AssertionError("cancelled job should not enumerate candidates")

    monkeypatch.setattr(
        "app.services.thumbnail_preheat._candidate_pairs",
        fail_candidates,
    )
    run_thumbnail_preheat(
        job.id,
        session_factory=None,
        settings=None,
        registry=registry,
    )

    assert registry.get(job.id).status == "cancelled"
