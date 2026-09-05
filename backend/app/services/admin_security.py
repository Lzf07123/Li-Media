import hashlib
import secrets
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.models.admin import AdminSession


class AdminLoginLimitError(RuntimeError):
    def __init__(self, retry_after_seconds: int) -> None:
        self.retry_after_seconds = retry_after_seconds
        super().__init__("管理登录尝试过于频繁")


@dataclass(slots=True)
class LoginAttempt:
    failures: int = 0
    first_failure_at: datetime | None = None
    locked_until: datetime | None = None


class AdminLoginRateLimiter:
    def __init__(self, *, max_attempts: int, base_delay: float, max_delay: float) -> None:
        self.max_attempts = max_attempts
        self.base_delay = base_delay
        self.max_delay = max_delay
        self._attempts: dict[str, LoginAttempt] = {}
        self._lock = threading.Lock()

    def check(self, client_key: str) -> None:
        now = datetime.now(timezone.utc)
        with self._lock:
            attempt = self._attempts.get(client_key)
            if attempt and attempt.locked_until and attempt.locked_until > now:
                raise AdminLoginLimitError(
                    max(1, int((attempt.locked_until - now).total_seconds()))
                )

    def record_failure(self, client_key: str) -> float:
        now = datetime.now(timezone.utc)
        with self._lock:
            attempt = self._attempts.setdefault(client_key, LoginAttempt())
            if (
                attempt.first_failure_at is None
                or now - attempt.first_failure_at >= timedelta(minutes=15)
            ):
                attempt.first_failure_at = now
                attempt.failures = 0

            attempt.failures += 1
            delay = min(self.base_delay * (2 ** (attempt.failures - 1)), self.max_delay)
            if attempt.failures >= self.max_attempts and attempt.first_failure_at:
                attempt.locked_until = attempt.first_failure_at + timedelta(minutes=15)

            return delay

    def reset(self, client_key: str) -> None:
        with self._lock:
            self._attempts.pop(client_key, None)


admin_login_rate_limiter = AdminLoginRateLimiter(
    max_attempts=get_settings().admin_login_max_attempts,
    base_delay=get_settings().admin_login_base_delay,
    max_delay=get_settings().admin_login_max_delay,
)


def hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_admin_session(
    db: Session,
    settings: Settings,
    *,
    client_ip: str | None,
) -> str:
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=settings.admin_session_ttl_minutes)
    db.execute(delete(AdminSession).where(AdminSession.expires_at < now))
    token = secrets.token_urlsafe(32)
    db.add(
        AdminSession(
            token_hash=hash_session_token(token),
            client_ip=client_ip,
            expires_at=expires_at,
        )
    )
    db.commit()
    return token


def get_valid_admin_session(db: Session, token: str | None) -> AdminSession | None:
    if not token:
        return None

    now = datetime.now(timezone.utc)
    return db.scalar(
        select(AdminSession).where(
            AdminSession.token_hash == hash_session_token(token),
            AdminSession.revoked_at.is_(None),
            AdminSession.expires_at > now,
        )
    )


def revoke_admin_session(db: Session, token: str | None) -> None:
    if not token:
        return

    session = get_valid_admin_session(db, token)
    if session:
        session.revoked_at = datetime.now(timezone.utc)
        db.commit()


def sleep_for_login_delay(delay: float) -> None:
    if delay > 0:
        time.sleep(delay)
