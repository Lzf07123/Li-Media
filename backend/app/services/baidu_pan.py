from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import PurePosixPath
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx

from app.core.config import Settings, get_settings
from app.services.baidu_oauth import get_baidu_access_token


MEDIA_USER_AGENT = "netdisk; BaiduNetdisk"


class BaiduPanError(RuntimeError):
    """Raised when Baidu Pan returns an unusable response."""


@dataclass(frozen=True, slots=True)
class BaiduRemoteItem:
    remote_id: str
    remote_path: str
    filename: str
    parent_path: str
    is_dir: bool
    size_bytes: int | None
    modified_at: datetime | None
    md5: str | None
    category: str | None
    thumbnail_url: str | None
    raw_metadata_summary: dict[str, object]


@dataclass(frozen=True, slots=True)
class BaiduListPage:
    items: list[BaiduRemoteItem]
    next_start: int | None


class DownloadUrlCache:
    """Process-local cache for Baidu links; links must never reach storage."""

    def __init__(self, ttl_seconds: int) -> None:
        self._ttl_seconds = ttl_seconds
        self._urls: dict[str, tuple[str, float]] = {}

    def get(self, remote_id: str) -> str | None:
        entry = self.get_entry(remote_id)
        return entry[0] if entry else None

    def get_entry(self, remote_id: str) -> tuple[str, int] | None:
        entry = self._urls.get(remote_id)
        if entry is None:
            return None

        url, expires_at = entry
        if time.monotonic() >= expires_at:
            self._urls.pop(remote_id, None)
            return None

        return url, max(0, int(expires_at - time.monotonic()))

    def set(self, remote_id: str, url: str) -> str:
        if self._ttl_seconds <= 0:
            self._urls.pop(remote_id, None)
            return url

        self._urls[remote_id] = (
            url,
            time.monotonic() + max(1, self._ttl_seconds - 5),
        )
        return url

    def invalidate(self, remote_id: str) -> None:
        self._urls.pop(remote_id, None)

    def clear(self) -> None:
        self._urls.clear()

    def size(self) -> int:
        return len(self._urls)


download_url_cache = DownloadUrlCache(
    get_settings().baidu_download_url_ttl_seconds
)


class BaiduStreamResponse:
    """Small facade so route handlers cannot touch the underlying URL."""

    def __init__(self, response: httpx.Response, context: object) -> None:
        self._response = response
        self._context = context

    def iter_bytes(self):
        yield from self._response.iter_bytes()

    def close(self) -> None:
        close = getattr(self._context, "close", None)
        if callable(close):
            close()


class BaiduPanClient:
    def __init__(self, settings: Settings) -> None:
        access_token = get_baidu_access_token(settings)
        if not access_token:
            raise BaiduPanError("百度网盘访问凭证缺失")

        self._settings = settings.model_copy(
            update={"baidu_access_token": access_token}
        )
        self._last_request_at: float | None = None

    def list_page(
        self,
        remote_dir: str,
        *,
        start: int,
        limit: int | None = None,
    ) -> BaiduListPage:
        page_size = limit or self._settings.baidu_sync_page_size
        payload = self._get(
            "file",
            {
                "method": "list",
                "dir": remote_dir,
                "limit": page_size,
                "start": start,
                "web": "1",
            },
        )
        page = payload.get("list", [])
        items = [self._to_remote_item(item) for item in page]
        next_start = start + len(page) if len(page) == page_size else None
        return BaiduListPage(items=items, next_start=next_start)

    def get_file_metadata(self, remote_id: str) -> BaiduRemoteItem:
        try:
            fsids = json.dumps([int(remote_id)], separators=(",", ":"))
        except (TypeError, ValueError) as exc:
            raise BaiduPanError("百度网盘文件 ID 无效") from exc

        payload = self._get(
            "multimedia",
            {
                "method": "filemetas",
                "fsids": fsids,
                "dlink": "1",
                "thumb": "1",
            },
        )
        files = payload.get("list", [])

        if not files:
            raise BaiduPanError("远程文件不存在")

        return self._to_remote_item(files[0])

    def get_thumbnail(
        self,
        remote_id: str,
        *,
        requested_size: str = "medium",
    ) -> tuple[bytes, str]:
        metadata = self.get_file_metadata(remote_id)

        if not metadata.thumbnail_url:
            raise BaiduPanError("远程缩略图不可用")

        size_map = {
            "small": "c320_u320",
            "medium": "c640_u640",
            "large": "c1280_u1280",
            "detail": "c1600_u1600",
        }
        thumbnail_url = self._with_requested_thumbnail_size(
            metadata.thumbnail_url,
            size_map.get(requested_size, self._settings.baidu_thumbnail_size),
        )
        try:
            response = httpx.get(
                thumbnail_url,
                headers={"User-Agent": "Li&Media"},
                follow_redirects=True,
                timeout=30,
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise self._transport_error(exc.response) from exc
        except httpx.RequestError as exc:
            raise BaiduPanError("远程缩略图请求失败") from exc

        content_type = response.headers.get("content-type", "image/jpeg").split(";")[0]
        return response.content, content_type or "image/jpeg"

    def open_stream(
        self,
        remote_id: str,
        *,
        range_header: str | None,
    ) -> tuple[int, int | None, str | None, object, BaiduStreamResponse]:
        """Return an iterable response plus metadata for a short-lived link.

        The URL itself is intentionally not returned so callers cannot persist it.
        """

        headers: dict[str, str] = {
            "User-Agent": MEDIA_USER_AGENT,
        }
        if range_header:
            headers["Range"] = range_header

        download_url = self._with_current_access_token(
            self.resolve_download_url(remote_id)
        )
        try:
            stream_context = httpx.stream(
                "GET",
                download_url,
                headers=headers,
                follow_redirects=True,
                timeout=httpx.Timeout(30, read=300),
            )
            opened = stream_context.__enter__()
        except httpx.HTTPError:
            stream_context.close()
            self.invalidate_download_url(remote_id)
            raise BaiduPanError("远程文件暂时无法读取") from None
        except httpx.HTTPError as exc:
            stream_context.close()
            raise BaiduPanError("远程文件暂时无法读取") from exc

        if opened.status_code >= 400:
            stream_context.close()
            self.invalidate_download_url(remote_id)
            raise self._transport_error(opened)

        content_length = opened.headers.get("content-length")
        content_range = opened.headers.get("content-range")
        content_type = opened.headers.get("content-type", "application/octet-stream")
        return (
            opened.status_code,
            int(content_length) if content_length is not None else None,
            content_range,
            content_type,
            BaiduStreamResponse(opened, stream_context),
        )

    def resolve_download_url(self, remote_id: str) -> str:
        cached = download_url_cache.get(remote_id)
        if cached:
            return cached

        metadata = self.get_file_metadata(remote_id)
        if not metadata.raw_metadata_summary.get("has_download_link"):
            raise BaiduPanError("未获取到可用的下载地址")

        # get_file_metadata keeps the raw dlink outside the persisted summary.
        try:
            fsids = json.dumps([int(remote_id)], separators=(",", ":"))
        except (TypeError, ValueError) as exc:
            raise BaiduPanError("百度网盘文件 ID 无效") from exc

        payload = self._get(
            "multimedia",
            {
                "method": "filemetas",
                "fsids": fsids,
                "dlink": "1",
            },
        )
        files = payload.get("list", [])
        if not files or not files[0].get("dlink"):
            raise BaiduPanError("未获取到可用的下载地址")

        return download_url_cache.set(remote_id, str(files[0]["dlink"]))

    def invalidate_download_url(self, remote_id: str) -> None:
        download_url_cache.invalidate(remote_id)

    def resolve_direct_url(self, remote_id: str) -> tuple[str, int]:
        cached = download_url_cache.get_entry(remote_id)
        if cached is not None:
            url, ttl = cached
            if self._probe_direct_url(url):
                return self._with_current_access_token(url), ttl

            self.invalidate_download_url(remote_id)

        url = self.resolve_download_url(remote_id)
        entry = download_url_cache.get_entry(remote_id)
        ttl = entry[1] if entry else max(
            0, self._settings.baidu_download_url_ttl_seconds
        )
        direct_url = self._with_current_access_token(url)

        if not self._probe_direct_url(direct_url):
            self.invalidate_download_url(remote_id)
            raise BaiduPanError("百度网盘媒体直链被拒绝（403）")

        return direct_url, ttl

    def _probe_direct_url(self, url: str) -> bool:
        try:
            with httpx.stream(
                "GET",
                url,
                headers={
                    "Range": "bytes=0-0",
                    "User-Agent": MEDIA_USER_AGENT,
                },
                follow_redirects=True,
                timeout=httpx.Timeout(10, read=15),
            ) as response:
                return response.status_code in {200, 206}
        except httpx.HTTPError:
            return False

    def _to_remote_item(self, item: dict[str, object]) -> BaiduRemoteItem:
        remote_path = str(item["path"])
        parent_path = str(PurePosixPath(remote_path).parent)
        filename = str(
            item.get("server_filename") or PurePosixPath(remote_path).name
        )
        modified_at = (
            datetime.fromtimestamp(int(item["server_mtime"]), tz=timezone.utc)
            if item.get("server_mtime") is not None
            else None
        )
        thumbnail_url = self._extract_thumbnail_url(item)
        has_download_link = bool(item.get("dlink"))

        return BaiduRemoteItem(
            remote_id=str(item["fs_id"]),
            remote_path=remote_path,
            filename=filename,
            parent_path="" if parent_path == "/" else parent_path,
            is_dir=item.get("isdir") == 1,
            size_bytes=int(item["size"]) if item.get("size") is not None else None,
            modified_at=modified_at,
            md5=str(item["md5"]) if item.get("md5") else None,
            category=str(item["category"]) if item.get("category") is not None else None,
            thumbnail_url=thumbnail_url,
            raw_metadata_summary={
                "fs_id": str(item["fs_id"]),
                "is_dir": item.get("isdir") == 1,
                "category": item.get("category"),
                "md5": item.get("md5"),
                "mtime": item.get("server_mtime"),
                "size": item.get("size"),
                "has_thumbnail": thumbnail_url is not None,
                "has_download_link": has_download_link,
            },
        )

    @staticmethod
    def _with_requested_thumbnail_size(url: str, size: str) -> str:
        parsed = urlparse(url)
        query = []
        has_size = False
        for key, value in parse_qsl(parsed.query, keep_blank_values=True):
            if key == "size":
                value = size
                has_size = True
            query.append((key, value))

        if not has_size:
            query.append(("size", size))

        return urlunparse(
            (
                parsed.scheme,
                parsed.netloc,
                parsed.path,
                parsed.params,
                urlencode(query),
                parsed.fragment,
            )
        )

    @staticmethod
    def _extract_thumbnail_url(item: dict[str, object]) -> str | None:
        if isinstance(item.get("thumbs"), dict):
            thumbs = item["thumbs"]
            candidate = thumbs.get("url") or thumbs.get("icon")
            return str(candidate) if candidate else None

        for key in ("thumb_url", "thumbnail", "thumbnail_url"):
            if item.get(key):
                return str(item[key])

        return None

    def _get(self, resource: str, params: dict[str, object]) -> dict[str, object]:
        last_error: Exception | None = None

        for attempt in range(max(1, self._settings.baidu_retry_attempts)):
            self._wait_for_request_interval()
            request_params = {
                **params,
                "access_token": self._settings.baidu_access_token,
            }

            try:
                response = httpx.get(
                    f"{self._settings.baidu_api_base_url}/{resource}",
                    params=request_params,
                    headers={"User-Agent": "Li&Media"},
                    timeout=30,
                )
                response.raise_for_status()
                payload = response.json()
            except httpx.HTTPStatusError as exc:
                last_error = exc
                if not self._should_retry(exc.response):
                    raise self._transport_error(exc.response) from exc
                self._sleep_backoff(attempt)
                continue
            except (httpx.RequestError, ValueError) as exc:
                last_error = exc
                self._sleep_backoff(attempt)
                continue

            errno = payload.get("errno", 0)
            if errno != 0:
                raise self._api_error(int(errno))

            return payload

        if isinstance(last_error, httpx.HTTPStatusError):
            raise self._transport_error(last_error.response) from last_error

        raise BaiduPanError("百度网盘请求失败") from last_error

    def _wait_for_request_interval(self) -> None:
        interval = max(0.0, self._settings.baidu_request_interval_seconds)
        now = time.monotonic()
        if self._last_request_at is not None:
            remaining = interval - (now - self._last_request_at)
            if remaining > 0:
                time.sleep(remaining)

        self._last_request_at = time.monotonic()

    def _sleep_backoff(self, attempt: int) -> None:
        delay = min(
            self._settings.baidu_retry_max_delay,
            self._settings.baidu_retry_base_delay * (2**attempt),
        )
        if delay > 0:
            time.sleep(delay)

    def _with_current_access_token(self, url: str) -> str:
        parsed = httpx.URL(url)
        if parsed.params.get("access_token"):
            return str(parsed)

        return str(
            parsed.copy_merge_params(
                {"access_token": self._settings.baidu_access_token}
            )
        )

    @staticmethod
    def _api_error(errno: int) -> BaiduPanError:
        if errno == -6:
            return BaiduPanError(
                "百度网盘访问凭证无效、过期或授权范围不足"
            )
        if errno == 111:
            return BaiduPanError("百度网盘访问凭证已过期，请重新授权")
        return BaiduPanError(f"百度网盘返回错误 {errno}")

    @staticmethod
    def _should_retry(response: httpx.Response | None) -> bool:
        return response is None or response.status_code in {429, 500, 502, 503, 504}

    @staticmethod
    def _transport_error(response: httpx.Response | None) -> BaiduPanError:
        status_code = response.status_code if response else 0
        if status_code in {401, 403}:
            return BaiduPanError("百度网盘访问凭证无效或已过期")
        if status_code == 429:
            return BaiduPanError("百度网盘接口限流，请稍后重试")
        if status_code == 404:
            return BaiduPanError("远程文件不存在")
        return BaiduPanError("远程媒体暂时无法读取")
