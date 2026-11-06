ARG IMAGE_REGISTRY=docker.mirrors.ustc.edu.cn/library/

FROM ${IMAGE_REGISTRY}python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

ARG APT_MIRROR=http://mirrors.ustc.edu.cn
ARG PIP_INDEX_URL=https://mirrors.ustc.edu.cn/pypi/simple
ENV PIP_INDEX_URL=$PIP_INDEX_URL

RUN sed -i "s|http://deb.debian.org|${APT_MIRROR}|g; s|http://security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
COPY . .
RUN pip install --no-cache-dir .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

# 测试镜像：在 runtime 之上补 pytest（pyproject dev extra），供
# `docker compose --profile dev run --rm backend-test` 在容器内跑测试。
# compose/nginx 契约测试依赖仓库根清单，在镜像内按既有 skipif 跳过。
FROM runtime AS test

RUN pip install --no-cache-dir .[dev]
