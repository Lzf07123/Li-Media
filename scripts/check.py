from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run(command: list[str], *, cwd: Path) -> None:
    print(f"\n[check] {' '.join(command)} (cwd: {cwd.relative_to(ROOT)})")
    completed = subprocess.run(command, cwd=cwd, check=False)
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)


def check_frontend_sources() -> None:
    frontend = ROOT / "frontend" / "src"
    forbidden_colors = ("#257", "#7fd", "rgba(")
    forbidden_brand_assignments = (
        "libraryTitle:",
        "adminTitle:",
        "adminDescription:",
        "notFoundTitle:",
    )

    for path in frontend.rglob("*"):
        if not path.is_file():
            continue

        if path.suffix not in {".ts", ".tsx", ".css"}:
            continue

        relative = path.relative_to(ROOT).as_posix()
        text = path.read_text(encoding="utf-8")

        if path.name == "brand.ts":
            continue

        if path.suffix in {".ts", ".tsx"}:
            if any(color in text for color in forbidden_colors):
                raise SystemExit(f"hardcoded color found: {relative}")
            if any(assignment in text for assignment in forbidden_brand_assignments):
                raise SystemExit(f"hardcoded brand copy found: {relative}")

        if path.name != "index.css" and "--limedia-" in text:
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


def main() -> None:
    parser = argparse.ArgumentParser(description="Run all Li&Media quality gates.")
    parser.add_argument(
        "--skip-e2e",
        action="store_true",
        help="skip Playwright smoke tests (all other checks still run)",
    )
    args = parser.parse_args()

    backend = ROOT / "backend"
    backend_python = backend / ".venv" / "bin" / "python"
    python_command = (
        [str(backend_python)] if backend_python.is_file() else [sys.executable]
    )
    run([*python_command, "-m", "pytest", "-q"], cwd=backend)
    run(["npm", "run", "typecheck"], cwd=ROOT / "frontend")
    run(["npm", "run", "build"], cwd=ROOT / "frontend")
    run(["docker", "compose", "config", "--quiet"], cwd=ROOT)
    run(["git", "diff", "--check"], cwd=ROOT)

    print("\n[check] design tokens and brand source")
    check_frontend_sources()

    if not args.skip_e2e:
        run(["npx", "playwright", "test"], cwd=ROOT / "frontend")


if __name__ == "__main__":
    main()
