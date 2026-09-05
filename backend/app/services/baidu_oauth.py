from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from base64 import urlsafe_b64decode, urlsafe_b64encode
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from app.core.config import Settings


class BaiduOAuthError(RuntimeError):
    """Raised when Baidu OAuth cannot produce a usable credential."""


@dataclass(frozen=True, slots=True)
class BaiduCredentials:
    access_token: str
    refresh_token: str | None
    expires_at: datetime | None
    scope: str | None


def create_baidu_oauth_state(settings: Settings, *, lifetime_seconds: int = 600) -> str:
    secret = _state_secret(settings)
    expires_at = int(time.time() + max(60, lifetime_seconds))
    nonce = os.urandom(32)
    payload = f"{nonce.hex()}.{expires_at}".encode()
    signature = hmac.new(secret, payload, hashlib.sha256).digest()
    return urlsafe_b64encode(payload).decode().rstrip("=") + "." + urlsafe_b64encode(signature).decode().rstrip("=")


def verify_baidu_oauth_state(settings: Settings, state: str) -> None:
    secret = _state_secret(settings)
    try:
        encoded_payload, encoded_signature = state.rsplit(".", 1)
        payload = urlsafe_b64decode(encoded_payload + "=" * (-len(encoded_payload) % 4))
        signature = urlsafe_b64decode(encoded_signature + "=" * (-len(encoded_signature) % 4))
        expected_signature = hmac.new(secret, payload, hashlib.sha256).digest()
        nonce_hex, expires_at_text = payload.decode().split(".", 1)
        expires_at = int(expires_at_text)
    except (IndexError, ValueError, UnicodeDecodeError) as exc:
        raise BaiduOAuthError("百度网盘授权状态无效") from exc

    if not hmac.compare_digest(signature, expected_signature):
        raise BaiduOAuthError("百度网盘授权状态无效")
    if len(bytes.fromhex(nonce_hex)) != 32 or time.time() >= expires_at:
        raise BaiduOAuthError("百度网盘授权状态无效或已过期")


def build_baidu_authorize_url(settings: Settings, *, state: str) -> str:
    if not settings.baidu_oauth_client_id:
        raise BaiduOAuthError("百度网盘 OAuth AppKey 未配置")

    redirect_uri = _redirect_uri(settings)
    params: dict[str, object] = {
        "response_type": "code",
        "client_id": settings.baidu_oauth_client_id,
        "redirect_uri": redirect_uri,
        "scope": settings.baidu_oauth_scope,
        "display": "page",
        "state": state,
    }
    return str(httpx.Request("GET", settings.baidu_oauth_authorize_url, params=params).url)


def exchange_baidu_code(settings: Settings, code: str) -> BaiduCredentials:
    payload = _request_token(
        settings,
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": _redirect_uri(settings),
        },
    )
    return _credentials_from_payload(payload)


def load_baidu_credentials(settings: Settings) -> BaiduCredentials | None:
    path = Path(settings.baidu_credentials_path)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        credentials = BaiduCredentials(
            access_token=str(payload["access_token"]),
            refresh_token=(
                str(payload["refresh_token"]) if payload.get("refresh_token") else None
            ),
            expires_at=_parse_datetime(payload.get("expires_at")),
            scope=str(payload["scope"]) if payload.get("scope") else None,
        )
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None

    if not credentials.access_token:
        return None
    return credentials


def get_baidu_access_token(settings: Settings) -> str:
    credentials = load_baidu_credentials(settings)
    if credentials is None:
        return settings.baidu_access_token

    if (
        credentials.expires_at is None
        or credentials.expires_at > datetime.now(timezone.utc) + timedelta(seconds=60)
        or not credentials.refresh_token
    ):
        return credentials.access_token

    try:
        refreshed = _request_token(
            settings,
            {
                "grant_type": "refresh_token",
                "refresh_token": credentials.refresh_token,
            },
        )
        credentials = _credentials_from_payload(refreshed)
        save_baidu_credentials(settings, credentials)
    except (BaiduOAuthError, OSError):
        return credentials.access_token

    return credentials.access_token


def save_baidu_credentials(settings: Settings, credentials: BaiduCredentials) -> None:
    path = Path(settings.baidu_credentials_path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")

    try:
        descriptor = os.open(
            temporary_path,
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as output_file:
            json.dump(
                {
                    "access_token": credentials.access_token,
                    "refresh_token": credentials.refresh_token,
                    "expires_at": (
                        credentials.expires_at.isoformat()
                        if credentials.expires_at
                        else None
                    ),
                    "scope": credentials.scope,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                },
                output_file,
                ensure_ascii=False,
            )
            output_file.flush()
            os.fsync(output_file.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _request_token(
    settings: Settings,
    payload: dict[str, str],
) -> dict[str, object]:
    if not settings.baidu_oauth_client_id or not settings.baidu_oauth_client_secret:
        raise BaiduOAuthError("百度网盘 OAuth AppKey/SecretKey 未配置")

    request_payload = {
        **payload,
        "client_id": settings.baidu_oauth_client_id,
        "client_secret": settings.baidu_oauth_client_secret,
    }

    try:
        response = httpx.get(
            settings.baidu_oauth_token_url,
            params=request_payload,
            headers={"User-Agent": "Li&Media"},
            timeout=30,
        )
        response.raise_for_status()
        result = response.json()
    except httpx.HTTPStatusError as exc:
        raise BaiduOAuthError("百度网盘授权服务返回错误") from exc
    except (httpx.RequestError, ValueError) as exc:
        raise BaiduOAuthError("百度网盘授权服务暂时不可用") from exc

    if result.get("error"):
        raise BaiduOAuthError("百度网盘授权被拒绝，请检查应用配置和权限")
    if not result.get("access_token"):
        raise BaiduOAuthError("百度网盘授权服务未返回访问凭证")

    return result


def _credentials_from_payload(payload: dict[str, object]) -> BaiduCredentials:
    expires_in = payload.get("expires_in")
    expires_at = (
        datetime.now(timezone.utc) + timedelta(seconds=int(expires_in))
        if expires_in is not None
        else None
    )
    return BaiduCredentials(
        access_token=str(payload["access_token"]),
        refresh_token=(
            str(payload["refresh_token"]) if payload.get("refresh_token") else None
        ),
        expires_at=expires_at,
        scope=str(payload["scope"]) if payload.get("scope") else None,
    )


def _redirect_uri(settings: Settings) -> str:
    return settings.baidu_oauth_redirect_uri or (
        settings.public_base_url.rstrip("/") + "/admin/baidu/callback"
    )


def _state_secret(settings: Settings) -> bytes:
    secret = settings.baidu_oauth_client_secret or settings.admin_token
    if not secret:
        raise BaiduOAuthError("百度网盘授权签名密钥未配置")
    return secret.encode()


def _parse_datetime(value: object) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(str(value))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed
