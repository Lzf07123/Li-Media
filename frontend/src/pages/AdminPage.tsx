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
  cancelThumbnailPreheat,
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
  previewBatchStatusChange,
  startBatchStatusChange,
  getLatestBatchStatusJob,
  cancelBatchStatusJob,
  startBrowserCompatibilityProbe,
  getLatestBrowserCompatibilityProbe,
  cancelBrowserCompatibilityProbe,
  type Memory,
  type AdminBackgroundJob,
  type AdminBatchPreview,
  type RemoteConfig,
  type RemoteScanTask,
  type CleanupResult,
  type CleanupStats,
  type SystemStatus,
  type ThumbnailPreheatJob,
} from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
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
  const [isCancellingPreheat, setIsCancellingPreheat] = useState(false);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pendingDelete, setPendingDelete] = useState<Memory | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [adminKind, setAdminKind] = useState("");
  const [adminDisplay, setAdminDisplay] = useState("");
  const [adminCompatibility, setAdminCompatibility] = useState("");
  const [adminStatus, setAdminStatus] = useState("");
  const [adminSearch, setAdminSearch] = useState("");
  const [adminSearchInput, setAdminSearchInput] = useState("");
  const [adminPage, setAdminPage] = useState(1);
  const [adminPageSize, setAdminPageSize] = useState(50);
  const [adminTotal, setAdminTotal] = useState(0);
  const [displayCounts, setDisplayCounts] = useState({
    displayable: 0,
    excluded: 0,
  });
  const [globalCounts, setGlobalCounts] = useState({ photo: 0, video: 0 });
  const [statusCounts, setStatusCounts] = useState({
    published: 0,
    unpublished: 0,
  });
  const [browserCounts, setBrowserCounts] = useState({
    supported: 0,
    unsupported: 0,
    unknown: 0,
  });
  const [batchJob, setBatchJob] = useState<AdminBackgroundJob | null>(null);
  const [pendingBatchAction, setPendingBatchAction] = useState<
    "published" | "hidden" | null
  >(null);
  const [pendingBatchPreview, setPendingBatchPreview] =
    useState<AdminBatchPreview | null>(null);
  const [isPreparingBatch, setIsPreparingBatch] = useState(false);
  const [isStartingBatch, setIsStartingBatch] = useState(false);
  const [isCancellingBatch, setIsCancellingBatch] = useState(false);
  const [probeJob, setProbeJob] = useState<AdminBackgroundJob | null>(null);
  const [isProbing, setIsProbing] = useState(false);
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
        display: adminDisplay || undefined,
        compatibility: adminCompatibility || undefined,
        status: adminStatus || undefined,
        page: adminPage,
        page_size: adminPageSize,
      });
      setMemories(data.items);
      setAdminTotal(data.total);
      setDisplayCounts(data.display_counts);
      setGlobalCounts(data.global_counts ?? { photo: 0, video: 0 });
      setStatusCounts(data.status_counts ?? { published: 0, unpublished: 0 });
      setBrowserCounts(
        data.browser_counts ?? { supported: 0, unsupported: 0, unknown: 0 },
      );
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
      try {
        setBatchJob(await getLatestBatchStatusJob());
      } catch {
        setBatchJob(null);
      }
      try {
        setProbeJob(await getLatestBrowserCompatibilityProbe());
      } catch {
        setProbeJob(null);
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
  }, [
    adminCompatibility,
    adminDisplay,
    adminKind,
    adminPage,
    adminPageSize,
    adminSearch,
    adminStatus,
  ]);

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
    if (batchJob?.status !== "queued" && batchJob?.status !== "running") {
      return;
    }

    const timer = window.setInterval(async () => {
      const nextJob = await getLatestBatchStatusJob();
      setBatchJob(nextJob);
      if (nextJob?.status !== "queued" && nextJob?.status !== "running") {
        await loadMemories();
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [batchJob?.status, loadMemories]);

  useEffect(() => {
    if (probeJob?.status !== "queued" && probeJob?.status !== "running") {
      return;
    }

    const timer = window.setInterval(async () => {
      const nextJob = await getLatestBrowserCompatibilityProbe();
      setProbeJob(nextJob);
      if (nextJob?.status !== "queued" && nextJob?.status !== "running") {
        await loadMemories();
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [probeJob?.status, loadMemories]);

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

  const prepareBatchStatusChange = async (targetStatus: "published" | "hidden") => {
    setIsPreparingBatch(true);
    setPendingBatchAction(targetStatus);
    try {
      const preview = await previewBatchStatusChange({
        kind: adminKind === "photo" || adminKind === "video" ? adminKind : undefined,
        keyword: adminSearch || undefined,
        display:
          adminDisplay === "displayable" || adminDisplay === "excluded"
            ? adminDisplay
            : undefined,
        compatibility:
          adminCompatibility === "supported" ||
          adminCompatibility === "unsupported" ||
          adminCompatibility === "unknown"
            ? adminCompatibility
            : undefined,
        status:
          adminStatus === "published" || adminStatus === "hidden"
            ? adminStatus
            : undefined,
      });
      setPendingBatchPreview(preview);
      setError(null);
    } catch {
      setPendingBatchAction(null);
      setPendingBatchPreview(null);
      setError(brand.copy.adminBatchFilterFailed);
    } finally {
      setIsPreparingBatch(false);
    }
  };

  const confirmBatchStatusChange = async () => {
    if (!pendingBatchAction) {
      return;
    }
    setIsStartingBatch(true);
    try {
      const job = await startBatchStatusChange({
        kind: adminKind === "photo" || adminKind === "video" ? adminKind : undefined,
        keyword: adminSearch || undefined,
        display:
          adminDisplay === "displayable" || adminDisplay === "excluded"
            ? adminDisplay
            : undefined,
        compatibility:
          adminCompatibility === "supported" ||
          adminCompatibility === "unsupported" ||
          adminCompatibility === "unknown"
            ? adminCompatibility
            : undefined,
        status:
          adminStatus === "published" || adminStatus === "hidden"
            ? adminStatus
            : undefined,
        target_status: pendingBatchAction,
        confirm: true,
      });
      setBatchJob(job);
      setPendingBatchAction(null);
      setPendingBatchPreview(null);
      setError(null);
      pushToast(brand.copy.adminBatchFilterQueued, "success");
    } catch {
      setError(brand.copy.adminBatchFilterFailed);
    } finally {
      setIsStartingBatch(false);
    }
  };

  const cancelBatchJob = async () => {
    if (!batchJob) {
      return;
    }
    setIsCancellingBatch(true);
    try {
      setBatchJob(await cancelBatchStatusJob(batchJob.id));
      setError(null);
    } catch {
      setError(brand.copy.adminBatchFilterFailed);
    } finally {
      setIsCancellingBatch(false);
    }
  };

  const startCompatibilityProbe = async () => {
    setIsProbing(true);
    try {
      const job = await startBrowserCompatibilityProbe(25);
      setProbeJob(job);
      setError(null);
      pushToast(brand.copy.adminCompatibilityProbeQueued, "success");
    } catch {
      setError(brand.copy.adminCompatibilityProbeFailed);
    } finally {
      setIsProbing(false);
    }
  };

  const cancelCompatibilityProbe = async () => {
    if (!probeJob) {
      return;
    }
    setIsProbing(true);
    try {
      setProbeJob(await cancelBrowserCompatibilityProbe(probeJob.id));
    } catch {
      setError(brand.copy.adminCompatibilityProbeFailed);
    } finally {
      setIsProbing(false);
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

  const cancelPreheat = async () => {
    if (!preheatJob) {
      return;
    }
    setIsCancellingPreheat(true);
    try {
      const job = await cancelThumbnailPreheat(preheatJob.id);
      setPreheatJob(job);
      setError(null);
    } catch {
      setError(brand.copy.adminPreheatFailedToast);
    } finally {
      setIsCancellingPreheat(false);
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
        isCancelling={isCancellingPreheat}
        job={preheatJob}
        onCancel={() => void cancelPreheat()}
        onStart={startPreheat}
      />

      <h2 className="section-title mt-12 flex flex-wrap items-center justify-between gap-3">
        <span>{brand.copy.adminAllMemories}</span>
        <Button disabled={isSyncing} onClick={() => void triggerSync()}>
          <RefreshCw aria-hidden="true" className={`size-4 ${isSyncing ? "animate-spin" : ""}`} />
          {isSyncing ? brand.copy.adminSyncing : brand.copy.adminSync}
        </Button>
      </h2>

      <div className="mt-4 flex flex-wrap gap-3">
        <dl className="card min-w-52 flex-1 p-4" aria-label={brand.copy.adminGlobalCountsLabel}>
          <dt className="text-xs text-muted">{brand.copy.adminGlobalCountsLabel}</dt>
          <dd className="mt-1 text-lg font-semibold">
            {globalCounts.photo + globalCounts.video} / {globalCounts.photo} / {globalCounts.video}
          </dd>
        </dl>
        <dl className="card min-w-52 flex-1 p-4" aria-label={brand.copy.adminDisplayHealthSummary}>
          <dt className="text-xs text-muted">{brand.copy.adminDisplayHealthSummary}</dt>
          <dd className="mt-1 text-lg font-semibold">
            {displayCounts.displayable} / {displayCounts.excluded}
          </dd>
        </dl>
        <dl className="card min-w-52 flex-1 p-4" aria-label={brand.copy.adminCompatibilitySummary}>
          <dt className="text-xs text-muted">{brand.copy.adminCompatibilitySummary}</dt>
          <dd className="mt-1 text-lg font-semibold">
            {browserCounts.supported} / {browserCounts.unsupported} / {browserCounts.unknown}
          </dd>
        </dl>
        <dl className="card min-w-52 flex-1 p-4" aria-label={brand.copy.statusPublished}>
          <dt className="text-xs text-muted">{brand.copy.statusPublished} / {brand.copy.statusHidden}</dt>
          <dd className="mt-1 text-lg font-semibold">
            {statusCounts.published} / {statusCounts.unpublished}
          </dd>
        </dl>
      </div>

      <div className="card mt-4 flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <h3 className="text-sm font-semibold">
            {brand.copy.adminCompatibilityProbeTitle}
          </h3>
          <p className="mt-1 text-xs text-muted">
            {brand.copy.adminCompatibilityProbeDescription}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            disabled={isProbing || probeJob?.status === "running" || probeJob?.status === "queued"}
            onClick={() => void startCompatibilityProbe()}
          >
            {isProbing
              ? brand.copy.adminCompatibilityProbing
              : brand.copy.adminCompatibilityProbe}
          </Button>
          {probeJob?.status === "running" || probeJob?.status === "queued" ? (
            <Button
              disabled={isProbing}
              onClick={() => void cancelCompatibilityProbe()}
              variant="secondary"
            >
              {brand.copy.adminBatchJobCancel}
            </Button>
          ) : null}
        </div>
      </div>

      {probeJob ? (
        <div className="card mt-4 p-4">
          <ProgressBar
            label={brand.copy.adminCompatibilityProbeTitle}
            tone={probeJob.status === "failed" ? "danger" : "primary"}
            value={probeJob.total ? (probeJob.processed / probeJob.total) * 100 : 0}
          />
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminScanStatus}</dt>
              <dd className="text-sm">{probeJob.status}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminScanProgress}</dt>
              <dd className="text-sm">{probeJob.processed} / {probeJob.total}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminBatchJobChanged}</dt>
              <dd className="text-sm">{probeJob.changed}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminBatchJobFailed}</dt>
              <dd className="text-sm">{probeJob.failed}</dd>
            </div>
          </dl>
        </div>
      ) : null}

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

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          disabled={isPreparingBatch || batchJob?.status === "running"}
          onClick={() => void prepareBatchStatusChange("published")}
        >
          {brand.copy.adminBatchPublishFilter}
        </Button>
        <Button
          disabled={isPreparingBatch || batchJob?.status === "running"}
          onClick={() => void prepareBatchStatusChange("hidden")}
          variant="secondary"
        >
          {brand.copy.adminBatchHideFilter}
        </Button>
      </div>

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

      <form
        className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_170px_190px_190px_170px_150px]"
        onSubmit={submitAdminSearch}
      >
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
        <label className="flex flex-col gap-2 text-sm" htmlFor="admin-compatibility-filter">
          {brand.copy.adminCompatibilityFilterLabel}
          <select
            className="select min-h-11"
            id="admin-compatibility-filter"
            onChange={(event) => {
              setAdminCompatibility(event.target.value);
              setAdminPage(1);
            }}
            value={adminCompatibility}
          >
            <option value="">
              {brand.copy.adminCompatibilitySummary}: {browserCounts.supported}/
              {browserCounts.unsupported}/{browserCounts.unknown}
            </option>
            <option value="supported">{brand.copy.adminCompatibilitySupported}</option>
            <option value="unsupported">{brand.copy.adminCompatibilityUnsupported}</option>
            <option value="unknown">{brand.copy.adminCompatibilityUnknown}</option>
          </select>
        </label>
        <label className="flex flex-col gap-2 text-sm" htmlFor="admin-status-filter">
          {brand.copy.adminStatusHeader}
          <select
            className="select min-h-11"
            id="admin-status-filter"
            onChange={(event) => {
              setAdminStatus(event.target.value);
              setAdminPage(1);
            }}
            value={adminStatus}
          >
            <option value="">
              {brand.copy.statusPublished} / {brand.copy.statusHidden}
            </option>
            <option value="published">{brand.copy.statusPublished}</option>
            <option value="hidden">{brand.copy.statusHidden}</option>
          </select>
        </label>
        <label className="flex flex-col gap-2 text-sm" htmlFor="admin-display-filter">
          {brand.copy.adminDisplayHealthLabel}
          <select
            className="select min-h-11"
            id="admin-display-filter"
            onChange={(event) => {
              setAdminDisplay(event.target.value);
              setAdminPage(1);
            }}
            value={adminDisplay}
          >
            <option value="">
              {brand.copy.adminDisplayHealthSummary}: {displayCounts.displayable}/
              {displayCounts.excluded}
            </option>
            <option value="displayable">{brand.copy.adminDisplayable}</option>
            <option value="excluded">{brand.copy.adminDisplayExcluded}</option>
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
                <th scope="col">{brand.copy.adminCompatibilityHeader}</th>
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
                    <div className="mt-2">
                      {memory.media_display_state === "excluded" ? (
                        <Badge tone="danger">{brand.copy.adminDisplayExcluded}</Badge>
                      ) : (
                        <Badge tone="success">{brand.copy.adminDisplayable}</Badge>
                      )}
                    </div>
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
                    {memory.primary_file?.thumbnail_failure_kind ? (
                      <p
                        className="mt-1 max-w-32 truncate text-xs text-muted"
                        title={
                          brand.copy.adminThumbnailFailureReasons[
                            memory.primary_file.thumbnail_failure_kind as keyof typeof brand.copy.adminThumbnailFailureReasons
                          ] ?? memory.primary_file.thumbnail_failure_kind
                        }
                      >
                        {
                          brand.copy.adminThumbnailFailureReasons[
                            memory.primary_file.thumbnail_failure_kind as keyof typeof brand.copy.adminThumbnailFailureReasons
                          ]
                        }
                      </p>
                    ) : null}
                  </td>
                  <td>
                    {memory.primary_file ? (
                      <RemoteStateBadge kind="stream" state={memory.primary_file.stream_state} />
                    ) : null}
                  </td>
                  <td>
                    {memory.primary_file?.browser_compatibility === "supported" ? (
                      <Badge tone="success">
                        {brand.copy.adminCompatibilitySupported}
                      </Badge>
                    ) : memory.primary_file?.browser_compatibility === "unsupported" ? (
                      <Badge tone="danger">
                        {brand.copy.adminCompatibilityUnsupported}
                      </Badge>
                    ) : (
                      <Badge tone="warning">
                        {brand.copy.adminCompatibilityUnknown}
                      </Badge>
                    )}
                    {memory.primary_file?.browser_compatibility_error ? (
                      <p
                        className="mt-1 max-w-32 truncate text-xs text-muted"
                        title={memory.primary_file.browser_compatibility_error}
                      >
                        {memory.primary_file.browser_compatibility_error}
                      </p>
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

      {batchJob ? (
        <div className="card mt-4 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">
                {brand.copy.adminBatchJobTitle}
              </h3>
              <p className="mt-1 text-xs text-muted">{batchJob.action}</p>
            </div>
            {batchJob.status === "running" || batchJob.status === "queued" ? (
              <Button
                disabled={isCancellingBatch}
                onClick={() => void cancelBatchJob()}
                variant="secondary"
              >
                {brand.copy.adminBatchJobCancel}
              </Button>
            ) : null}
          </div>
          <ProgressBar
            label={brand.copy.adminScanProgress}
            tone={batchJob.status === "failed" ? "danger" : "primary"}
            value={batchJob.total ? (batchJob.processed / batchJob.total) * 100 : 0}
          />
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminScanStatus}</dt>
              <dd className="text-sm">{batchJob.status}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminScanProgress}</dt>
              <dd className="text-sm">{batchJob.processed} / {batchJob.total}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminBatchJobChanged}</dt>
              <dd className="text-sm">{batchJob.changed}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminBatchJobSkipped}</dt>
              <dd className="text-sm">{batchJob.skipped}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{brand.copy.adminBatchJobFailed}</dt>
              <dd className="text-sm">{batchJob.failed}</dd>
            </div>
          </dl>
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
        onClose={() => {
          setPendingBatchAction(null);
          setPendingBatchPreview(null);
        }}
        open={pendingBatchAction !== null && pendingBatchPreview !== null}
        title={brand.copy.adminBatchFilterConfirmTitle}
        tone={pendingBatchAction === "hidden" ? "danger" : "info"}
      >
        {pendingBatchPreview?.is_full_library ? (
          <p className="mt-3 text-sm font-medium text-destructive">
            {brand.copy.adminBatchFilterAllWarning}
          </p>
        ) : null}
        <dl className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-surface-2 p-3">
          <div>
            <dt className="text-xs text-muted">{brand.copy.adminBatchFilterScope}</dt>
            <dd className="text-sm">
              {pendingBatchPreview?.filter_snapshot.kind as string} /{" "}
              {pendingBatchPreview?.filter_snapshot.display as string}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{brand.copy.adminBatchFilterTotal}</dt>
            <dd className="text-sm">{pendingBatchPreview?.total ?? 0}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{brand.copy.adminBatchFilterKind}</dt>
            <dd className="text-sm">
              {pendingBatchPreview?.counts.photo ?? 0} /{" "}
              {pendingBatchPreview?.counts.video ?? 0}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{brand.copy.adminBatchFilterStatus}</dt>
            <dd className="text-sm">
              {pendingBatchPreview?.status_counts.published ?? 0} /{" "}
              {pendingBatchPreview?.status_counts.unpublished ?? 0}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{brand.copy.adminBatchFilterDisplay}</dt>
            <dd className="text-sm">
              {pendingBatchPreview?.display_counts.displayable ?? 0} /{" "}
              {pendingBatchPreview?.display_counts.excluded ?? 0}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{brand.copy.adminBatchFilterBrowser}</dt>
            <dd className="text-sm">
              {pendingBatchPreview?.browser_counts.supported ?? 0} /{" "}
              {pendingBatchPreview?.browser_counts.unsupported ?? 0} /{" "}
              {pendingBatchPreview?.browser_counts.unknown ?? 0}
            </dd>
          </div>
        </dl>
        <div className="mt-6 flex justify-end gap-2">
          <Button
            onClick={() => {
              setPendingBatchAction(null);
              setPendingBatchPreview(null);
            }}
            variant="secondary"
          >
            {brand.copy.adminBatchFilterCancel}
          </Button>
          <Button
            disabled={isStartingBatch}
            onClick={() => void confirmBatchStatusChange()}
            variant={pendingBatchAction === "hidden" ? "danger" : "primary"}
          >
            {brand.copy.adminBatchFilterConfirm}
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
