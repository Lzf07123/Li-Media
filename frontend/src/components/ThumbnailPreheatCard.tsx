import { useEffect, useMemo, useState } from "react";
import { Images } from "lucide-react";

import Button from "@/components/ui/Button";
import ProgressBar from "@/components/ui/ProgressBar";
import { brand } from "@/lib/brand";
import { previewThumbnailPreheat, type ThumbnailPreheatJob } from "@/lib/api";
import { formatBytes } from "@/lib/format";

type ThumbnailPreheatCardProps = {
  job: ThumbnailPreheatJob | null;
  isStarting: boolean;
  isCancelling?: boolean;
  onCancel?: () => void;
  onStart: (payload: {
    sizes: ("240" | "480" | "768" | "1280")[];
    kind?: "photo" | "video";
    limit: number;
  }) => Promise<void>;
};

const sizePresets = {
  home: ["240"],
  detail: ["480", "1280"],
} as const;
type SizePreset = keyof typeof sizePresets;
const statusCopy = {
  queued: brand.copy.adminPreheatQueued,
  running: brand.copy.adminPreheatRunning,
  completed: brand.copy.adminPreheatCompleted,
  cancelled: brand.copy.adminPreheatCancelled,
  failed: brand.copy.adminPreheatFailed,
};

export default function ThumbnailPreheatCard({
  job,
  isStarting,
  isCancelling = false,
  onCancel,
  onStart,
}: ThumbnailPreheatCardProps) {
  const [sizePreset, setSizePreset] = useState<SizePreset>("home");
  const [kind, setKind] = useState<"" | "photo" | "video">("");
  const [limitInput, setLimitInput] = useState("0");
  const [previewTotal, setPreviewTotal] = useState<number | null>(null);
  const limit = Math.max(0, Math.min(5000, Math.floor(Number(limitInput) || 0)));
  const isJobActive = job?.status === "queued" || job?.status === "running";
  const scopeCopy =
    kind === "photo"
      ? brand.copy.adminPreheatPhoto
      : kind === "video"
        ? brand.copy.adminPreheatVideo
        : brand.copy.adminPreheatAllKinds;

  // 启动前预估影响面：预热涉及远端整文件下载，管理员应知道规模。
  // 预估失败静默降级，不阻塞启动。
  useEffect(() => {
    let active = true;
    setPreviewTotal(null);
    const timer = window.setTimeout(() => {
      previewThumbnailPreheat({
        sizes: [...sizePresets[sizePreset]],
        kind: kind || undefined,
        limit: 0,
      })
        .then((preview) => {
          if (active) {
            setPreviewTotal(preview.total);
          }
        })
        .catch(() => {
          if (active) {
            setPreviewTotal(null);
          }
        });
    }, 300);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [kind, sizePreset]);

  // 运行中按已用时间与进度估算剩余；轮询每秒更新，无需本地计时。
  const etaMinutes = useMemo(() => {
    if (!job || job.status !== "running" || !job.started_at) {
      return null;
    }
    if (job.processed <= 0 || job.total <= job.processed) {
      return null;
    }
    const elapsedMs = Date.now() - new Date(job.started_at).getTime();
    if (elapsedMs <= 0) {
      return null;
    }
    const remainingMs = (elapsedMs / job.processed) * (job.total - job.processed);
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      return null;
    }
    return Math.max(1, Math.round(remainingMs / 60000));
  }, [job]);

  const estimatedTotal =
    previewTotal === null ? null : limit > 0 ? Math.min(limit, previewTotal) : previewTotal;

  return (
    <div className="card mt-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Images aria-hidden="true" className="mt-1 size-4 text-primary" />
          <div>
            <h3 className="text-sm font-semibold">
              {brand.copy.adminPreheatTitle}
            </h3>
            <p className="mt-1 text-xs text-muted">
              {brand.copy.adminPreheatDescription}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {isJobActive && onCancel ? (
            <Button
              disabled={isCancelling}
              onClick={onCancel}
              variant="danger"
            >
              {isCancelling
                ? brand.copy.adminPreheatCancelling
                : brand.copy.adminPreheatCancel}
            </Button>
          ) : null}
          <Button
            disabled={isStarting || isJobActive}
            onClick={() =>
              void onStart({
                sizes: [...sizePresets[sizePreset]],
                kind: kind || undefined,
                limit,
              })
            }
          >
            {isStarting || isJobActive
              ? brand.copy.adminPreheatStarting
              : brand.copy.adminPreheatStart}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-2 text-sm" htmlFor="preheat-size">
          {brand.copy.adminPreheatSize}
          <select
            className="select min-h-11"
            id="preheat-size"
            onChange={(event) =>
              setSizePreset(event.target.value as SizePreset)
            }
            value={sizePreset}
          >
            <option value="home">{brand.copy.adminPreheatHome}</option>
            <option value="detail">{brand.copy.adminPreheatDetail}</option>
          </select>
        </label>

        <label className="flex flex-col gap-2 text-sm" htmlFor="preheat-kind">
          {brand.copy.adminPreheatKind}
          <select
            className="select min-h-11"
            id="preheat-kind"
            onChange={(event) =>
              setKind(event.target.value as "" | "photo" | "video")
            }
            value={kind}
          >
            <option value="">{brand.copy.adminPreheatAllKinds}</option>
            <option value="photo">{brand.copy.adminPreheatPhoto}</option>
            <option value="video">{brand.copy.adminPreheatVideo}</option>
          </select>
        </label>

        <label className="flex flex-col gap-2 text-sm" htmlFor="preheat-limit">
          {brand.copy.adminPreheatLimitLabel}
          <input
            className="input min-h-11"
            id="preheat-limit"
            inputMode="numeric"
            max={5000}
            min={0}
            onChange={(event) => setLimitInput(event.target.value)}
            type="number"
            value={limitInput}
          />
          <span className="text-xs text-muted">
            {brand.copy.adminPreheatLimitHint}
          </span>
        </label>
      </div>

      <p className="mt-3 text-xs text-muted">
        {brand.copy.adminPreheatScope}: {scopeCopy}
        {estimatedTotal !== null ? (
          <span className="ml-2">
            {brand.copy.adminPreheatEstimated.replace(
              "{total}",
              String(estimatedTotal),
            )}
          </span>
        ) : null}
      </p>

      {job ? (
        <div className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted">
              {brand.copy.adminPreheatStatus}: {statusCopy[job.status]}
            </span>
            <span className="text-xs text-muted">
              {etaMinutes !== null
                ? `${brand.copy.adminPreheatEtaRemaining.replace("{minutes}", String(etaMinutes))} · `
                : ""}
              {job.processed}/{job.total || job.limit}
            </span>
          </div>
          <ProgressBar
            label={brand.copy.adminPreheatTitle}
            tone={job.status === "failed" ? "danger" : "primary"}
            value={
              job.total > 0 ? (job.processed / job.total) * 100 : 0
            }
          />
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-9">
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminPreheatGenerated}</dt>
              <dd className="text-sm font-medium">{job.generated}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminPreheatCached}</dt>
              <dd className="text-sm font-medium">{job.cached}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminPreheatFailedCount}</dt>
              <dd className="text-sm font-medium">{job.failed}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminPreheatSkipped}</dt>
              <dd className="text-sm font-medium">{job.skipped}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminPreheatSize}</dt>
              <dd className="text-sm font-medium">{job.sizes.join(" / ")}px</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminPreheatSourceBytes}</dt>
              <dd className="text-sm font-medium">
                {formatBytes(job.source_bytes_downloaded) ?? "-"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminPreheatDuration}</dt>
              <dd className="text-sm font-medium">{job.derivative_duration_ms}ms</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">
                {brand.copy.adminPreheatConcurrency}
              </dt>
              <dd className="text-sm font-medium">{job.concurrency}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">
                {brand.copy.adminPreheatQueueLimit}
              </dt>
              <dd className="text-sm font-medium">{job.queue_limit}</dd>
            </div>
          </dl>
          {job.message ? (
            <p className="mt-3 break-all text-xs text-muted">{job.message}</p>
          ) : null}
          {job.sizes.length > 0 && Object.keys(job.size_results).length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {job.sizes.map((size) => {
                const result = job.size_results[String(size)];
                if (!result) {
                  return null;
                }
                const parts = [
                  `${brand.copy.adminPreheatGenerated} ${result.generated ?? 0}`,
                  `${brand.copy.adminPreheatCached} ${result.cached ?? 0}`,
                  `${brand.copy.adminPreheatFailedCount} ${result.failed ?? 0}`,
                ];
                if ((result.skipped ?? 0) > 0) {
                  parts.push(`${brand.copy.adminPreheatSkipped} ${result.skipped}`);
                }
                return (
                  <span className="badge badge-muted" key={size}>
                    {size}px · {parts.join(" · ")}
                  </span>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
