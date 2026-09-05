from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import httpx

from app.core.config import Settings


class BaiduPanError(RuntimeError):
    """Raised when Baidu Pan returns an unusable response."""


@dataclass(frozen=True, slots=True)
class BaiduRemoteFile:
    remote_id: str
    remote_path: str
    filename: str
    size_bytes: int | None
    modified_at: datetime | None


class BaiduPanClient:
    def __init__(self, settings: Settings) -> None:
        if not settings.baidu_access_token:
            raise BaiduPanError("百度网盘访问凭证缺失")

        self._settings = settings

    def list_directory(self, remote_dir: str) -> list[BaiduRemoteFile]:
        items: list[BaiduRemoteFile] = []
        start = 0

        while True:
            payload = self._get(
                "file",
                {
                    "method": "list",
                    "dir": remote_dir,
                    "limit": self._settings.baidu_sync_page_size,
                    "start": start,
                },
            )
            page = payload.get("list", [])

            for item in page:
                if item.get("isdir") == 1:
                    continue

                modified_at = None
                if item.get("server_mtime") is not None:
                    modified_at = datetime.fromtimestamp(
                        int(item["server_mtime"]), tz=timezone.utc
                    )

                items.append(
                    BaiduRemoteFile(
                        remote_id=str(item["fs_id"]),
                        remote_path=str(item["path"]),
                        filename=str(item.get("server_filename") or item["path"]),
                        size_bytes=int(item["size"]) if item.get("size") is not None else None,
                        modified_at=modified_at,
                    )
                )

            if len(page) < self._settings.baidu_sync_page_size:
                break

            start += len(page)

        return items

    def download(
        self,
        remote_id: str,
        target_path: Path,
        *,
        max_bytes: int,
    ) -> int:
        download_url = self._resolve_download_url(remote_id)
        size_bytes = 0

        try:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            with httpx.stream(
                "GET",
                download_url,
                params={"access_token": self._settings.baidu_access_token},
                headers={
                    "Authorization": f"bearer {self._settings.baidu_access_token}",
                    "User-Agent": "Li&Media",
                },
                follow_redirects=True,
                timeout=httpx.Timeout(30, read=300),
            ) as response:
                response.raise_for_status()

                declared_size = response.headers.get("content-length")
                if declared_size and int(declared_size) > max_bytes:
                    raise BaiduPanError("文件超过同步大小限制")

                with target_path.open("wb") as output_file:
                    for chunk in response.iter_bytes():
                        size_bytes += len(chunk)
                        if size_bytes > max_bytes:
                            raise BaiduPanError("文件超过同步大小限制")
                        output_file.write(chunk)
        except Exception:
            target_path.unlink(missing_ok=True)
            raise

        return size_bytes

    def _resolve_download_url(self, remote_id: str) -> str:
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

        return str(files[0]["dlink"])

    def _get(self, resource: str, params: dict[str, object]) -> dict[str, object]:
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
        except (httpx.HTTPError, ValueError) as exc:
            raise BaiduPanError("百度网盘请求失败") from exc

        if payload.get("errno", 0) != 0:
            raise BaiduPanError(f"百度网盘返回错误 {payload.get('errno')}")

        return payload
