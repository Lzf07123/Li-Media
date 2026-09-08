import {
  Activity,
  Database,
  Gauge,
  HardDrive,
  Layers,
  RefreshCw,
  Server,
  SlidersHorizontal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

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
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-medium">{value}</dd>
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
    <div className="flex min-w-0 items-center justify-between gap-3">
      <dt className="shrink-0 text-xs text-muted">{label}</dt>
      <dd className="inline-flex min-w-0 items-center gap-2 text-right text-sm font-medium">
        <StatusDot tone={statusTone(service.status)} />
        {statusLabel(service)}
      </dd>
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  id,
  title,
}: {
  icon: LucideIcon;
  id: string;
  title: string;
}) {
  return (
    <div className="flex h-6 items-center gap-2">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-primary" />
      <h3 className="truncate text-sm font-semibold" id={id}>
        {title}
      </h3>
    </div>
  );
}

function QueueMetric({
  label,
  queue,
  completed,
  rejected,
}: {
  label: string;
  queue: { active: number; limit: number; queued: number; queue_limit: number };
  completed: number;
  rejected: number;
}) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <dt className="shrink-0 text-xs text-muted">{label}</dt>
        <dd className="min-w-0 text-right text-sm font-medium">
          {queue.active}/{queue.limit}
          {" · "}
          {queue.queued}/{queue.queue_limit}
        </dd>
      </div>
      <p className="mt-1 text-right text-xs text-muted">
        {brand.copy.adminQueueCompleted} {completed}
        {" · "}
        {brand.copy.adminQueueRejected} {rejected}
      </p>
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
  const filesystemRatio = status.resources.filesystem.usage_ratio;
  const filesystemTone =
    filesystemRatio !== null && filesystemRatio >= 0.9
      ? "danger"
      : filesystemRatio !== null && filesystemRatio >= 0.8
        ? "warning"
        : "primary";
  const configuration = status.backend.configuration;
  const cacheStatus = {
    ok: "",
    unavailable: brand.copy.adminCacheUnavailable,
    truncated: brand.copy.adminCacheTruncated,
    timeout: brand.copy.adminCacheTimeout,
  };
  const queueLabels: Record<string, string> = {
    scan: brand.copy.adminQueueScan,
    direct_probe: brand.copy.adminQueueDirectProbe,
    derivative: brand.copy.adminQueueDerivative,
    preheat: brand.copy.adminQueuePreheat,
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

      <div className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        <section aria-labelledby="backend-stack-status">
          <SectionHeader
            icon={Server}
            id="backend-stack-status"
            title={brand.copy.adminBackendTitle}
          />
          <dl className="mt-3 space-y-2">
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
        </section>

        <section aria-labelledby="remote-storage-status">
          <SectionHeader
            icon={HardDrive}
            id="remote-storage-status"
            title={brand.copy.adminRemoteStorageTitle}
          />
          <dl className="mt-3 space-y-2">
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

        <section aria-labelledby="resource-queue-status">
          <SectionHeader
            icon={Activity}
            id="resource-queue-status"
            title={brand.copy.adminResourceTitle}
          />

          <div className="mt-3 space-y-3">
            {filesystemRatio !== null ? (
              <ProgressBar
                label={brand.copy.adminResourceFilesystem}
                tone={filesystemTone}
                value={filesystemRatio * 100}
              />
            ) : null}

            {memoryCurrent !== null && memoryLimit ? (
              <ProgressBar
                label={brand.copy.adminResourceMemory}
                tone={memoryRatio !== null && memoryRatio >= 0.8 ? "danger" : "primary"}
                value={(memoryRatio ?? 0) * 100}
              />
            ) : null}

            <dl className="space-y-2">
              <Metric
                label={brand.copy.adminResourceMemory}
                value={`${formatBytes(memoryCurrent) ?? "-"} / ${formatBytes(memoryLimit) ?? "-"}`}
              />
              <Metric
                label={brand.copy.adminResourceTemp}
                value={`${status.resources.temporary.files ?? 0} / ${status.resources.limits.temp_max_files ?? "-"}`}
              />
              <Metric
                label={brand.copy.adminResourceDisk}
                value={`${formatBytes(status.resources.filesystem.used_bytes) ?? "-"} / ${formatBytes(status.resources.filesystem.total_bytes) ?? "-"}`}
              />
              <Metric
                label={brand.copy.adminResourceActiveJobs}
                value={status.metrics.active_jobs ?? 0}
              />
              <Metric
                label={brand.copy.adminResourceOom}
                value={status.resources.cgroup.oom_kill ?? 0}
              />
            </dl>

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

      <div className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <section aria-labelledby="workload-status">
          <SectionHeader
            icon={Gauge}
            id="workload-status"
            title={brand.copy.adminWorkloadTitle}
          />
          <dl className="mt-3 space-y-2">
            <Metric
              label={brand.copy.adminResourceThreads}
              value={status.resources.process.threads ?? "-"}
            />
            <Metric
              label={brand.copy.adminResourcePids}
              value={status.resources.cgroup.pids_current ?? "-"}
            />
            <Metric
              label={brand.copy.adminResourceActiveJobs}
              value={status.metrics.active_jobs ?? 0}
            />
            <Metric
              label={brand.copy.adminResourceQueueDepth}
              value={status.metrics.queue_depth ?? 0}
            />
          </dl>
        </section>

        <section aria-labelledby="cache-status">
          <SectionHeader
            icon={Layers}
            id="cache-status"
            title={brand.copy.adminCacheTitle}
          />
          <dl className="mt-3 space-y-2">
            {(
              [
                ["derived_thumbnails", brand.copy.adminCacheDerived],
                ["temporary", brand.copy.adminCacheTemporary],
                ["nginx", brand.copy.adminCacheNginx],
              ] as const
            ).map(([key, label]) => {
              const cache = status.resources.caches[key];
              const statusText = cacheStatus[cache.status];
              return (
                <div key={key}>
                  <div className="flex min-w-0 items-baseline justify-between gap-3">
                    <dt className="shrink-0 text-xs text-muted">{label}</dt>
                    <dd className="min-w-0 text-right text-sm font-medium">
                      {cache.files} {brand.copy.adminCacheFiles} ·{" "}
                      {formatBytes(cache.bytes) ?? 0}
                    </dd>
                  </div>
                  {statusText ? (
                    <p className="text-right text-xs text-muted">{statusText}</p>
                  ) : null}
                </div>
              );
            })}
          </dl>
        </section>

        <section aria-labelledby="resource-configuration-status">
          <SectionHeader
            icon={SlidersHorizontal}
            id="resource-configuration-status"
            title={brand.copy.adminConfigurationTitle}
          />
          <dl className="mt-3 space-y-2">
            <Metric
              label={brand.copy.adminConfigPreheatConcurrency}
              value={`${configuration.preheat_concurrency_limit} / ${configuration.preheat_queue_limit}`}
            />
            <Metric
              label={brand.copy.adminConfigDerivative}
              value={`${configuration.derivative_concurrency_limit} / ${configuration.derivative_queue_limit}`}
            />
            <Metric
              label={brand.copy.adminConfigDirectProbe}
              value={`${configuration.direct_probe_concurrency_limit} / ${configuration.direct_probe_queue_limit}`}
            />
            <Metric
              label={brand.copy.adminConfigScan}
              value={configuration.scan_concurrency_limit}
            />
            <Metric
              label={brand.copy.adminConfigStreamGlobal}
              value={`${configuration.stream_global_concurrency_limit} / ${configuration.stream_user_concurrency_limit}`}
            />
            <Metric
              label={brand.copy.adminConfigTemp}
              value={`${configuration.temp_max_files} / ${formatBytes(configuration.temp_disk_quota_bytes) ?? "-"}`}
            />
          </dl>
        </section>

        <section aria-labelledby="task-queue-status">
          <SectionHeader
            icon={Database}
            id="task-queue-status"
            title={brand.copy.adminQueueTitle}
          />
          <dl className="mt-3 space-y-2">
            {Object.entries(status.tasks).map(([key, queue]) => (
              <QueueMetric
                completed={status.metrics[`${key}.completed`] ?? 0}
                key={key}
                label={queueLabels[key] ?? key}
                queue={queue}
                rejected={status.metrics[`${key}.rejected`] ?? 0}
              />
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}
