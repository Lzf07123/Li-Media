#!/usr/bin/env bash
# 分阶段构建:先只编译前端 stage(最重的 Rust/trunk 部分),再构建最终镜像。
# 两段共用同一组 build args,BuildKit 会复用前端缓存。
#
# 用法:
#   scripts/build-image.sh                 # 阶段 1 → 阶段 2
#   scripts/build-image.sh --no-frontend   # 只构建后端镜像(前端已缓存)
#   BUILD_JOBS=2 scripts/build-image.sh    # 低配机进一步降低并发
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

skip_frontend=0
if [ "${1:-}" = "--no-frontend" ]; then
    skip_frontend=1
fi

if [ "$skip_frontend" -eq 0 ]; then
    echo "[build] 阶段 1/2:前端(trunk + wasm)"
    docker compose --profile build build frontend-stage
fi

echo "[build] 阶段 2/2:最终镜像(Go + runtime)"
docker compose build backend
