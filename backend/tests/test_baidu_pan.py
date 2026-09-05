import httpx
import pytest

from app.core.config import Settings
from app.services.baidu_pan import BaiduPanClient, BaiduPanError, BaiduRemoteItem


@pytest.mark.parametrize(
    ("status_code", "message"),
    [
        (403, "百度网盘访问凭证无效或已过期"),
        (404, "远程文件不存在"),
        (429, "百度网盘接口限流，请稍后重试"),
    ],
)
def test_baidu_http_errors_have_distinct_messages(monkeypatch, status_code, message):
    settings = Settings(
        baidu_access_token="test-access-token",
        baidu_retry_attempts=1,
        baidu_retry_base_delay=0,
    )

    def fake_get(*args, **kwargs):
        request = httpx.Request("GET", "https://pan.baidu.com/rest/2.0/xpan/file")
        return httpx.Response(status_code, request=request)

    monkeypatch.setattr("app.services.baidu_pan.httpx.get", fake_get)

    with pytest.raises(BaiduPanError, match=message):
        BaiduPanClient(settings)._get("file", {"method": "list"})


@pytest.mark.parametrize(
    ("errno", "message"),
    [
        (-6, "百度网盘访问凭证无效、过期或授权范围不足"),
        (111, "百度网盘访问凭证已过期，请重新授权"),
    ],
)
def test_baidu_api_errors_have_distinct_messages(monkeypatch, errno, message):
    settings = Settings(
        baidu_access_token="test-access-token",
        baidu_retry_attempts=1,
        baidu_retry_base_delay=0,
    )

    def fake_get(*args, **kwargs):
        request = httpx.Request("GET", "https://pan.baidu.com/rest/2.0/xpan/file")
        return httpx.Response(200, json={"errno": errno}, request=request)

    monkeypatch.setattr("app.services.baidu_pan.httpx.get", fake_get)

    with pytest.raises(BaiduPanError, match=message):
        BaiduPanClient(settings)._get("file", {"method": "list"})


def test_thumbnail_request_does_not_append_access_token(monkeypatch):
    settings = Settings(
        baidu_access_token="test-access-token",
        baidu_thumbnail_size="c1600_u1600",
        baidu_oauth_client_id="",
        baidu_oauth_client_secret="",
        baidu_credentials_path="/tmp/limedia-test-baidu-token.json",
    )
    client = BaiduPanClient(settings)
    metadata = BaiduRemoteItem(
        remote_id="123",
        remote_path="/cloud/photo.jpg",
        filename="photo.jpg",
        parent_path="/cloud",
        is_dir=False,
        size_bytes=16,
        modified_at=None,
        md5=None,
        category=None,
        thumbnail_url="https://thumbnail.baidupcs.com/signed-image?size=c60_u60&expires=8h",
        raw_metadata_summary={"has_thumbnail": True},
    )
    requests: list[httpx.Request] = []

    monkeypatch.setattr(
        client,
        "get_file_metadata",
        lambda remote_id: metadata,
    )

    def fake_get(url: str, *, headers: dict[str, str], **kwargs):
        request = httpx.Request("GET", url, headers=headers)
        requests.append(request)
        return httpx.Response(
            200,
            content=b"thumbnail",
            headers={"content-type": "image/jpeg"},
            request=request,
        )

    monkeypatch.setattr("app.services.baidu_pan.httpx.get", fake_get)

    content, content_type = client.get_thumbnail("123")

    assert content == b"thumbnail"
    assert content_type == "image/jpeg"
    assert len(requests) == 1
    assert "test-access-token" not in str(requests[0].url)
    assert "Authorization" not in requests[0].headers
    assert str(requests[0].url).endswith("size=c1600_u1600&expires=8h")
