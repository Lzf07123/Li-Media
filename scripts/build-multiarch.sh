#!/usr/bin/env bash
# 多架构构建:默认 linux/amd64 + linux/arm64。
#
# 前端与 Go 在构建平台(BUILDPLATFORM)编译一次,Go 按 TARGETARCH 交叉编译;
# 只有运行时 apk 安装/打包按目标架构执行。
#
# 用法:
#   docker login uhub.service.ucloud.cn           # 多架构需推送到镜像仓库
#   scripts/build-multiarch.sh                    # 两个架构 → push
#   PLATFORMS=linux/arm64 scripts/build-multiarch.sh   # 单架构 → 本地 load
#   PLATFORMS=linux/amd64,linux/arm64 APP_IMAGE_TAG=v1.2.3 scripts/build-multiarch.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

platforms="${PLATFORMS:-linux/amd64,linux/arm64}"

if [[ "$platforms" == *,* ]]; then
    output=(--push)
else
    output=(--load)
fi

exec docker buildx bake -f docker-compose.yml \
    --set "backend.platform=$platforms" \
    "${output[@]}" \
    backend
