#!/usr/bin/env python3
"""性能基线采集:对核心端点打点,输出 P50/P95/P99 与 RPS 估计。

用法: python3 scripts/perf-baseline.py <base_url> <rounds>
"""

import concurrent.futures
import json
import statistics
import sys
import time
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8001"
ROUNDS = int(sys.argv[2]) if len(sys.argv) > 2 else 200

ENDPOINTS = [
    ("list-default", "/api/v1/memories?page=1&page_size=24"),
    ("list-random", "/api/v1/memories?page=1&page_size=24&sort=random&seed=42"),
    ("recommend", "/api/v1/memories/recommend"),
    ("public-counts", "/api/v1/memories/public-counts"),
    ("detail", "/api/v1/memories/00000000-0000-4000-8000-000000000001"),
]


def fetch_once(path: str) -> float:
    start = time.perf_counter()
    with urllib.request.urlopen(BASE + path, timeout=10) as resp:
        resp.read()
    return (time.perf_counter() - start) * 1000.0


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))
    return ordered[idx]


def main() -> None:
    report: dict[str, dict[str, float]] = {}
    for name, path in ENDPOINTS:
        samples: list[float] = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(fetch_once, path) for _ in range(ROUNDS)]
            samples = [f.result() for f in futures]
        report[name] = {
            "p50_ms": round(statistics.median(samples), 2),
            "p95_ms": round(percentile(samples, 0.95), 2),
            "p99_ms": round(percentile(samples, 0.99), 2),
            "mean_ms": round(statistics.fmean(samples), 2),
            "n": len(samples),
        }
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
