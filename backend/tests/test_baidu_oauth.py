from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from collections.abc import Generator

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import Base, get_db
from app.main import app

from app.core.config import Settings
from app.services.baidu_oauth import (
    BaiduCredentials,
    BaiduOAuthError,
    create_baidu_oauth_state,
    exchange_baidu_code,
    save_baidu_credentials,
    verify_baidu_oauth_state,
)


def make_settings(tmp_path: Path) -> Settings:
    return Settings(
        admin_token="test-admin-token",
        public_base_url="http://127.0.0.1:8080",
        baidu_oauth_client_id="test-client-id",
        baidu_oauth_client_secret="test-client-secret",
        baidu_oauth_redirect_uri="http://127.0.0.1:8080/admin/baidu/callback",
        baidu_credentials_path=str(tmp_path / "config" / "baidu_token.json"),
    )


def test_oauth_state_is_signed_and_checked(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    state = create_baidu_oauth_state(settings)

    verify_baidu_oauth_state(settings, state)

    with pytest.raises(BaiduOAuthError, match="百度网盘授权状态无效"):
        verify_baidu_oauth_state(settings, state[:-1] + ("A" if state[-1] != "A" else "B"))


def test_exchange_code_returns_credentials(tmp_path: Path, monkeypatch) -> None:
    settings = make_settings(tmp_path)

    def fake_get(url: str, **kwargs):
        assert url == settings.baidu_oauth_token_url
        assert kwargs["params"]["grant_type"] == "authorization_code"
        assert kwargs["params"]["code"] == "oauth-code"
        assert kwargs["params"]["client_secret"] == "test-client-secret"
        request = httpx.Request("GET", url)
        return httpx.Response(
            200,
            json={
                "access_token": "new-access-token",
                "refresh_token": "new-refresh-token",
                "expires_in": 2592000,
                "scope": "basic netdisk",
            },
            request=request,
        )

    monkeypatch.setattr("app.services.baidu_oauth.httpx.get", fake_get)
    credentials = exchange_baidu_code(settings, "oauth-code")

    assert credentials.access_token == "new-access-token"
    assert credentials.refresh_token == "new-refresh-token"
    assert credentials.scope == "basic netdisk"
    assert credentials.expires_at is not None
    assert credentials.expires_at > datetime.now(UTC)


def test_saved_credentials_use_restricted_permissions(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    credentials = BaiduCredentials(
        access_token="stored-access-token",
        refresh_token="stored-refresh-token",
        expires_at=datetime.now(UTC) + timedelta(days=30),
        scope="basic netdisk",
    )

    save_baidu_credentials(settings, credentials)
    credential_path = Path(settings.baidu_credentials_path)

    assert credential_path.is_file()
    assert credential_path.stat().st_mode & 0o777 == 0o600


def test_admin_baidu_authorization_round_trip(tmp_path: Path, monkeypatch) -> None:
    settings = make_settings(tmp_path)
    monkeypatch.setattr("app.api.v1.admin.get_settings", lambda: settings)

    engine = create_engine(f"sqlite:///{tmp_path / 'memories.db'}")
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def override_get_db() -> Generator[Session, None, None]:
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    def fake_exchange(settings: Settings, code: str):
        assert code == "oauth-code"
        return BaiduCredentials(
            access_token="service-access-token",
            refresh_token="service-refresh-token",
            expires_at=datetime.now(UTC) + timedelta(days=30),
            scope="basic netdisk",
        )

    monkeypatch.setattr(
        "app.api.v1.admin.exchange_baidu_code",
        fake_exchange,
    )
    app.dependency_overrides[get_db] = override_get_db

    try:
        with TestClient(app) as client:
            assert client.post(
                "/api/v1/admin/login",
                json={"token": "test-admin-token"},
            ).status_code == 204

            authorize_response = client.get("/api/v1/admin/baidu/authorize")
            assert authorize_response.status_code == 200
            authorize_url = authorize_response.json()["authorize_url"]
            authorize_query = parse_qs(urlsplit(authorize_url).query)
            assert authorize_query["client_id"] == ["test-client-id"]
            assert authorize_query["redirect_uri"] == [
                "http://127.0.0.1:8080/admin/baidu/callback"
            ]

            callback_response = client.post(
                "/api/v1/admin/baidu/callback",
                json={
                    "code": "oauth-code",
                    "state": authorize_query["state"][0],
                },
            )
            assert callback_response.status_code == 200
            assert callback_response.json()["authorized"] is True
            assert "service-access-token" not in callback_response.text

            config_response = client.get("/api/v1/admin/remote-config")
            assert config_response.status_code == 200
            assert config_response.json()["configured"] is True
            assert config_response.json()["authorized"] is True
            assert config_response.json()["oauth_configured"] is True

        credential_payload = (
            Path(settings.baidu_credentials_path).read_text(encoding="utf-8")
        )
        assert "service-access-token" in credential_payload
    finally:
        app.dependency_overrides.clear()
