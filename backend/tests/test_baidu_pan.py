import httpx
import pytest
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from app.core.config import Settings
from app.services.baidu_pan import (
    BaiduPanClient,
    BaiduPanError,
    BaiduRemoteItem,
    download_url_cache,
)


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
    assert str(requests[0].url).endswith("size=c640_u640&expires=8h")


def test_request_interval_is_serialized_between_threads(monkeypatch):
    settings = Settings(
        baidu_access_token="test-access-token",
        baidu_request_interval_seconds=0.2,
    )
    client = BaiduPanClient(settings)
    clock = {"now": 100.0}
    sleeps: list[float] = []

    def fake_monotonic():
        return clock["now"]

    def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock["now"] += max(seconds, 0.001)

    monkeypatch.setattr("app.services.baidu_pan.time.monotonic", fake_monotonic)
    monkeypatch.setattr("app.services.baidu_pan.time.sleep", fake_sleep)

    workers = 3
    barrier = Barrier(workers)

    def wait_for_interval():
        barrier.wait(timeout=1)
        client._wait_for_request_interval()

    with ThreadPoolExecutor(max_workers=workers) as executor:
        list(executor.map(lambda _: wait_for_interval(), range(workers)))

    assert len(sleeps) == workers - 1
    assert all(delay == 0.2 for delay in sleeps)


def test_thumbnail_request_supports_detail_size(monkeypatch):
    settings = Settings(
        baidu_access_token="test-access-token",
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
    client.get_thumbnail("123", requested_size="detail")

    assert str(requests[0].url).endswith("size=c1600_u1600&expires=8h")


def test_open_stream_reuses_url_token_and_closes_context(monkeypatch):
    settings = Settings(baidu_access_token="test-access-token")
    client = BaiduPanClient(settings)

    class FakeStream:
        def __init__(self) -> None:
            self.closed = False

        def __enter__(self):
            return httpx.Response(
                206,
                content=b"ab",
                headers={
                    "content-range": "bytes 0-1/3",
                    "content-length": "2",
                    "content-type": "video/mp4",
                },
            )

        def close(self) -> None:
            self.closed = True

    fake_stream = FakeStream()
    stream_contexts = [fake_stream]
    requests: list[httpx.Request] = []

    monkeypatch.setattr(
        client,
        "resolve_download_url",
        lambda remote_id: "https://d.pcs.baidu.com/file/demo?access_token=from-url",
    )

    def fake_stream(method: str, url: str, *, headers: dict[str, str], **kwargs):
        assert method == "GET"
        request = httpx.Request(method, url, headers=headers)
        requests.append(request)
        created_stream = FakeStream()
        stream_contexts.append(created_stream)
        return created_stream

    monkeypatch.setattr("app.services.baidu_pan.httpx.stream", fake_stream)
    status_code, length, content_range, content_type, stream = client.open_stream(
        "123",
        range_header="bytes=0-1",
    )
    stream.close()

    assert (status_code, length, content_range, content_type) == (
        206,
        2,
        "bytes 0-1/3",
        "video/mp4",
    )
    assert len(requests) == 1
    assert requests[0].url.params.get_list("access_token") == ["from-url"]
    assert stream_contexts[-1].closed is True


def test_direct_url_refreshes_stale_link_after_403(monkeypatch):
    settings = Settings(baidu_access_token="test-access-token")
    client = BaiduPanClient(settings)
    download_url_cache.set("123", "https://baidu.invalid/stale?access_token=old")
    probes: list[str] = []

    def fake_probe(url: str) -> bool:
        probes.append(url)
        return "fresh" in url

    monkeypatch.setattr(client, "_probe_direct_url", fake_probe)
    monkeypatch.setattr(
        client,
        "resolve_download_url",
        lambda remote_id: "https://baidu.invalid/fresh?access_token=new",
    )

    try:
        url, ttl = client.resolve_direct_url("123")

        assert url == "https://baidu.invalid/fresh?access_token=new"
        assert len(probes) == 2
        assert time.monotonic() + ttl > time.monotonic()
    finally:
        download_url_cache.invalidate("123")
