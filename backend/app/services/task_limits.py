"""Small in-process governor for background and request-scoped media tasks."""

from __future__ import annotations

from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from enum import StrEnum
from threading import Condition, Event, Lock
from time import monotonic
from typing import Any
from uuid import UUID

from app.core.config import get_settings


class TaskType(StrEnum):
    SCAN = "scan"
    DIRECT_PROBE = "direct_probe"
    DERIVATIVE = "derivative"
    PREHEAT = "preheat"
    STREAM = "stream"


class TaskRejected(RuntimeError):
    """Raised when a task cannot enter its bounded queue."""

    def __init__(self, detail: str, retry_after: float = 1) -> None:
        super().__init__(detail)
        self.detail = detail
        self.retry_after = retry_after


class TaskCancelled(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class _TaskPolicy:
    max_active: int
    max_queue: int
    wait_timeout: float


@dataclass(slots=True)
class TaskSlot:
    task_type: TaskType
    started_at: float
    queued_seconds: float = 0.0


@dataclass(slots=True)
class _Waiter:
    priority: int
    sequence: int
    granted: bool = False


@dataclass(slots=True)
class _InFlight:
    event: Event
    result: Any = None
    error: BaseException | None = None
    done: bool = False


class TaskLimiter:
    """Limit active jobs and waiters independently for each task type."""

    def __init__(self) -> None:
        self._condition = Condition()
        self._active: dict[TaskType, int] = dict.fromkeys(TaskType, 0)
        self._waiters: dict[TaskType, list[_Waiter]] = {
            task_type: [] for task_type in TaskType
        }
        self._sequence = 0

    @staticmethod
    def _policy(task_type: TaskType) -> _TaskPolicy:
        settings = get_settings()
        if task_type is TaskType.SCAN:
            return _TaskPolicy(
                settings.scan_concurrency_limit,
                settings.scan_queue_limit,
                settings.scan_wait_timeout_seconds,
            )
        if task_type is TaskType.DIRECT_PROBE:
            return _TaskPolicy(
                settings.direct_probe_concurrency_limit,
                settings.direct_probe_queue_limit,
                settings.direct_probe_wait_timeout_seconds,
            )
        if task_type is TaskType.DERIVATIVE:
            return _TaskPolicy(
                settings.derivative_concurrency_limit,
                settings.derivative_queue_limit,
                settings.derivative_wait_timeout_seconds,
            )
        if task_type is TaskType.PREHEAT:
            return _TaskPolicy(
                settings.preheat_concurrency_limit,
                settings.preheat_queue_limit,
                settings.preheat_wait_timeout_seconds,
            )
        return _TaskPolicy(
            settings.stream_global_concurrency_limit,
            settings.stream_queue_limit,
            settings.stream_wait_timeout_seconds,
        )

    def acquire(
        self,
        task_type: TaskType,
        *,
        priority: int = 50,
        timeout: float | None = None,
        cancel_event: Event | None = None,
    ) -> TaskSlot:
        """Acquire a slot, queueing at most `max_queue` lower-priority jobs."""

        policy = self._policy(task_type)
        timeout = policy.wait_timeout if timeout is None else max(0.0, timeout)
        deadline = monotonic() + timeout

        with self._condition:
            if self._can_start(task_type, priority):
                self._active[task_type] += 1
                task_metrics.record_started(task_type)
                return TaskSlot(task_type, monotonic())

            if len(self._waiters[task_type]) >= policy.max_queue:
                task_metrics.record_rejected(task_type)
                raise TaskRejected(f"{task_type.value} 队列已满，请稍后重试", 1)

            self._sequence += 1
            waiter = _Waiter(priority=priority, sequence=self._sequence)
            self._waiters[task_type].append(waiter)
            self._condition.notify_all()

            try:
                while True:
                    remaining = deadline - monotonic()
                    if remaining <= 0:
                        task_metrics.record_cancelled(task_type)
                        raise TaskRejected(f"{task_type.value} 队列等待超时", 1)

                    if cancel_event is not None and cancel_event.is_set():
                        task_metrics.record_cancelled(task_type)
                        raise TaskCancelled from None

                    self._condition.wait(timeout=min(0.1, remaining))
                    if waiter.granted:
                        task_metrics.record_started(task_type)
                        return TaskSlot(task_type, monotonic(), queued_seconds=timeout - (deadline - monotonic()))
            finally:
                if not waiter.granted:
                    self._waiters[task_type].remove(waiter)

    def release(self, slot: TaskSlot) -> None:
        with self._condition:
            self._active[slot.task_type] = max(0, self._active[slot.task_type] - 1)
            waiters = self._waiters[slot.task_type]
            if waiters and self._active[slot.task_type] < self._policy(slot.task_type).max_active:
                waiter = min(waiters, key=lambda item: (item.priority, item.sequence))
                waiters.remove(waiter)
                waiter.granted = True
                self._active[slot.task_type] += 1
            self._condition.notify_all()

    def _can_start(self, task_type: TaskType, priority: int) -> bool:
        waiters = self._waiters[task_type]
        if self._active[task_type] >= self._policy(task_type).max_active:
            return False
        return not any(waiter.priority <= priority for waiter in waiters)

    def stats(self) -> dict[str, dict[str, int]]:
        with self._condition:
            return {
                task_type.value: {
                    "active": self._active[task_type],
                    "queued": len(self._waiters[task_type]),
                    "limit": self._policy(task_type).max_active,
                    "queue_limit": self._policy(task_type).max_queue,
                }
                for task_type in TaskType
            }

    @contextmanager
    def slot(
        self,
        task_type: TaskType,
        *,
        priority: int = 50,
        timeout: float | None = None,
        cancel_event: Event | None = None,
    ):
        acquired = self.acquire(
            task_type,
            priority=priority,
            timeout=timeout,
            cancel_event=cancel_event,
        )
        try:
            yield acquired
        finally:
            self.release(acquired)


class TaskMetrics:
    def __init__(self) -> None:
        self._lock = Lock()
        self._counters: dict[str, int] = {}
        self._wait_total_ms = 0
        self._child_peak_kbytes = 0

    def record_started(self, task_type: TaskType) -> None:
        self._bump(f"{task_type.value}.started")

    def record_completed(self, task_type: TaskType) -> None:
        self._bump(f"{task_type.value}.completed")

    def record_failed(self, task_type: TaskType) -> None:
        self._bump(f"{task_type.value}.failed")

    def record_cancelled(self, task_type: TaskType) -> None:
        self._bump(f"{task_type.value}.cancelled")

    def record_rejected(self, task_type: TaskType) -> None:
        self._bump(f"{task_type.value}.rejected")

    def record_coalesced(self, task_type: TaskType) -> None:
        self._bump(f"{task_type.value}.coalesced")

    def record_rate_limited(self, task_type: TaskType) -> None:
        self._bump(f"{task_type.value}.baidu_rate_limited")

    def record_wait(self, seconds: float) -> None:
        with self._lock:
            self._wait_total_ms += int(max(0.0, seconds) * 1000)

    def record_child_peak_kbytes(self, value: int) -> None:
        with self._lock:
            self._child_peak_kbytes = max(self._child_peak_kbytes, value)

    def _bump(self, name: str) -> None:
        with self._lock:
            self._counters[name] = self._counters.get(name, 0) + 1

    def snapshot(self) -> dict[str, int | str]:
        with self._lock:
            counters = dict(self._counters)
            wait_total_ms = self._wait_total_ms
            child_peak = self._child_peak_kbytes

        limiters = task_limiter.stats()
        queued = sum(value["queued"] for value in limiters.values())
        active = sum(value["active"] for value in limiters.values())
        return {
            **counters,
            "active_jobs": active,
            "queue_depth": queued,
            "queue_wait_total_ms": wait_total_ms,
            "child_peak_kbytes": child_peak,
        }


class InFlightRegistry:
    """Merge repeated work with the same durable idempotency key."""

    def __init__(self) -> None:
        self._tasks: dict[str, _InFlight] = {}
        self._lock = Lock()

    def run(
        self,
        key: str,
        operation: Callable[[], Any],
        *,
        task_type: TaskType,
        wait_timeout: float,
        cancel_event: Event | None = None,
    ) -> Any:
        with self._lock:
            in_flight = self._tasks.get(key)
            if in_flight is None:
                in_flight = _InFlight(Event())
                self._tasks[key] = in_flight
                owner = True
            else:
                owner = False

        if not owner:
            task_metrics.record_coalesced(task_type)
            if not in_flight.event.wait(max(0.0, wait_timeout)):
                raise TaskRejected(f"{task_type.value} 任务仍在执行", 1)
            if not in_flight.done:
                raise TaskRejected(f"{task_type.value} 任务等待超时", 1)
            if in_flight.error is not None:
                raise in_flight.error
            return in_flight.result

        try:
            result = operation()
            in_flight.result = result
            return result
        except BaseException as exc:
            in_flight.error = exc
            raise
        finally:
            with self._lock:
                self._tasks.pop(key, None)
            in_flight.done = True
            in_flight.event.set()

    def contains(self, key: str) -> bool:
        with self._lock:
            return key in self._tasks


_active_temporary_paths: set[str] = set()
_temporary_path_lock = Lock()


def register_temporary_path(path: object) -> None:
    with _temporary_path_lock:
        _active_temporary_paths.add(str(path))


def unregister_temporary_path(path: object) -> None:
    with _temporary_path_lock:
        _active_temporary_paths.discard(str(path))


def is_temporary_path_active(path: object) -> bool:
    with _temporary_path_lock:
        return str(path) in _active_temporary_paths


def derivative_key(memory_id: UUID | str, version: str, max_size: int) -> str:
    return f"{memory_id}:{version}:{max_size}"


def make_cancel_event() -> Event:
    return Event()


task_limiter = TaskLimiter()
task_metrics = TaskMetrics()
in_flight_derivatives = InFlightRegistry()
