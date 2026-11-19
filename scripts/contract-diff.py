#!/usr/bin/env python3
"""契约对比:逐字段 diff FastAPI 基线样本与 Go 实现样本。

用法: python3 scripts/contract-diff.py <fastapi_dir> <go_dir>
时间戳统一放宽为 DATETIME(ISISO8601 语义一致即可)。
"""

import json
import sys
from pathlib import Path

DEFAULT_ENDPOINTS = [
    "01-root", "02-healthz", "03-readyz", "05-list-default", "06-list-captured",
    "08-list-keyword", "09-list-video", "10-public-counts",
    "12-detail-photo", "13-detail-video", "14-detail-404",
]

# 随机排序的端点:对比集合与计数,不比顺序。
SET_COMPARE = {"04-recommend", "07-list-random"}


def norm(value):
    if isinstance(value, dict):
        return {k: norm(v) for k, v in value.items()}
    if isinstance(value, list):
        return [norm(v) for v in value]
    if isinstance(value, str) and len(value) >= 20 and value[4] == "-" and value[10] in "T ":
        from datetime import datetime
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
            return "DATETIME"
        except ValueError:
            return value
    return value


def collect_diffs(a, b, path="$"):
    diffs = []
    if isinstance(a, dict) and isinstance(b, dict):
        for key in set(a) | set(b):
            collect_diffs(a.get(key), b.get(key), f"{path}.{key}")
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            diffs.append(f"{path}: len {len(a)} vs {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            collect_diffs(x, y, f"{path}[{i}]")
    elif a != b:
        diffs.append(f"{path}: {a!r} vs {b!r}")
    return diffs


def main() -> int:
    base_a = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/contract-samples/fastapi")
    base_b = Path(sys.argv[2] if len(sys.argv) > 2 else "docs/contract-samples/go-samples")

    failed = 0
    for ep in DEFAULT_ENDPOINTS:
        fa_path, go_path = base_a / f"{ep}.json", base_b / f"{ep}.json"
        if not fa_path.exists() or not go_path.exists():
            print(f"{ep}: SKIP(样本缺失)")
            continue
        fa, go = norm(json.loads(fa_path.read_text())), norm(json.loads(go_path.read_text()))
        if ep in SET_COMPARE:
            items_a, items_b = set(json.dumps(x, sort_keys=True) for x in fa.get("items", [])), \
                set(json.dumps(x, sort_keys=True) for x in go.get("items", []))
            if items_a == items_b and {k: v for k, v in fa.items() if k != "items"} == \
                    {k: v for k, v in go.items() if k != "items"}:
                print(f"{ep}: MATCH(集合语义)")
                continue
        diffs = collect_diffs(fa, go)
        if not diffs:
            print(f"{ep}: MATCH")
        else:
            failed += 1
            print(f"{ep}: DIFF({len(diffs)} 处)")
            for diff in diffs[:8]:
                print(f"   {diff}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
