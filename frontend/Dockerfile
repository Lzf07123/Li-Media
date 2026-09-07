ARG IMAGE_REGISTRY=docker.mirrors.ustc.edu.cn/library/

FROM ${IMAGE_REGISTRY}node:22-alpine AS build

WORKDIR /app

ARG NPM_CONFIG_REGISTRY=https://npmreg.mirrors.ustc.edu.cn/
ARG NPM_FALLBACK_REGISTRY=https://registry.npmmirror.com/
ENV NPM_CONFIG_REGISTRY=$NPM_CONFIG_REGISTRY \
    NPM_FALLBACK_REGISTRY=$NPM_FALLBACK_REGISTRY \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

COPY package.json package-lock.json* ./
RUN set -eux; \
    if ! node -e "fetch(process.env.NPM_CONFIG_REGISTRY, { signal: AbortSignal.timeout(5000) }).catch(() => process.exit(1));"; then \
      echo "primary npm registry unreachable; falling back to $NPM_FALLBACK_REGISTRY"; \
      export NPM_CONFIG_REGISTRY="$NPM_FALLBACK_REGISTRY"; \
    fi; \
    npm ci --registry="$NPM_CONFIG_REGISTRY" --no-audit --no-fund

COPY . .

ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN npm run build

FROM ${IMAGE_REGISTRY}nginx:1.27-alpine

COPY --from=build /app/dist /usr/share/nginx/html
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/nginx.conf
COPY security-headers.conf /etc/nginx/security-headers.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
