# 预热端到端基准（preheat baseline）

与 `docs/resource-baseline.md` 的单帧派生基线互补：本文件记录**预热任务链路**
（候选枚举 → 槽位 → 派生 → DB 回写）的端到端吞吐，基准脚本为
`scripts/preheat_baseline.py`。

## 容器规格

与生产 backend 服务一致（`docker-compose.yml`）：

| 项 | 值 |
| --- | --- |
| 镜像 | `backend/Dockerfile`（python:3.12-slim + ffmpeg） |
| 内存 | 256m |
| CPU | 1.0 |
| pids | 64 |

## 方法

- 负载：24 张 1600×1067 渐变 JPEG（PIL 生成）+ 6 段 2s 640×360 testsrc
  H.264（ffmpeg 生成），全部作为**本地源**（`source_path` 指向 media_root
  内文件，不触发远端下载，无百度凭据可跑）。
- 规模：30 候选 × 2 尺寸（240/480）= 60 派生；`preheat_concurrency=2`。
- 计时：`run_thumbnail_preheat` 全链路 wall time；输出 JSON 含任务计数、
  `task_metrics.snapshot()` 与 `collect_resource_metrics()`。

## 重跑命令

```bash
docker compose run --rm --no-deps \
  -v "$(pwd)/scripts:/mnt/scripts:ro" \
  backend python /mnt/scripts/preheat_baseline.py \
  --photos 24 --videos 6 --sizes 240,480 --concurrency 2 \
  --derivative-concurrency 1
```

## 结果（2026-11-06，macOS Docker Desktop，容器 256m/1cpu）

| 版本 | wall | 吞吐（items/s） | 生成/失败 |
| --- | --- | --- | --- |
| 优化前（每尺寸独立解码/独立 ffmpeg） | 1.240s | 24.19 | 60 / 0 |
| 优化前（对照，derivative 并发 2） | 1.176s | 25.52 | 60 / 0 |
| 优化后（一次解码 + 单次 ffmpeg 多输出） | 0.878s | **34.17** | 60 / 0 |
| 优化后（对照，derivative 并发 2） | 0.869s | 34.54 | 60 / 0 |
| 最终代码复测 | 0.920s | 32.61 | 60 / 0 |
| detail 预设（480/1280）优化后 | 2.113s | 14.20 | 60 / 0 |

**吞吐提升 +35% ~ +41%**（照片单次解码、WebP/视频单次 ffmpeg `split`
多输出，消除每尺寸重复解码与重复进程 spawn）。

## 并发决策：`derivative_concurrency_limit` 保持默认 1

derivative 并发 1→2 在 1 CPU 容器内差异为噪声级（34.17 vs 34.54），
而派生并发翻倍会抬高 256MB 内存上限下的 ffmpeg/PIL 峰值（detail 预设
实测 cgroup 峰值 151MB / 上限 256MB，无 OOM 事件）。无吞吐收益则不承担
内存风险，维持 1；若未来 CPU 配额上调，可依本基准重测后再定。

## 已知偏差

- `task_metrics.child_peak_kbytes` 来自 `getrusage(RUSAGE_CHILDREN)`，
  是进程生命周期内所有子进程的峰值最大值，只能单调抬升，不按 job 归因，
  横向对比时应忽略该字段。
- 本基准不覆盖远端下载路径（需百度凭据）；远端候选的额外耗时由
  `_download_remote_source` 主导，与本次优化项无交集。
