#!/usr/bin/env python3
"""设计令牌与品牌来源检查(对齐原 pre-commit 内联检查;适配 Rust 前端)。"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def check_frontend_sources() -> None:
    frontend = ROOT / "frontend" / "src"
    forbidden_colors = ("#257", "#7fd", "rgba(")
    allowed_files = {"brand.rs", "index.css"}

    for path in frontend.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix not in {".rs", ".css"}:
            continue
        relative = path.relative_to(ROOT).as_posix()
        text = path.read_text(encoding="utf-8")
        if path.name in allowed_files:
            continue
        if any(color in text for color in forbidden_colors):
            raise SystemExit(f"hardcoded color found: {relative}")
        # 只禁"定义"(令牌后跟冒号赋值);get_property_value 等读取合法
        import re
        if path.name != "brand.rs" and re.search(r"--limedia-[a-z0-9-]+\s*:", text):
            raise SystemExit(f"design token defined or duplicated outside index.css: {relative}")

    css_path = ROOT / "frontend" / "src" / "index.css"
    css = css_path.read_text(encoding="utf-8")
    light_index = css.index(":root {")
    dark_index = css.index(".dark {")
    base_index = css.index("@layer base {")
    light_section = css[light_index:dark_index]
    dark_section = css[dark_index:base_index]
    required_tokens = (
        "--limedia-bg",
        "--limedia-surface",
        "--limedia-surface-2",
        "--limedia-fg",
        "--limedia-muted",
        "--limedia-border",
        "--limedia-primary",
    )
    for token in required_tokens:
        if token not in light_section or token not in dark_section:
            raise SystemExit(f"missing {token} in light and dark token sections")


if __name__ == "__main__":
    check_frontend_sources()
    print("design tokens and brand sources OK")
