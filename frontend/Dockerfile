# Leptos 前端:trunk 构建静态产物 + nginx 托管(SPA fallback 与 /api 代理沿用 nginx.conf)。
ARG IMAGE_REGISTRY=docker.m.daocloud.io/library/
ARG RUST_IMAGE=rust:1-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine

FROM ${RUST_IMAGE} AS build
ARG CARGO_NET_GIT_FETCH_WITH_CLI=true
ENV CARGO_NET_GIT_FETCH_WITH_CLI=$CARGO_NET_GIT_FETCH_WITH_CLI
RUN rustup target add wasm32-unknown-unknown \
    && cargo install trunk --locked --version 0.21.14
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
# 依赖层缓存:先空壳构建拉依赖
RUN mkdir src && echo "" > src/lib.rs && echo "fn main() {}" > src/main.rs && trunk build || true
COPY . .
RUN trunk build --release

FROM ${NGINX_IMAGE} AS runtime
COPY --from=build /src/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
