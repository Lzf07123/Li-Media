#!/usr/bin/env python3
"""单容器 vs 双容器对比:顺序延迟(避开网关限流)+ wasm 传输 + 资源开销。

用法: python3 -I scripts/perf-compare.py <base_url> <label> [rounds]
"""

import statistics
import sys
import time
import urllib.request

BASE = sys.argv[1]
LABEL = sys.argv[2] if len(sys.argv) > 2 else "run"
ROUNDS = int(sys.argv[3]) if len(sys.argv) > 3 else 40
# 双容器 nginx 限流 10r/s:采样间隔 0.13s(约 7.7r/s)保证两拓扑同条件。
SAMPLE_INTERVAL = 0.25
# 端点切换前冷却,避免上一轮的令牌桶残留导致突发 429。
ENDPOINT_COOLDOWN = 3.0

PATHS = [
    ("list", "/api/v1/memories?page=1&page_size=24"),
    ("recommend", "/api/v1/memories/recommend"),
    ("counts", "/api/v1/memories/public-counts"),
]


def percentile(values, q):
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))
    return ordered[idx]


def timed_get(path, headers=None, retries=3):
    last = None
    for _ in range(retries):
        req = urllib.request.Request(BASE + path, headers=headers or {})
        start = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read()
            return (time.perf_counter() - start) * 1000.0, len(body)
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code == 429:
                time.sleep(1.0)
                continue
            raise
        except Exception as exc:  # 连接被重置等瞬时抖动
            last = exc
            time.sleep(0.5)
    raise last


def main():
    print(f"== {LABEL} ({BASE}) ==")
    for name, path in PATHS:
        time.sleep(ENDPOINT_COOLDOWN)
        # 预热一次(建立连接池/缓存),再顺序采样。
        timed_get(path)
        samples = []
        for _ in range(ROUNDS):
            samples.append(timed_get(path)[0])
            time.sleep(SAMPLE_INTERVAL)
        print(
            f"{name:10s} p50={statistics.median(samples):6.2f}ms "
            f"p95={percentile(samples, 0.95):6.2f}ms mean={statistics.fmean(samples):6.2f}ms"
        )

    # detail 用列表首条真实 id(契约样本 id 在线上库不一定存在)。
    import json
    time.sleep(ENDPOINT_COOLDOWN)
    listing = urllib.request.urlopen(BASE + "/api/v1/memories?page=1&page_size=1", timeout=15).read()
    memory_id = json.loads(listing)["items"][0]["id"]
    detail_path = f"/api/v1/memories/{memory_id}"
    timed_get(detail_path)
    samples = []
    for _ in range(ROUNDS):
        samples.append(timed_get(detail_path)[0])
        time.sleep(SAMPLE_INTERVAL)
    print(
        f"detail     p50={statistics.median(samples):6.2f}ms "
        f"p95={percentile(samples, 0.95):6.2f}ms mean={statistics.fmean(samples):6.2f}ms"
    )

    # wasm 静态传输(带 gzip;双容器走 nginx,单容器走 Go gzip 中间件)
    with urllib.request.urlopen(BASE + "/", timeout=15) as resp:
        html = resp.read().decode("utf-8", "ignore")
    import re
    match = re.search(r"(limedia-frontend-[a-f0-9]+_bg\.wasm)", html)
    if match:
        wasm_path = "/" + match.group(1)
        # 首次(压缩后实际传输字节)
        ms, size = timed_get(wasm_path, headers={"Accept-Encoding": "gzip"})
        print(f"wasm       first-load {ms:7.2f}ms transfer={size/1024/1024:.1f}MB")
        samples = [timed_get(wasm_path, headers={"Accept-Encoding": "gzip"})[0] for _ in range(5)]
        print(f"wasm       warm p50={statistics.median(samples):7.2f}ms")
    else:
        print("wasm       NOT FOUND in index.html")

    # 首页 HTML
    ms, size = timed_get("/", headers={"Accept-Encoding": "gzip"})
    print(f"index.html {ms:7.2f}ms transfer={size/1024:.1f}KB")


if __name__ == "__main__":
    main()
