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
  type Memory,
} from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import Notice from "@/components/ui/Notice";
import { ToastViewport, type Toast } from "@/components/ui/Toast";

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
  const [file, setFile] = useState<File | null>(null);
  const [formResetKey, setFormResetKey] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pendingDelete, setPendingDelete] = useState<Memory | null>(null);

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

    if (!file) {
      setError(brand.copy.adminSelectFile);
      return;
    }

    setIsUploading(true);
    try {
      await createMemory({
        file,
        title,
        description,
        location: location || undefined,
        captured_at: capturedAt || undefined,
      });
      setTitle("");
      setDescription("");
      setLocation("");
      setCapturedAt("");
      setFile(null);
      setFormResetKey((current) => current + 1);
      setError(null);
      pushToast(brand.copy.adminUploadSuccess, "success");
      await loadMemories();
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : brand.copy.adminUploadFailed,
      );
    } finally {
      setIsUploading(false);
    }
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
      await loadMemories();
    } catch {
      setError(brand.copy.adminDeleteFailed);
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
        file={file}
        isUploading={isUploading}
        key={formResetKey}
        location={location}
        title={title}
        onCapturedAtChange={setCapturedAt}
        onDescriptionChange={setDescription}
        onFileChange={setFile}
        onLocationChange={setLocation}
        onTitleChange={setTitle}
        onSubmit={submitMemory}
      />

      <h2 className="section-title mt-12 flex flex-wrap items-center justify-between gap-3">
        <span>{brand.copy.adminAllMemories}</span>
        <Button disabled={isSyncing} onClick={() => void triggerSync()}>
          <RefreshCw aria-hidden="true" className={`size-4 ${isSyncing ? "animate-spin" : ""}`} />
          {isSyncing ? brand.copy.adminSyncing : brand.copy.adminSync}
        </Button>
      </h2>

      {isLoading ? (
        <div className="shimmer mt-4 h-24 rounded-xl" />
      ) : memories.length === 0 ? (
        <p className="mt-4 text-sm text-muted">{brand.copy.adminEmpty}</p>
      ) : (
        <div className="table-shell mt-4">
          <table>
            <thead>
              <tr>
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

      <ToastViewport onDismiss={dismissToast} toasts={toasts} />
    </section>
  );
}
