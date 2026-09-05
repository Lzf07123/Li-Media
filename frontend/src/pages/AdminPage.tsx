import { useCallback, useEffect, useState, type FormEvent } from "react";
import { RefreshCw } from "lucide-react";
import { LogOut } from "lucide-react";
import { Link } from "react-router-dom";

import AdminLoginCard from "@/components/AdminLoginCard";
import FileStatusBadge from "@/components/FileStatusBadge";
import MemoryUploadForm from "@/components/MemoryUploadForm";
import StatusBadge from "@/components/StatusBadge";
import { brand } from "@/lib/brand";
import {
  createMemory,
  deleteMemory,
  getAdminMemories,
  loginAdmin,
  logoutAdmin,
  syncMemories,
  updateMemory,
  batchUpdateMemories,
  exportMemories,
  type Memory,
} from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import Notice from "@/components/ui/Notice";
import { ToastViewport, type Toast } from "@/components/ui/Toast";
import { Input, TextArea } from "@/components/ui/Input";

type UploadStatus = "pending" | "uploading" | "success" | "failed";

type UploadQueueItem = {
  key: string;
  file: File;
  status: UploadStatus;
  error?: string;
};

export default function AdminPage() {
  const [tokenInput, setTokenInput] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [capturedAt, setCapturedAt] = useState("");
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [formResetKey, setFormResetKey] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pendingDelete, setPendingDelete] = useState<Memory | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isBatchEditing, setIsBatchEditing] = useState(false);
  const [batchTitle, setBatchTitle] = useState("");
  const [batchDescription, setBatchDescription] = useState("");
  const [batchLocation, setBatchLocation] = useState("");
  const [batchCapturedAt, setBatchCapturedAt] = useState("");

  const uploadKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

  const uploadQueueItem = async (item: UploadQueueItem) => {
    setUploadQueue((current) =>
      current.map((entry) =>
        entry.key === item.key
          ? { ...entry, status: "uploading", error: undefined }
          : entry,
      ),
    );

    try {
      await createMemory({
        file: item.file,
        title,
        description,
        location: location || undefined,
        captured_at: capturedAt || undefined,
      });
      setUploadQueue((current) =>
        current.map((entry) =>
          entry.key === item.key
            ? { ...entry, status: "success", error: undefined }
            : entry,
        ),
      );
      return true;
    } catch (uploadError) {
      setUploadQueue((current) =>
        current.map((entry) =>
          entry.key === item.key
            ? {
                ...entry,
                status: "failed",
                error:
                  uploadError instanceof Error
                    ? uploadError.message
                    : brand.copy.adminUploadFailed,
              }
            : entry,
        ),
      );
      return false;
    }
  };

  const pushToast = (message: string, tone: Toast["tone"]) => {
    setToasts((current) => [...current, { id: Date.now(), message, tone }]);
  };

  const dismissToast = (id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  };

  const loadMemories = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getAdminMemories();
      setMemories(data.items);
      setIsAdmin(true);
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
  }, []);

  useEffect(() => {
    void loadMemories();
  }, [loadMemories]);

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

  const submitMemory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (uploadQueue.length === 0) {
      setError(brand.copy.adminSelectFile);
      return;
    }

    setIsUploading(true);
    let hasFailure = false;
    for (const item of uploadQueue) {
      const succeeded = await uploadQueueItem(item);
      if (!succeeded) {
        hasFailure = true;
      }
    }
    setError(hasFailure ? brand.copy.adminUploadFailed : null);
    await loadMemories();
    setIsUploading(false);
  };

  const retryUpload = async (item: UploadQueueItem) => {
    setIsUploading(true);
    const succeeded = await uploadQueueItem(item);
    setError(succeeded ? null : brand.copy.adminUploadFailed);
    await loadMemories();
    setIsUploading(false);
  };

  const clearUploadQueue = () => {
    if (isUploading) {
      return;
    }
    setUploadQueue([]);
    setTitle("");
    setDescription("");
    setLocation("");
    setCapturedAt("");
    setFormResetKey((current) => current + 1);
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

  const triggerSync = async () => {
    setIsSyncing(true);
    try {
      await syncMemories();
      setError(null);
      pushToast(brand.copy.adminSyncSuccess, "success");
      await loadMemories();
    } catch {
      setError(brand.copy.adminSyncFailed);
    } finally {
      setIsSyncing(false);
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
    <section aria-labelledby="admin-title">
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

      <MemoryUploadForm
        capturedAt={capturedAt}
        description={description}
        files={uploadQueue.map((item) => item.file)}
        isUploading={isUploading}
        key={formResetKey}
        location={location}
        title={title}
        onCapturedAtChange={setCapturedAt}
        onDescriptionChange={setDescription}
        onFilesChange={(files) =>
          setUploadQueue(
            files.map((file) => ({
              key: uploadKey(file),
              file,
              status: "pending",
            })),
          )
        }
        onLocationChange={setLocation}
        onTitleChange={setTitle}
        onSubmit={submitMemory}
      />

      {uploadQueue.length > 0 ? (
        <div className="card mt-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">{brand.copy.adminUploadQueue}</h3>
            <Button onClick={clearUploadQueue} variant="ghost">
              {brand.copy.adminCancel}
            </Button>
          </div>
          <ul className="mt-3 space-y-2">
            {uploadQueue.map((item) => (
              <li
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 p-3"
                key={item.key}
              >
                <span className="min-w-0 text-sm">
                  <span className="block truncate">{item.file.name}</span>
                  <span className="text-xs text-muted">
                    {item.status === "pending"
                      ? brand.copy.adminUploadPending
                      : item.status === "uploading"
                        ? brand.copy.adminUploadUploading
                        : item.status === "success"
                          ? brand.copy.adminUploadSuccessItem
                          : brand.copy.adminUploadFailedItem}
                  </span>
                </span>
                {item.error ? (
                  <span className="max-w-full truncate text-xs text-muted" title={item.error}>
                    {item.error}
                  </span>
                ) : null}
                {item.status === "failed" ? (
                  <Button
                    disabled={isUploading}
                    onClick={() => void retryUpload(item)}
                    variant="secondary"
                  >
                    {brand.copy.adminRetryUpload}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <h2 className="section-title mt-12 flex flex-wrap items-center justify-between gap-3">
        <span>{brand.copy.adminAllMemories}</span>
        <Button disabled={isSyncing} onClick={() => void triggerSync()}>
          <RefreshCw aria-hidden="true" className={`size-4 ${isSyncing ? "animate-spin" : ""}`} />
          {isSyncing ? brand.copy.adminSyncing : brand.copy.adminSync}
        </Button>
      </h2>

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

      {isLoading ? (
        <div className="shimmer mt-4 h-24 rounded-xl" />
      ) : memories.length === 0 ? (
        <p className="mt-4 text-sm text-muted">{brand.copy.adminEmpty}</p>
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

      <ToastViewport onDismiss={dismissToast} toasts={toasts} />
    </section>
  );
}
