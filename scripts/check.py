#!/usr/bin/env python3
"""Li&Media 质量门禁（Go + Leptos 版）。

宿主无需安装工具链：Go/Rust 检查通过 Docker 开发容器执行；容器未运行时
跳过并给出警告。设计令牌/品牌来源检查复用 check_frontend_sources.py，
compose 语法与空白错误始终校验。

用法:
    python3 scripts/check.py          # 常规门禁（不含 e2e）
    python3 scripts/check.py --e2e    # 追加 Playwright 全量 e2e（需运行中的栈）
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from check_frontend_sources import check_frontend_sources


ROOT = Path(__file__).resolve().parents[1]


def run(command: list[str], *, cwd: Path | None = None) -> None:
    location = cwd if cwd is not None else ROOT
    relative = location.relative_to(ROOT) if location != ROOT else Path(".")
    print(f"\n[check] {' '.join(command)} (cwd: {relative})")
    completed = subprocess.run(command, cwd=location, check=False)
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)


def container_running(name: str) -> bool:
    completed = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", name],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    return completed.returncode == 0 and completed.stdout.strip() == "true"


def check_backend() -> None:
    if not container_running("limedia-go-dev"):
        print("\n[check] 跳过 Go 检查:limedia-go-dev 未运行(见 AGENTS.md 开发环境)")
        return
    run(
        [
            "docker",
            "exec",
            "limedia-go-dev",
            "sh",
            "-c",
            "cd /work && go build ./... && go vet ./... && go test ./... -count=1",
        ]
    )


def check_frontend() -> None:
    if not container_running("limedia-rust-dev"):
        print("\n[check] 跳过 Rust 检查:limedia-rust-dev 未运行(见 AGENTS.md 开发环境)")
        return
    run(
        [
            "docker",
            "exec",
            "limedia-rust-dev",
            "sh",
            "-c",
            "cd /work && cargo check --target wasm32-unknown-unknown && trunk build",
        ]
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Run all Li&Media quality gates.")
    parser.add_argument(
        "--e2e",
        action="store_true",
        help="run Playwright against the running stack (PLAYWRIGHT_BASE_URL)",
    )
    args = parser.parse_args()

    run(["docker", "compose", "config", "--quiet"])
    run(["git", "diff", "--check"])

    print("\n[check] design tokens and brand source")
    check_frontend_sources()
    print("design tokens and brand sources OK")

    check_backend()
    check_frontend()

    if args.e2e:
        run(["npx", "playwright", "test"], cwd=ROOT / "frontend")


if __name__ == "__main__":
    sys.exit(main())
