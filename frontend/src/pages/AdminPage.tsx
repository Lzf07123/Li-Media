import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { LogOut } from "lucide-react";
import { Link } from "react-router-dom";

import AdminLoginCard from "@/components/AdminLoginCard";
import AdminStatusDashboard from "@/components/AdminStatusDashboard";
import BaiduSetupCard from "@/components/BaiduSetupCard";
import FileStatusBadge from "@/components/FileStatusBadge";
import RemoteStateBadge from "@/components/RemoteStateBadge";
import StatusBadge from "@/components/StatusBadge";
import ThumbnailPreheatCard from "@/components/ThumbnailPreheatCard";
import { brand } from "@/lib/brand";
import {
  deleteMemory,
  getAdminMemories,
  getRemoteConfig,
  getSystemStatus,
  getLatestThumbnailPreheat,
  getLatestRemoteScan,
  startThumbnailPreheat,
  requestLocalMediaCleanup,
  startBaiduAuthorization,
  loginAdmin,
  logoutAdmin,
  retryRemoteEntry,
  syncMemories,
  updateMemory,
  batchUpdateMemories,
  exportMemories,
  type Memory,
  type RemoteConfig,
  type RemoteScanTask,
  type CleanupResult,
  type CleanupStats,
  type SystemStatus,
  type ThumbnailPreheatJob,
} from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import Notice from "@/components/ui/Notice";
import { ToastViewport, type Toast } from "@/components/ui/Toast";
import { Input, TextArea } from "@/components/ui/Input";
import Pagination from "@/components/ui/Pagination";
import ProgressBar from "@/components/ui/ProgressBar";
import StatusDot from "@/components/ui/StatusDot";

export default function AdminPage() {
  const [tokenInput, setTokenInput] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isRetryingRemote, setIsRetryingRemote] = useState<string | null>(null);
  const [isCleaning, setIsCleaning] = useState(false);
  const [pendingCleanup, setPendingCleanup] = useState<CleanupStats | null>(null);
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null);
  const [scanTask, setScanTask] = useState<RemoteScanTask | null>(null);
  const [lastDeleted, setLastDeleted] = useState(0);
  const [remoteConfig, setRemoteConfig] = useState<RemoteConfig | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [isRefreshingStatus, setIsRefreshingStatus] = useState(false);
  const [preheatJob, setPreheatJob] = useState<ThumbnailPreheatJob | null>(null);
  const [isPreheating, setIsPreheating] = useState(false);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pendingDelete, setPendingDelete] = useState<Memory | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [adminKind, setAdminKind] = useState("");
  const [adminSearch, setAdminSearch] = useState("");
  const [adminSearchInput, setAdminSearchInput] = useState("");
  const [adminPage, setAdminPage] = useState(1);
  const [adminPageSize, setAdminPageSize] = useState(50);
  const [adminTotal, setAdminTotal] = useState(0);
  const [isBatchEditing, setIsBatchEditing] = useState(false);
  const [batchTitle, setBatchTitle] = useState("");
  const [batchDescription, setBatchDescription] = useState("");
  const [batchLocation, setBatchLocation] = useState("");
  const [batchCapturedAt, setBatchCapturedAt] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();

  const pushToast = (message: string, tone: Toast["tone"]) => {
    setToasts((current) => [...current, { id: Date.now(), message, tone }]);
  };

  const dismissToast = (id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  };

  const loadMemories = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getAdminMemories({
        keyword: adminSearch || undefined,
        kind: adminKind || undefined,
        page: adminPage,
        page_size: adminPageSize,
      });
      setMemories(data.items);
      setAdminTotal(data.total);
      setIsAdmin(true);
      const scan = await getLatestRemoteScan();
      setScanTask(scan);
      const config = await getRemoteConfig();
      setRemoteConfig(config);
      try {
        setPreheatJob(await getLatestThumbnailPreheat());
      } catch {
        setPreheatJob(null);
      }
      try {
        setSystemStatus(await getSystemStatus());
      } catch {
        setSystemStatus(null);
      }
      setError(null);
    } catch (loadError) {
      setIsAdmin(false);
      setError(
        loadError instanceof Error && loadError.message.includes("401")
          ? null
          : brand.copy.adminLoginFailed,
      );
    } finally {
      setIsLoading(false);
    }
  }, [adminKind, adminPage, adminPageSize, adminSearch]);

  useEffect(() => {
    void loadMemories();
  }, [loadMemories]);

  useEffect(() => {
    if (scanTask?.status !== "running") {
      return;
    }

    const timer = window.setInterval(async () => {
      const nextTask = await getLatestRemoteScan();
      setScanTask(nextTask);

      if (nextTask?.status !== "running") {
        await loadMemories();
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [scanTask?.status, loadMemories]);

  useEffect(() => {
    if (preheatJob?.status !== "queued" && preheatJob?.status !== "running") {
      return;
    }

    const timer = window.setInterval(async () => {
      const nextJob = await getLatestThumbnailPreheat();
      setPreheatJob(nextJob);

      if (nextJob?.status === "completed") {
        void refreshSystemStatus();
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [preheatJob?.status]);

  useEffect(() => {
    const authorizationResult = searchParams.get("baidu_auth");
    if (!authorizationResult) {
      return;
    }

    pushToast(
      authorizationResult === "success"
        ? brand.copy.adminRemoteCallbackSuccess
        : brand.copy.adminRemoteCallbackFailed,
      authorizationResult === "success" ? "success" : "error",
    );
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (toasts.length === 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      setToasts((current) => current.slice(1));
    }, 3600);

    return () => window.clearTimeout(timer);
  }, [toasts]);

  const submitToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await loginAdmin(tokenInput);
      setTokenInput("");
      await loadMemories();
    } catch {
      setIsAdmin(false);
      setError(brand.copy.adminLoginFailed);
    }
  };

  const submitAdminSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAdminSearch(adminSearchInput.trim());
    setAdminPage(1);
  };

  const changeStatus = async (memory: Memory, status: Memory["status"]) => {
    try {
      await updateMemory(memory.id, { status });
      await loadMemories();
    } catch {
      setError(brand.copy.adminStatusUpdateFailed);
    }
  };

  const removeMemory = async (memory: Memory) => {
    try {
      await deleteMemory(memory.id);
      setPendingDelete(null);
      setSelectedIds((current) => current.filter((id) => id !== memory.id));
      await loadMemories();
    } catch {
      setError(brand.copy.adminDeleteFailed);
    }
  };

  const toggleSelected = (memoryId: string) => {
    setSelectedIds((current) =>
      current.includes(memoryId)
        ? current.filter((id) => id !== memoryId)
        : [...current, memoryId],
    );
  };

  const toggleAllSelected = () => {
    setSelectedIds((current) =>
      current.length === memories.length
        ? []
        : memories.map((memory) => memory.id),
    );
  };

  const applyBatchUpdate = async (payload: Parameters<typeof batchUpdateMemories>[0]) => {
    try {
      await batchUpdateMemories(payload);
      setError(null);
      setSelectedIds([]);
      await loadMemories();
      return true;
    } catch {
      setError(brand.copy.adminStatusUpdateFailed);
      return false;
    }
  };

  const submitBatchEdit = async () => {
    const succeeded = await applyBatchUpdate({
      ids: selectedIds,
      title: batchTitle || undefined,
      description: batchDescription || undefined,
      location: batchLocation || undefined,
      captured_at: batchCapturedAt || undefined,
    });
    if (succeeded) {
      setIsBatchEditing(false);
      setBatchTitle("");
      setBatchDescription("");
      setBatchLocation("");
      setBatchCapturedAt("");
    }
  };

  const exportSelectedReport = async () => {
    try {
      const report = await exportMemories(selectedIds);
      const blob = new Blob([JSON.stringify(report, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `limedia-report-${Date.now()}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setError(null);
    } catch {
      setError(brand.copy.adminExportFailed);
    }
  };

  const triggerSync = async (resumeTaskId?: string) => {
    setIsSyncing(true);
    try {
      const result = await syncMemories(resumeTaskId);
      setError(null);
      setLastDeleted(result.deleted);
      pushToast(
        result.scan_task.status === "running"
          ? brand.copy.adminScanQueued
          : brand.copy.adminSyncSuccess,
        "success",
      );
      setScanTask(result.scan_task);
      await loadMemories();
    } catch {
      setError(brand.copy.adminSyncFailed);
    } finally {
      setIsSyncing(false);
    }
  };

  const prepareCleanup = async () => {
    setIsCleaning(true);
    try {
      const result = await requestLocalMediaCleanup(false);
      setCleanupResult(null);
      setPendingCleanup(result.stats);
      setError(null);
    } catch {
      setError(brand.copy.adminCleanupFailed);
    } finally {
      setIsCleaning(false);
    }
  };

  const confirmCleanup = async () => {
    setIsCleaning(true);
    try {
      const result = await requestLocalMediaCleanup(true);
      setCleanupResult(result);
      setPendingCleanup(null);
      setSelectedIds([]);
      setError(result.file_cleanup_error ? brand.copy.adminCleanupFileWarning : null);
      pushToast(
        result.file_cleanup_error
          ? brand.copy.adminCleanupFileWarning
          : brand.copy.adminCleanupSuccess,
        result.file_cleanup_error ? "warning" : "success",
      );
      await loadMemories();
    } catch {
      setError(brand.copy.adminCleanupFailed);
    } finally {
      setIsCleaning(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) {
      return `${bytes} ${brand.copy.bytes}`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  };

  const startAuthorization = async () => {
    setIsAuthorizing(true);
    try {
      const authorization = await startBaiduAuthorization();
      window.location.href = authorization.authorize_url;
    } catch {
      setError(brand.copy.adminRemoteAuthorizeFailed);
      setIsAuthorizing(false);
    }
  };

  const refreshSystemStatus = async () => {
    setIsRefreshingStatus(true);
    try {
      setSystemStatus(await getSystemStatus());
      setError(null);
    } catch {
      setError(brand.copy.adminStatusRefreshFailed);
    } finally {
      setIsRefreshingStatus(false);
    }
  };

  const startPreheat = async (payload: Parameters<typeof startThumbnailPreheat>[0]) => {
    setIsPreheating(true);
    try {
      const job = await startThumbnailPreheat(payload);
      setPreheatJob(job);
      setError(null);
      pushToast(brand.copy.adminPreheatQueuedToast, "success");
    } catch {
      setError(brand.copy.adminPreheatFailedToast);
    } finally {
      setIsPreheating(false);
    }
  };

  const retryRemote = async (memory: Memory) => {
    if (!memory.primary_file) {
      return;
    }

    setIsRetryingRemote(memory.id);
    try {
      await retryRemoteEntry(memory.primary_file.id);
      setError(null);
      await loadMemories();
    } catch {
      setError(brand.copy.adminStreamFailed);
    } finally {
      setIsRetryingRemote(null);
    }
  };

  if (!isAdmin) {
    return (
      <AdminLoginCard
        error={error}
        onTokenChange={setTokenInput}
        onSubmit={submitToken}
        token={tokenInput}
      />
    );
  }

  return (
    <section aria-labelledby="admin-title" className="page-enter">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold" id="admin-title">
            {brand.copy.adminTitle}
          </h1>
          <p className="mt-2 text-sm text-muted">{brand.copy.adminDescription}</p>
        </div>
        <Button
          onClick={() => void logoutAdmin().then(() => {
            setIsAdmin(false);
            setMemories([]);
            setError(null);
          })}
          variant="secondary"
        >
          <LogOut aria-hidden="true" className="size-4" />
          {brand.copy.adminLogout}
        </Button>
      </div>

      {error ? (
        <Notice className="mt-4" tone="error">
          {error}
        </Notice>
      ) : null}

      {remoteConfig ? (
        <BaiduSetupCard
          configured={remoteConfig.configured}
          authorized={remoteConfig.authorized}
          docsUrl={remoteConfig.docs_url}
          isAuthorizing={isAuthorizing}
          oauthConfigured={remoteConfig.oauth_configured}
          onAuthorize={() => void startAuthorization()}
          redirectUri={remoteConfig.redirect_uri}
          scanDir={remoteConfig.scan_dir}
          tokenExpiresAt={remoteConfig.token_expires_at}
        />
      ) : null}

      <AdminStatusDashboard
        isRefreshing={isRefreshingStatus}
        onRefresh={() => void refreshSystemStatus()}
        status={systemStatus}
      />

      <ThumbnailPreheatCard
        isStarting={isPreheating}
        job={preheatJob}
        onStart={startPreheat}
      />

      <h2 className="section-title mt-12 flex flex-wrap items-center justify-between gap-3">
        <span>{brand.copy.adminAllMemories}</span>
        <Button disabled={isSyncing} onClick={() => void triggerSync()}>
          <RefreshCw aria-hidden="true" className={`size-4 ${isSyncing ? "animate-spin" : ""}`} />
          {isSyncing ? brand.copy.adminSyncing : brand.copy.adminSync}
        </Button>
      </h2>

      {scanTask ? (
        <div className="card mt-4 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{brand.copy.adminRemoteScanTitle}</h3>
              <p className="mt-1 text-xs text-muted">{scanTask.remote_dir}</p>
            </div>
            {scanTask.status === "failed" ? (
              <Button
                disabled={isSyncing}
                onClick={() => void triggerSync(scanTask.id)}
                variant="secondary"
              >
                {brand.copy.adminResumeScan}
              </Button>
            ) : null}
          </div>
          <ProgressBar
            label={brand.copy.adminScanProgress}
            tone={scanTask.status === "failed" ? "danger" : "primary"}
            value={(scanTask.processed_items / scanTask.max_items) * 100}
          />
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminScanStatus}</dt>
              <dd className="text-sm">
                <span className="inline-flex items-center gap-2">
                  <StatusDot
                    tone={
                      scanTask.status === "completed"
                        ? "connected"
                        : scanTask.status === "running"
                          ? "connecting"
                          : "invalid"
                    }
                  />
                  {scanTask.status === "running"
                    ? brand.copy.adminScanRunning
                    : scanTask.status === "completed"
                      ? brand.copy.adminScanCompleted
                      : brand.copy.adminScanFailed}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminScanProgress}</dt>
              <dd className="text-sm">
                {scanTask.processed_items} / {scanTask.max_items}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminScanFiles}</dt>
              <dd className="text-sm">{scanTask.scanned_files}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminScanDirectories}</dt>
              <dd className="text-sm">{scanTask.scanned_directories}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminScanDiscovered}</dt>
              <dd className="text-sm">{scanTask.discovered}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminScanSkipped}</dt>
              <dd className="text-sm">{scanTask.skipped}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.statusDeletedCount}</dt>
              <dd className="text-sm">{lastDeleted}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.statusCompletionTime}</dt>
              <dd className="text-sm">
                {scanTask.completed_at
                  ? formatDateTime(scanTask.completed_at)
                  : scanTask.status === "running"
                    ? brand.copy.adminScanRunning
                    : brand.copy.adminNeverSynced}
              </dd>
            </div>
          </dl>
          {scanTask.failure_reason ? (
            <p className="mt-3 text-sm text-muted">
              <span className="font-medium">{brand.copy.adminScanFailure}: </span>
              {scanTask.failure_reason}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="card mt-4 flex flex-wrap items-center gap-3 p-4">
        <div className="mr-auto">
          <h3 className="text-sm font-semibold">{brand.copy.adminCleanupTitle}</h3>
          <p className="mt-1 text-xs text-muted">{brand.copy.adminCleanupDescription}</p>
        </div>
        <Button
          disabled={isCleaning}
          onClick={() => void prepareCleanup()}
          variant="danger"
        >
          {isCleaning && pendingCleanup === null
            ? brand.copy.adminCleanupRunning
            : brand.copy.adminCleanup}
        </Button>
      </div>

      {cleanupResult ? (
        <dl className="card mt-4 grid grid-cols-2 gap-3 p-4 sm:grid-cols-5">
          <div>
            <dt className="text-xs text-muted">{brand.copy.adminCleanupMemories}</dt>
            <dd className="text-sm">{cleanupResult.stats.memories}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{brand.copy.adminCleanupRemoteIndexes}</dt>
            <dd className="text-sm">{cleanupResult.stats.remote_file_indexes}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{brand.copy.adminCleanupThumbnails}</dt>
            <dd className="text-sm">{cleanupResult.stats.thumbnail_files}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{brand.copy.adminCleanupNginxCache}</dt>
            <dd className="text-sm">{cleanupResult.stats.nginx_cache_files}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{brand.copy.adminCleanupBytes}</dt>
            <dd className="text-sm">{formatBytes(cleanupResult.stats.estimated_bytes_to_free)}</dd>
          </div>
        </dl>
      ) : null}

      {selectedIds.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="mr-auto text-sm text-muted">
            {brand.copy.adminSelectedCount} {selectedIds.length}
          </span>
          <Button onClick={() => setIsBatchEditing(true)}>
            {brand.copy.adminBatchEdit}
          </Button>
          <Button
            disabled={isSyncing}
            onClick={() => void applyBatchUpdate({ ids: selectedIds, status: "published" })}
          >
            {brand.copy.adminBatchPublish}
          </Button>
          <Button
            disabled={isSyncing}
            onClick={() => void applyBatchUpdate({ ids: selectedIds, status: "hidden" })}
            variant="secondary"
          >
            {brand.copy.adminBatchHide}
          </Button>
          <Button
            disabled={isSyncing}
            onClick={() => void exportSelectedReport()}
            variant="secondary"
          >
            {brand.copy.adminExportReport}
          </Button>
        </div>
      ) : null}

      <form className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_170px_150px]" onSubmit={submitAdminSearch}>
        <Input
          id="admin-search"
          label={brand.copy.adminSearchLabel}
          onChange={(event) => setAdminSearchInput(event.target.value)}
          value={adminSearchInput}
        />
        <label className="flex flex-col gap-2 text-sm" htmlFor="admin-kind-filter">
          {brand.copy.adminFilterLabel}
          <select
            className="select min-h-11"
            id="admin-kind-filter"
            onChange={(event) => {
              setAdminKind(event.target.value);
              setAdminPage(1);
            }}
            value={adminKind}
          >
            <option value="">{brand.copy.adminAllMemories}</option>
            <option value="photo">{brand.copy.photoKind}</option>
            <option value="video">{brand.copy.videoKind}</option>
          </select>
        </label>
        <label className="flex flex-col gap-2 text-sm" htmlFor="admin-page-size">
          {brand.copy.adminPageSizeLabel}
          <select
            className="select min-h-11"
            id="admin-page-size"
            onChange={(event) => {
              setAdminPageSize(Number(event.target.value));
              setAdminPage(1);
            }}
            value={adminPageSize}
          >
            {[20, 50, 100].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <button className="sr-only" type="submit">
          {brand.copy.adminSearchLabel}
        </button>
      </form>

      {isLoading ? (
        <div className="shimmer mt-4 h-24 rounded-xl" />
      ) : memories.length === 0 ? (
        <div className="table-shell mt-4">
          <table>
            <tbody>
              <tr className="table-empty-row">
                <td>{brand.copy.adminEmpty}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div className="table-shell mt-4">
          <table>
            <thead>
              <tr>
                <th scope="col">
                  <input
                    aria-label={brand.copy.adminSelectAll}
                    checked={memories.length > 0 && selectedIds.length === memories.length}
                    onChange={toggleAllSelected}
                    type="checkbox"
                  />
                </th>
                <th scope="col">{brand.copy.adminFileHeader}</th>
                <th scope="col">{brand.copy.adminKindHeader}</th>
                <th scope="col">{brand.copy.adminStatusHeader}</th>
                <th scope="col">{brand.copy.adminSyncStatusHeader}</th>
                <th scope="col">{brand.copy.adminRemoteStateHeader}</th>
                <th scope="col">{brand.copy.adminPreviewStateHeader}</th>
                <th scope="col">{brand.copy.adminStreamStateHeader}</th>
                <th scope="col">{brand.copy.adminLastSyncedHeader}</th>
                <th scope="col">{brand.copy.adminActionsHeader}</th>
              </tr>
            </thead>
            <tbody>
              {memories.map((memory) => (
                <tr key={memory.id}>
                  <td>
                    <input
                      aria-label={`${brand.copy.adminSelectMemory} ${memory.title}`}
                      checked={selectedIds.includes(memory.id)}
                      onChange={() => toggleSelected(memory.id)}
                      type="checkbox"
                    />
                  </td>
                  <td>
                    <p className="font-medium">{memory.title}</p>
                    <p className="mt-1 text-xs text-muted">{memory.primary_file?.remote_path}</p>
                  </td>
                  <td>
                    {memory.kind === "video" ? brand.copy.videoKind : brand.copy.photoKind}
                  </td>
                  <td>
                    <StatusBadge status={memory.status} />
                  </td>
                  <td>
                    {memory.primary_file ? (
                      <FileStatusBadge status={memory.primary_file.status} />
                    ) : (
                      brand.copy.fileMissing
                    )}
                  </td>
                  <td>
                    {memory.primary_file ? (
                      <RemoteStateBadge
                        kind="remote"
                        state={memory.primary_file.remote_state}
                      />
                    ) : null}
                  </td>
                  <td>
                    {memory.primary_file ? (
                      <RemoteStateBadge
                        kind="thumbnail"
                        state={memory.primary_file.thumbnail_state}
                      />
                    ) : null}
                  </td>
                  <td>
                    {memory.primary_file ? (
                      <RemoteStateBadge kind="stream" state={memory.primary_file.stream_state} />
                    ) : null}
                  </td>
                  <td>
                    <p className="text-sm">
                      {memory.primary_file?.last_synced_at
                        ? formatDateTime(memory.primary_file.last_synced_at)
                        : brand.copy.adminNeverSynced}
                    </p>
                    {memory.primary_file?.sync_error ? (
                      <p
                        className="mt-1 max-w-64 truncate text-xs text-muted"
                        title={memory.primary_file.sync_error}
                      >
                        {memory.primary_file.sync_error}
                      </p>
                    ) : null}
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      {memory.status !== "published" ? (
                        <Button onClick={() => void changeStatus(memory, "published")}>
                          {brand.copy.adminPublish}
                        </Button>
                      ) : (
                        <Button onClick={() => void changeStatus(memory, "hidden")} variant="secondary">
                          {brand.copy.adminHide}
                        </Button>
                      )}
                      {memory.primary_file?.source === "baidupan" ? (
                        <Button
                          disabled={isRetryingRemote === memory.id}
                          onClick={() => void retryRemote(memory)}
                          variant="secondary"
                        >
                          {brand.copy.adminRetryRemote}
                        </Button>
                      ) : null}
                      <Button onClick={() => setPendingDelete(memory)} variant="danger">
                        {brand.copy.adminDelete}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adminTotal > 0 ? (
        <div className="mt-4 flex justify-center">
          <Pagination
            onPageChange={setAdminPage}
            page={adminPage}
            pageSize={adminPageSize}
            total={adminTotal}
          />
        </div>
      ) : null}

      <Link className="mt-8 inline-flex min-h-11 items-center text-primary" to="/">
        {brand.copy.backHome}
      </Link>

      <Modal onClose={() => setPendingDelete(null)} open={pendingDelete !== null} title={brand.copy.adminDeleteConfirmTitle} tone="danger">
        <p className="mt-3 text-sm text-muted">{brand.copy.adminDeleteConfirmText}</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={() => setPendingDelete(null)} variant="secondary">
            {brand.copy.adminCancel}
          </Button>
          <Button onClick={() => pendingDelete && void removeMemory(pendingDelete)} variant="danger">
            {brand.copy.adminConfirmDelete}
          </Button>
        </div>
      </Modal>

      <Modal
        onClose={() => setIsBatchEditing(false)}
        open={isBatchEditing}
        title={brand.copy.adminBatchEditTitle}
      >
        <div className="mt-4 grid gap-3">
          <Input
            id="batch-title"
            label={brand.copy.adminTitleLabel}
            onChange={(event) => setBatchTitle(event.target.value)}
            value={batchTitle}
          />
          <Input
            id="batch-captured-at"
            label={brand.copy.adminCapturedAtLabel}
            onChange={(event) => setBatchCapturedAt(event.target.value)}
            type="datetime-local"
            value={batchCapturedAt}
          />
          <Input
            id="batch-location"
            label={brand.copy.adminLocationLabel}
            onChange={(event) => setBatchLocation(event.target.value)}
            value={batchLocation}
          />
          <TextArea
            id="batch-description"
            label={brand.copy.adminDescriptionLabel}
            onChange={(event) => setBatchDescription(event.target.value)}
            value={batchDescription}
          />
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={() => setIsBatchEditing(false)} variant="secondary">
            {brand.copy.adminCancel}
          </Button>
          <Button disabled={isSyncing} onClick={() => void submitBatchEdit()}>
            {brand.copy.adminBatchSave}
          </Button>
        </div>
      </Modal>

      <Modal
        onClose={() => setPendingCleanup(null)}
        open={pendingCleanup !== null}
        title={brand.copy.adminCleanupConfirmTitle}
        tone="danger"
      >
        <p className="mt-3 text-sm text-muted">{brand.copy.adminCleanupConfirmText}</p>
        <dl className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-surface-2 p-3">
          <div>
            <dt className="text-xs text-muted">{brand.copy.adminCleanupMemories}</dt>
            <dd className="text-sm">{pendingCleanup?.memories ?? 0}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{brand.copy.adminCleanupRemoteIndexes}</dt>
            <dd className="text-sm">{pendingCleanup?.remote_file_indexes ?? 0}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{brand.copy.adminCleanupScanTasks}</dt>
            <dd className="text-sm">{pendingCleanup?.scan_tasks ?? 0}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{brand.copy.adminCleanupBytes}</dt>
            <dd className="text-sm">{formatBytes(pendingCleanup?.estimated_bytes_to_free ?? 0)}</dd>
          </div>
        </dl>
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={() => setPendingCleanup(null)} variant="secondary">
            {brand.copy.adminCancel}
          </Button>
          <Button disabled={isCleaning} onClick={() => void confirmCleanup()} variant="danger">
            {isCleaning ? brand.copy.adminCleanupRunning : brand.copy.adminCleanupConfirm}
          </Button>
        </div>
      </Modal>

      <ToastViewport onDismiss={dismissToast} toasts={toasts} />
    </section>
  );
}
