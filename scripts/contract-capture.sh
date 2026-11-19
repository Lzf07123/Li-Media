#!/usr/bin/env bash
# 契约样本抓取:对运行中的后端抓取核心端点响应,存档到 docs/contract-samples/。
# 用法: scripts/contract-capture.sh <base_url> <output_dir>
# 凭据(ADMIN_TOKEN)从仓库根 .env 运行时读取,不写入任何文件。
set -euo pipefail

BASE="${1:?usage: contract-capture.sh <base_url> <output_dir>}"
OUT="${2:?usage: contract-capture.sh <base_url> <output_dir>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC1091
ADMIN_TOKEN="$(grep -E '^ADMIN_TOKEN=' "$REPO_ROOT/.env" | cut -d= -f2-)"

M1='00000000-0000-4000-8000-000000000001'
M2='00000000-0000-4000-8000-000000000002'
M3='00000000-0000-4000-8000-000000000003'
M4='00000000-0000-4000-8000-000000000004'

mkdir -p "$OUT"
COOKIES="$(mktemp)"

cap() { # cap <编号-名称> <method> <path> [json_body]
  local name="$1" method="$2" path="$3" body="${4:-}"
  local status file="$OUT/${name}.json" extra=()
  # 21-admin-login 之后的编号默认带会话 cookie
  if [ "${name%%-*}" -ge 21 ] 2>/dev/null && [ "${name%-admin-unauth}" = "$name" ]; then
    extra=(-b "$COOKIES")
  fi
  if [ "$name" = "21-admin-login" ]; then
    extra=(-c "$COOKIES")
  fi
  if [ -n "$body" ]; then
    status=$(curl -sS -o "$file" -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' -d "$body" ${extra[@]+"${extra[@]}"} "$BASE$path")
  else
    status=$(curl -sS -o "$file" -w '%{http_code}' -X "$method" ${extra[@]+"${extra[@]}"} "$BASE$path")
  fi
  printf '{"_status": %s, "_path": "%s"}' "$status" "$path" > "$file.meta"
  printf '%-42s -> %s\n' "$name" "$status"
}

echo "== 公开端点 =="
cap 01-root            GET  /api/v1/
cap 02-healthz         GET  /api/v1/healthz
cap 03-readyz          GET  /api/v1/readyz
cap 04-recommend       GET  /api/v1/memories/recommend
cap 05-list-default    GET  '/api/v1/memories?page=1&page_size=10'
cap 06-list-captured   GET  '/api/v1/memories?page=1&page_size=10&sort=captured_asc'
cap 07-list-random     GET  '/api/v1/memories?page=1&page_size=10&sort=random&seed=42'
cap 08-list-keyword    GET  '/api/v1/memories?page=1&page_size=10&keyword=%E6%B4%B1%E6%B5%B7'
cap 09-list-video      GET  '/api/v1/memories?page=1&page_size=10&kind=video'
cap 10-public-counts   GET  /api/v1/memories/public-counts
cap 11-preheat-status  GET  /api/v1/memories/public/preheat-status
cap 12-detail-photo    GET  "/api/v1/memories/$M1"
cap 13-detail-video    GET  "/api/v1/memories/$M4"
cap 14-detail-404      GET  "/api/v1/memories/00000000-0000-4000-8000-999999999999"
cap 15-thumbnail       GET  "/api/v1/memories/$M2/thumbnail?size=240"
cap 16-direct-url      GET  "/api/v1/memories/$M3/direct-url?purpose=play"

echo "== 未登录管理端(401 契约) =="
cap 20-admin-unauth    GET  /api/v1/admin/memories

echo "== 管理端登录 =="
cap 21-admin-login     POST /api/v1/admin/login "{\"token\": \"$ADMIN_TOKEN\"}"

echo "== 管理端(cookie 会话) =="
cap 22-admin-remote-config   GET  /api/v1/admin/remote-config
cap 23-admin-scan-latest     GET  /api/v1/admin/remote-scan/latest
cap 24-admin-tasks-metrics   GET  /api/v1/admin/tasks/metrics
cap 25-admin-system-status   GET  /api/v1/admin/system/status
cap 26-admin-memories        GET  '/api/v1/admin/memories?page=1&page_size=10'
cap 27-batch-preview         POST /api/v1/admin/memories/batch-preview '{"display":"all","compatibility":"all"}'
cap 28-batch-preview-video   POST /api/v1/admin/memories/batch-preview '{"display":"all","compatibility":"all","kind":"video"}'
cap 29-admin-export          POST /api/v1/admin/memories/export "{\"ids\": [\"$M1\", \"$M3\"]}"
cap 30-preheat-latest        GET  /api/v1/admin/thumbnails/preheat/latest
cap 31-compat-latest         GET  /api/v1/admin/browser-compatibility/latest

rm -f "$COOKIES"
echo "== 完成:样本在 $OUT =="
