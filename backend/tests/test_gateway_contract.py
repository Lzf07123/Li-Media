from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.skipif(
    not (ROOT / "docker-compose.yml").is_file(),
    reason="backend image does not include the repository-root compose manifest",
)
def test_compose_keeps_only_nginx_on_host_network() -> None:
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    nginx_section = compose.split("  nginx:", 1)[1].split("\n\n", 1)[0]
    backend_section = compose.split("  backend:", 1)[1].split("  db:", 1)[0]
    db_section = compose.split("  db:", 1)[1].split("  redis:", 1)[0]
    redis_section = compose.split("  redis:", 1)[1].split("  nginx:", 1)[0]

    assert "${HTTP_PORT:-8080}:80" in nginx_section
    assert "ports:" not in backend_section
    assert "ports:" not in db_section
    assert "ports:" not in redis_section
    assert "nginx_cache:/app/data/nginx_cache" in backend_section
    # 网关缓存目录必须与 backend 的清理/统计路径同卷同路径
    assert "nginx_cache:/app/data/nginx_cache" in nginx_section
    # 四个生产服务全部自愈；dev profile 的 backend-test 除外
    assert compose.count("restart: unless-stopped") == 4
    # 限流键与审计 IP 依赖代理头还原真实客户端 IP
    assert "--proxy-headers" in backend_section
    assert "--forwarded-allow-ips" in backend_section
    # 显式命名网络，与宿主上其他 compose 项目隔离
    assert "networks:\n      - limedia" in compose


@pytest.mark.skipif(
    not (ROOT / "docker-compose.yml").is_file(),
    reason="backend image does not include the repository-root compose manifest",
)
def test_compose_sets_hard_resource_limits_and_log_rotation() -> None:
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    assert "mem_limit: 256m" in compose
    assert "mem_limit: 384m" in compose
    assert "mem_limit: 128m" in compose
    # 4 个生产服务 + 1 个 dev profile 的容器内测试 runner，全部带硬限。
    assert compose.count("cpus:") == 5
    assert compose.count("pids_limit:") == 5
    assert compose.count("max-size: 5m") == 5
    assert compose.count('max-file: "3"') == 5
    assert "mem_limit: 512m" in compose
    assert 'profiles: ["dev"]' in compose
    assert "ulimits:" not in compose
    assert "RLIMIT_AS" not in compose
    assert "shared_buffers=64MB" in compose
    assert "max_connections=20" in compose


@pytest.mark.skipif(
    not (ROOT / "frontend" / "nginx.conf").is_file(),
    reason="backend image does not include frontend gateway manifests",
)
def test_nginx_excludes_private_media_from_cache() -> None:
    nginx = (ROOT / "frontend" / "nginx.conf").read_text(encoding="utf-8")
    security_headers = (ROOT / "frontend" / "security-headers.conf").read_text(
        encoding="utf-8",
    )

    assert "root /usr/share/nginx/html;" in nginx
    # 缓存目录与 backend 的 NGINX_CACHE_ROOT 同卷同路径
    assert "proxy_cache_path /app/data/nginx_cache" in nginx
    assert "proxy_cache_key" in nginx
    assert "$http_accept" in nginx
    assert "proxy_cache_bypass $limedia_has_authorization $limedia_has_cookie $limedia_random_sort" in nginx
    assert "proxy_no_cache $limedia_has_authorization $limedia_has_cookie $limedia_random_sort" in nginx
    assert 'map "$limedia_has_authorization$limedia_has_cookie$limedia_random_sort" $limedia_list_cache_control' in nginx
    assert '"000" "public, max-age=15, stale-while-revalidate=30";' in nginx
    # 随机洗牌响应不进网关缓存
    assert 'map $arg_sort $limedia_random_sort' in nginx
    assert 'default "no-store";' in nginx
    assert "proxy_hide_header Cache-Control;" in nginx
    assert "add_header Cache-Control $limedia_list_cache_control always;" in nginx
    assert "proxy_cache off" in nginx
    assert "proxy_cache_use_stale error timeout invalid_header updating http_500 http_502 http_503 http_504" in nginx
    assert "proxy_cache_background_update on" in nginx
    assert "open_file_cache max=1000 inactive=30s" in nginx
    assert 'add_header Cache-Control "no-store" always;' in nginx
    assert "limit_req_zone $binary_remote_addr zone=limedia_derivative" in nginx
    assert "limit_req_zone $binary_remote_addr zone=limedia_public_read" in nginx
    # 网关自身 429 必须带 Retry-After（应用层 429 透传，自带该头）
    assert "error_page 429 = @limedia_rate_limited" in nginx
    assert 'add_header Retry-After "1" always;' in nginx
    # HSTS 按 TLS 终结代理传入的协议判断，纯 http 不发（发了也会被忽略）
    assert "map $http_x_forwarded_proto $limedia_hsts" in nginx
    # 无专用分区的公开读端点不得落入无限制兜底分支
    assert "location = /api/v1/memories/preheat-status" in nginx
    assert "location = /api/v1/memories/recommend" in nginx
    assert "location = /api/v1/memories/public-counts" in nginx
    assert nginx.index("\nhttp {") < nginx.index("upstream limedia_backend {")
    assert "\nupstream limedia_backend {" not in nginx
    # Upstream DNS is deferred to the Docker embedded resolver so nginx can start
    # before `backend` is resolvable, and it re-resolves in the background.
    assert "resolver 127.0.0.11 valid=30s ipv6=off;" in nginx
    assert "zone limedia_backend 64k;" in nginx
    assert "server backend:8000 resolve;" in nginx
    assert "X-Content-Type-Options nosniff" in security_headers
    assert "Content-Security-Policy" in security_headers
    assert "include /etc/nginx/security-headers.conf;" in nginx
