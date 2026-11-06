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
    # 公开端点不暴露接口文档路径等内部信息
    assert "api_docs" not in response.json()


def test_redoc_is_disabled() -> None:
    # redoc 无网关精确封锁，应用层必须关闭
    assert app.redoc_url is None
    response = client.get("/redoc")
    assert response.status_code == 404
