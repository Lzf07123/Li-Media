from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


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


def test_compose_sets_hard_resource_limits_and_log_rotation() -> None:
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    assert "mem_limit: 256m" in compose
    assert "mem_limit: 384m" in compose
    assert "mem_limit: 128m" in compose
    assert compose.count("cpus:") == 4
    assert compose.count("pids_limit:") == 4
    assert compose.count("max-size: 5m") == 4
    assert compose.count('max-file: "3"') == 4
    assert "ulimits:" not in compose
    assert "RLIMIT_AS" not in compose
    assert "shared_buffers=64MB" in compose
    assert "max_connections=20" in compose


def test_nginx_excludes_private_media_from_cache() -> None:
    nginx = (ROOT / "frontend" / "nginx.conf").read_text(encoding="utf-8")
    security_headers = (ROOT / "frontend" / "security-headers.conf").read_text(
        encoding="utf-8",
    )

    assert "root /usr/share/nginx/html;" in nginx
    assert "proxy_cache_path /var/cache/nginx/limedia" in nginx
    assert "proxy_cache_key" in nginx
    assert "$http_accept" in nginx
    assert "proxy_cache_bypass $limedia_has_authorization $limedia_has_cookie" in nginx
    assert "proxy_cache off" in nginx
    assert 'add_header Cache-Control "no-store" always;' in nginx
    assert "limit_req_zone $binary_remote_addr zone=limedia_derivative" in nginx
    assert nginx.index("\nhttp {") < nginx.index("upstream limedia_backend {")
    assert "\nupstream limedia_backend {" not in nginx
    assert "X-Content-Type-Options nosniff" in security_headers
    assert "Content-Security-Policy" in security_headers
    assert "include /etc/nginx/security-headers.conf;" in nginx
