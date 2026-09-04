from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_healthz_returns_ok() -> None:
    response = client.get("/api/v1/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_root_returns_service_info() -> None:
    response = client.get("/api/v1/")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["api_docs"] == "/api/docs"
