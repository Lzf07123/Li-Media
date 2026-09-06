import { Activity, HardDrive, RefreshCw, Server } from "lucide-react";

import { brand } from "@/lib/brand";
import { formatBytes, formatDateTime } from "@/lib/format";
import type { ServiceStatus, SystemStatus } from "@/lib/api";
import Button from "@/components/ui/Button";
import ProgressBar from "@/components/ui/ProgressBar";
import StatusDot from "@/components/ui/StatusDot";

type AdminStatusDashboardProps = {
  status: SystemStatus | null;
  isRefreshing: boolean;
  onRefresh: () => void;
};

function statusTone(status: "ok" | "unavailable") {
  return status === "ok" ? "connected" : "invalid";
}

function statusLabel(status: ServiceStatus) {
  return status.status === "ok"
    ? brand.copy.adminStatusHealthy
    : brand.copy.adminStatusUnavailable;
}

function failureKindLabel(kind: string) {
  const labels = brand.copy.adminThumbnailFailureReasons as Record<string, string>;
  return labels[kind] ?? kind;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-sm font-medium">{value}</dd>
    </div>
  );
}

function ServiceMetric({
  label,
  service,
}: {
  label: string;
  service: ServiceStatus;
}) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 inline-flex items-center gap-2 text-sm font-medium">
        <StatusDot tone={statusTone(service.status)} />
        {statusLabel(service)}
      </dd>
    </div>
  );
}

export default function AdminStatusDashboard({
  status,
  isRefreshing,
  onRefresh,
}: AdminStatusDashboardProps) {
  if (!status) {
    return <div aria-hidden="true" className="shimmer mt-4 h-44 rounded-xl" />;
  }

  const memoryCurrent = status.resources.cgroup.memory_current_bytes;
  const memoryLimit =
    status.resources.cgroup.memory_max_bytes ??
    status.resources.limits.backend_memory_bytes;
  const memoryRatio =
    memoryCurrent !== null && memoryLimit ? memoryCurrent / memoryLimit : null;
  const tempRatio =
    status.resources.temporary.bytes !== null &&
    status.resources.limits.temp_disk_quota_bytes
      ? status.resources.temporary.bytes /
        status.resources.limits.temp_disk_quota_bytes
      : null;
  const queueLabels: Record<string, string> = {
    scan: brand.copy.adminQueueScan,
    direct_probe: brand.copy.adminQueueDirectProbe,
    derivative: brand.copy.adminQueueDerivative,
    stream: brand.copy.adminQueueStream,
  };

  return (
    <div className="card mt-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {brand.copy.adminStatusTitle}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {brand.copy.adminStatusDescription}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">
            {brand.copy.adminStatusGeneratedAt}:{" "}
            {formatDateTime(status.generated_at)}
          </span>
          <Button
            aria-label={brand.copy.adminStatusRefresh}
            disabled={isRefreshing}
            onClick={onRefresh}
            variant="secondary"
          >
            <RefreshCw
              aria-hidden="true"
              className={`size-4 ${isRefreshing ? "animate-spin" : ""}`}
            />
            {isRefreshing
              ? brand.copy.adminStatusRefreshing
              : brand.copy.adminStatusRefresh}
          </Button>
        </div>
      </div>

      <div className="mt-5 grid gap-6 lg:grid-cols-3">
        <section aria-labelledby="backend-stack-status">
          <div className="flex items-center gap-2">
            <Server aria-hidden="true" className="size-4 text-primary" />
            <h3 className="text-sm font-semibold" id="backend-stack-status">
              {brand.copy.adminBackendTitle}
            </h3>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-3">
            <ServiceMetric
              label={brand.copy.adminBackendApi}
              service={{ status: "ok", detail: null, pool_status: null, dialect: null, used_memory_bytes: null, max_memory_bytes: null, connected_clients: null }}
            />
            <ServiceMetric
              label={brand.copy.adminBackendDatabase}
              service={status.backend.database}
            />
            <ServiceMetric
              label={brand.copy.adminBackendRedis}
              service={status.backend.redis}
            />
            <ServiceMetric
              label={brand.copy.adminBackendGovernor}
              service={{ status: "ok", detail: null, pool_status: null, dialect: null, used_memory_bytes: null, max_memory_bytes: null, connected_clients: null }}
            />
            <Metric
              label={brand.copy.adminBackendRuntime}
              value={`${status.backend.python_version} · ${status.backend.platform}`}
            />
            <Metric
              label={brand.copy.adminBackendThreadPool}
              value={status.backend.task_thread_pool_size}
            />
          </dl>
          {Object.entries(status.remote_storage.counts.thumbnail_failure_kinds ?? {}).length > 0 ? (
            <div className="mt-3 space-y-1">
              <p className="text-xs font-medium text-muted">
                {brand.copy.adminScanFailure}
              </p>
              {Object.entries(
                status.remote_storage.counts.thumbnail_failure_kinds,
              ).map(([kind, count]) => (
                <p className="text-xs text-muted" key={kind}>
                  {failureKindLabel(kind)}: {count}
                </p>
              ))}
            </div>
          ) : null}
        </section>

        <section aria-labelledby="remote-storage-status">
          <div className="flex items-center gap-2">
            <HardDrive aria-hidden="true" className="size-4 text-primary" />
            <h3 className="text-sm font-semibold" id="remote-storage-status">
              {brand.copy.adminRemoteStorageTitle}
            </h3>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-3">
            <Metric
              label={brand.copy.adminRemoteStorageProvider}
              value={brand.copy.adminRemoteStorageBaidu}
            />
            <Metric
              label={brand.copy.adminRemoteStorageAuthorized}
              value={
                status.remote_storage.authorized
                  ? brand.copy.adminStatusAuthorized
                  : brand.copy.adminStatusNotAuthorized
              }
            />
            <Metric
              label={brand.copy.adminRemoteStorageIndexed}
              value={status.remote_storage.counts.total}
            />
            <Metric
              label={brand.copy.adminRemoteStorageReady}
              value={status.remote_storage.counts.remote_ready}
            />
            <Metric
              label={brand.copy.adminRemoteStorageMissing}
              value={status.remote_storage.counts.remote_missing}
            />
            <Metric
              label={brand.copy.adminRemoteStorageFailed}
              value={status.remote_storage.counts.remote_failed}
            />
            <Metric
              label={brand.copy.adminRemoteStoragePreviewReady}
              value={status.remote_storage.counts.thumbnail_ready}
            />
            <Metric
              label={brand.copy.adminRemoteStoragePreviewFailed}
              value={status.remote_storage.counts.thumbnail_failed}
            />
            <Metric
              label={brand.copy.adminRemoteStorageStreamFailed}
              value={status.remote_storage.counts.stream_failed}
            />
          </dl>
        </section>

        <section aria-labelledby="resource-queue-status">
          <div className="flex items-center gap-2">
            <Activity aria-hidden="true" className="size-4 text-primary" />
            <h3 className="text-sm font-semibold" id="resource-queue-status">
              {brand.copy.adminResourceTitle}
            </h3>
          </div>

          <div className="mt-3 space-y-3">
            {memoryCurrent !== null && memoryLimit ? (
              <ProgressBar
                label={brand.copy.adminResourceMemory}
                tone={memoryRatio !== null && memoryRatio >= 0.8 ? "danger" : "primary"}
                value={(memoryRatio ?? 0) * 100}
              />
            ) : null}

            <dl className="grid grid-cols-2 gap-3">
              <Metric
                label={brand.copy.adminResourceMemory}
                value={`${formatBytes(memoryCurrent) ?? "-"} / ${formatBytes(memoryLimit) ?? "-"}`}
              />
              <Metric
                label={brand.copy.adminResourceThreads}
                value={status.resources.process.threads ?? "-"}
              />
              <Metric
                label={brand.copy.adminResourcePids}
                value={status.resources.cgroup.pids_current ?? "-"}
              />
              <Metric
                label={brand.copy.adminResourceTemp}
                value={`${status.resources.temporary.files ?? 0} / ${status.resources.limits.temp_max_files ?? "-"}`}
              />
              <Metric
                label={brand.copy.adminResourceDisk}
                value={formatBytes(status.resources.temporary.free_bytes) ?? "-"}
              />
              <Metric
                label={brand.copy.adminResourceActiveJobs}
                value={status.metrics.active_jobs ?? 0}
              />
              <Metric
                label={brand.copy.adminResourceQueueDepth}
                value={status.metrics.queue_depth ?? 0}
              />
              <Metric
                label={brand.copy.adminResourceOom}
                value={status.resources.cgroup.oom_kill ?? 0}
              />
            </dl>

            <div>
              <h4 className="text-sm font-semibold">
                {brand.copy.adminQueueTitle}
              </h4>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {Object.entries(status.tasks).map(([key, queue]) => (
                  <div className="rounded-lg border border-border p-3" key={key}>
                    <p className="text-sm font-medium">
                      {queueLabels[key] ?? key}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {brand.copy.adminQueueActive} {queue.active}/{queue.limit}
                      {" · "}
                      {brand.copy.adminQueueQueued} {queue.queued}/{queue.queue_limit}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {brand.copy.adminQueueCompleted}{" "}
                      {status.metrics[`${key}.completed`] ?? 0}
                      {" · "}
                      {brand.copy.adminQueueRejected}{" "}
                      {status.metrics[`${key}.rejected`] ?? 0}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {tempRatio !== null ? (
              <ProgressBar
                label={brand.copy.adminResourceTemp}
                tone={tempRatio >= 0.8 ? "danger" : "primary"}
                value={tempRatio * 100}
              />
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
