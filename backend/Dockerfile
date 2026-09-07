ARG IMAGE_REGISTRY=docker.mirrors.ustc.edu.cn/library/

FROM ${IMAGE_REGISTRY}python:3.12-slim

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
