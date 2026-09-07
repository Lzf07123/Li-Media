"""Print one JSON snapshot for real-container iteration gates."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import httpx

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.services.system_snapshot import collect_system_snapshot


def fetch_preheat_latest(base_url: str, token: str) -> dict[str, object] | None:
    try:
        with httpx.Client(base_url=base_url, timeout=3) as client:
            login = client.post("/api/v1/admin/login", json={"token": token})
            if login.status_code != 204:
                return None
            response = client.get("/api/v1/admin/thumbnails/preheat/latest")
            if response.status_code != 200:
                return None
            return response.json()
    except httpx.HTTPError:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Collect a Li&Media snapshot.")
    parser.add_argument(
        "--skip-preheat",
        action="store_true",
        help="do not request the local admin API for preheat status",
    )
    args = parser.parse_args()

    settings = get_settings()
    preheat_latest = (
        None
        if args.skip_preheat
        else fetch_preheat_latest(
            "http://127.0.0.1:8000",
            settings.admin_token,
        )
    )
    with SessionLocal() as db:
        snapshot = collect_system_snapshot(
            db,
            Path(settings.media_root),
            preheat_latest=preheat_latest,
        )

    print(json.dumps(snapshot, ensure_ascii=False, default=str, separators=(",", ":")))


if __name__ == "__main__":
    main()
