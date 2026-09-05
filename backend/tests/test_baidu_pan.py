import httpx
import pytest

from app.core.config import Settings
from app.services.baidu_pan import BaiduPanClient, BaiduPanError


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
