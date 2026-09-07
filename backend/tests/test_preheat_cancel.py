from uuid import uuid4

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
