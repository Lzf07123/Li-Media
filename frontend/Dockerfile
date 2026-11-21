# Leptos 前端:trunk 构建静态产物 + nginx 托管(SPA fallback 与 /api 代理沿用 nginx.conf)。
# nginx.conf 是完整主配置(http 块),因此覆盖 /etc/nginx/nginx.conf 而非 conf.d。
ARG IMAGE_REGISTRY=docker.m.daocloud.io/library/
ARG RUST_IMAGE=rust:1-slim
ARG NGINX_IMAGE=nginx:1.27.5-alpine

FROM ${RUST_IMAGE} AS build
ARG CARGO_NET_GIT_FETCH_WITH_CLI=true
ENV CARGO_NET_GIT_FETCH_WITH_CLI=$CARGO_NET_GIT_FETCH_WITH_CLI
RUN rustup target add wasm32-unknown-unknown \
    && cargo install trunk --locked --version 0.21.14
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
# cargo fetch 要求 manifest 至少有一个 target:只放真实入口文件占位,
# 不生成空壳 lib.rs(会与 main.rs 的 mod 声明冲突)。
COPY src/main.rs ./src/main.rs
RUN cargo fetch
COPY . .
RUN trunk build --release

FROM ${NGINX_IMAGE} AS runtime
COPY --from=build /src/dist /usr/share/nginx/html
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/nginx.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
