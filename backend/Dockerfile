# Go 版后端:静态编译单二进制 + alpine 运行镜像(视频派生仍需 ffmpeg)。
# ARG 默认值与 compose 的 IMAGE_REGISTRY 透传对齐;国内网络构建时
# 由 build-arg 覆盖(如 docker.m.daocloud.io/library/)。
ARG IMAGE_REGISTRY=docker.m.daocloud.io/library/
ARG GO_IMAGE=golang:1.23-alpine
ARG RUN_IMAGE=alpine:3.20

FROM ${GO_IMAGE} AS build
ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=$GOPROXY CGO_ENABLED=0
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

FROM ${IMAGE_REGISTRY}alpine:3.20 AS runtime
ARG APT_MIRROR=""
# alpine apk 源可按需切换(默认官方源;USTC 不可达时用 dl-cdn.alpinelinux.org)
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s|https://dl-cdn.alpinelinux.org|${APT_MIRROR}|g" /etc/apk/repositories; fi \
    && apk add --no-cache ffmpeg ca-certificates tzdata
WORKDIR /app
COPY --from=build /out/server /usr/local/bin/server
EXPOSE 8000
CMD ["server"]
