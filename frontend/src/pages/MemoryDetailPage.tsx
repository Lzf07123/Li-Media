import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Image as ImageIcon, Images, Video } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import FileStatusBadge from "@/components/FileStatusBadge";
import PhotoPreview from "@/components/PhotoPreview";
import RemoteStateBadge from "@/components/RemoteStateBadge";
import VideoPlayer from "@/components/VideoPlayer";
import Breadcrumb from "@/components/ui/Breadcrumb";
import EmptyState from "@/components/ui/EmptyState";
import MediaSkeleton from "@/components/ui/MediaSkeleton";
import { brand } from "@/lib/brand";
import {
  getMediaDirectLink,
  getMemoryById,
  resolveMediaUrl,
  resolveThumbnailUrl,
  type Memory,
} from "@/lib/api";

export default function MemoryDetailPage() {
  const { memoryId } = useParams();
  const [memory, setMemory] = useState<Memory | null>(null);
  const [directUrl, setDirectUrl] = useState<string | null>(null);
  const [directExpiresAt, setDirectExpiresAt] = useState<string | null>(null);
  const [forceFallback, setForceFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const directUrlRef = useRef<string | null>(null);

  const requestDirectLink = useCallback(async () => {
    if (!memoryId) {
      return;
    }

    try {
      const link = await getMediaDirectLink(memoryId);
      directUrlRef.current = link.direct_url;
      setDirectUrl(link.direct_url);
      setDirectExpiresAt(link.expires_at);
      setForceFallback(false);
    } catch {
      directUrlRef.current = null;
      setDirectUrl(null);
      setForceFallback(true);
    }
  }, [memoryId]);

  useEffect(() => {
    directUrlRef.current = directUrl;
  }, [directUrl]);

  const recoverDirectLink = useCallback(async (brokenUrl?: string | null) => {
    if (!memoryId) {
      return;
    }

    try {
      const link = await getMediaDirectLink(memoryId);
      const currentUrl = directUrlRef.current;

      if (link.direct_url === brokenUrl || (currentUrl && link.direct_url === currentUrl)) {
        directUrlRef.current = null;
        setDirectUrl(null);
        setDirectExpiresAt(null);
        setForceFallback(true);
        return;
      }

      directUrlRef.current = link.direct_url;
      setDirectUrl(link.direct_url);
      setDirectExpiresAt(link.expires_at);
      setForceFallback(false);
    } catch {
      directUrlRef.current = null;
      setDirectUrl(null);
      setForceFallback(true);
    }
  }, [memoryId]);

  useEffect(() => {
    setMemory(null);
    setDirectUrl(null);
    setDirectExpiresAt(null);
    setForceFallback(false);
    directUrlRef.current = null;
    setError(null);

    if (!memoryId) {
      return;
    }

    let active = true;

    getMemoryById(memoryId)
      .then((data) => {
        if (!active) {
          return;
        }

        setMemory(data);
        void requestDirectLink();
      })
      .catch(() => {
        if (active) {
          setError(brand.copy.notFoundTitle);
        }
      });

    return () => {
      active = false;
    };
  }, [memoryId, requestDirectLink]);

  useEffect(() => {
    if (!directExpiresAt) {
      return;
    }

    const expiresAt = Date.parse(directExpiresAt);
    if (!Number.isFinite(expiresAt)) {
      return;
    }

    const delay = Math.max(1000, expiresAt - 30_000 - Date.now());
    const timer = window.setTimeout(() => {
      void requestDirectLink();
    }, delay);

    return () => window.clearTimeout(timer);
  }, [directExpiresAt, requestDirectLink]);

  if (error || (!memory && !error)) {
    return error ? (
      <div className="mt-8">
        <EmptyState art={Images}>
          {error}
          <Link className="empty-state-action text-primary" to="/">
            {brand.copy.backHome}
          </Link>
        </EmptyState>
      </div>
    ) : (
      <MediaSkeleton count={1} />
    );
  }

  if (!memory) {
    return null;
  }

  const fileStatus = memory.primary_file?.status;
  const remoteState = memory.primary_file?.remote_state;
  const thumbnailState = memory.primary_file?.thumbnail_state;
  const streamState = memory.primary_file?.stream_state;
  const serverMediaUrl = memory.file_url;
  const mediaSource = forceFallback || !directUrl ? serverMediaUrl : directUrl;
  const highThumbnail = resolveThumbnailUrl(memory.thumbnail_url, "large");
  const statusValues = [remoteState, thumbnailState, streamState].filter(Boolean);
  const hasFailure = statusValues.some((value) => value === "failed" || value === "missing");
  const summaryTone = hasFailure ? "warning" : "ready";
  const summaryText = hasFailure ? brand.copy.statusHasFailure : brand.copy.statusAllReady;

  const handleSourceError = () => {
    if (directUrl && !forceFallback) {
      setForceFallback(true);
      setDirectUrl(null);
      directUrlRef.current = null;
      void recoverDirectLink(directUrl);
      return;
    }

    setForceFallback(true);
  };

  return (
    <article className="page-enter detail-shell">
      <Breadcrumb
        items={[
          { children: brand.copy.breadcrumbHome, href: "/" },
          { children: brand.copy.breadcrumbLibrary, href: "/" },
          { children: brand.copy.breadcrumbDetail },
        ]}
      />

      <div className="card detail-media-card overflow-hidden p-0">
        <div className="detail-media-shell bg-surface-2">
          {memory.kind === "video" ? (
            memory.primary_file?.stream_state === "ready" && mediaSource ? (
              <VideoPlayer
                dimensions={null}
                duration={null}
                onSourceError={handleSourceError}
                poster={resolveThumbnailUrl(memory.thumbnail_url, "large") ?? undefined}
                src={resolveMediaUrl(mediaSource)}
              />
            ) : (
              <div
                aria-hidden="true"
                className="flex min-h-72 items-center justify-center text-muted"
              >
                <Video className="size-10" />
              </div>
            )
          ) : mediaSource ? (
            <PhotoPreview
              alt={brand.copy.detailPreviewAlt}
              fullSrc={resolveMediaUrl(mediaSource)}
              onSourceError={handleSourceError}
              serverSrc={resolveMediaUrl(serverMediaUrl)}
              thumbnailSrc={highThumbnail}
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex min-h-72 items-center justify-center text-muted"
            >
              <ImageIcon className="size-10" />
            </div>
          )}
        </div>
      </div>

      <div className="status-card mt-4">
        <button
          aria-controls="detail-status"
          aria-expanded={statusOpen}
          className="status-summary"
          id="detail-status-summary"
          onClick={() => setStatusOpen((current) => !current)}
          type="button"
        >
          <span
            aria-live="polite"
            className={`badge ${summaryTone === "ready" ? "badge-success" : "badge-warning"}`}
          >
            {summaryText}
          </span>
          <span className="status-summary-label">
            {statusOpen ? brand.copy.statusSummaryLabel : brand.copy.statusDetail}
            <ChevronDown
              aria-hidden="true"
              className={`ml-1 size-4 transition-transform ${statusOpen ? "rotate-180" : ""}`}
            />
          </span>
        </button>

        {statusOpen ? (
          <div
            aria-label={brand.copy.detailStatusLabel}
            className="status-strip mt-3"
            id="detail-status"
            role="list"
          >
            <div className="flex items-center gap-2" role="listitem">
              <span className="text-xs text-muted">{brand.copy.detailFileStatusLabel}</span>
              {fileStatus ? <FileStatusBadge status={fileStatus} /> : null}
            </div>
            <div className="flex items-center gap-2" role="listitem">
              <span className="text-xs text-muted">{brand.copy.detailRemoteState}</span>
              {remoteState ? <RemoteStateBadge kind="remote" state={remoteState} /> : null}
            </div>
            <div className="flex items-center gap-2" role="listitem">
              <span className="text-xs text-muted">{brand.copy.detailPreviewState}</span>
              {thumbnailState ? (
                <RemoteStateBadge kind="thumbnail" state={thumbnailState} />
              ) : null}
            </div>
            <div className="flex items-center gap-2" role="listitem">
              <span className="text-xs text-muted">{brand.copy.detailStreamState}</span>
              {streamState ? <RemoteStateBadge kind="stream" state={streamState} /> : null}
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}
