import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Download, Play, RefreshCw, TriangleAlert, X } from "lucide-react";

import VideoPlayer from "@/components/VideoPlayer";
import {
  getMediaDirectLink,
  resolveMediaUrl,
  resolveThumbnailUrl,
  type Memory,
} from "@/lib/api";
import { brand } from "@/lib/brand";

type MediaViewerProps = {
  memory: Memory;
  onClose: () => void;
};

type PlaybackSource = {
  kind: "direct" | "server";
  src: string;
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

export default function MediaViewer({ memory, onClose }: MediaViewerProps) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const pinchOrigin = useRef<{ distance: number; zoom: number } | null>(null);
  const playbackTask = useRef(0);
  const recoveredDirectLink = useRef(false);
  const isRecoveringPlayback = useRef(false);
  const refreshedDirectUrl = useRef<string | null>(null);
  const downloadRetried = useRef(false);

  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [photoLargeSrc, setPhotoLargeSrc] = useState<string | null>(null);
  const [smallImageReady, setSmallImageReady] = useState(false);
  const [smallImageFailed, setSmallImageFailed] = useState(false);
  const [photoState, setPhotoState] = useState<"loading" | "ready" | "error">("loading");
  const [photoRetryKey, setPhotoRetryKey] = useState(0);

  const [playbackSource, setPlaybackSource] = useState<PlaybackSource | null>(null);
  const [playbackState, setPlaybackState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [playbackRetryKey, setPlaybackRetryKey] = useState(0);
  const [directExpiresAt, setDirectExpiresAt] = useState<string | null>(null);
  const [directLinkFailed, setDirectLinkFailed] = useState(false);

  const [downloadState, setDownloadState] = useState<"idle" | "loading" | "error">("idle");

  const smallSrc = resolveThumbnailUrl(memory.thumbnail_url, "small");
  const largeSrc = resolveThumbnailUrl(memory.thumbnail_url, "large");
  const isVideo = memory.kind === "video";
  const fileStatus = memory.primary_file?.status;
  const remoteState = memory.primary_file?.remote_state;
  const thumbnailState = memory.primary_file?.thumbnail_state;
  const streamState = memory.primary_file?.stream_state;
  const hasIndexFailure = [fileStatus, remoteState, thumbnailState, streamState].some(
    (value) => value === "failed" || value === "missing" || value === "unavailable",
  );
  const statusText = hasIndexFailure
    ? brand.copy.viewerStatusFailed
    : photoState === "error" || playbackState === "error" || downloadState === "error"
      ? brand.copy.viewerStatusRetrying
      : photoState === "loading" || playbackState === "loading"
        ? brand.copy.viewerStatusLoading
        : brand.copy.viewerStatusReady;

  const resetTransform = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const clampZoom = useCallback((value: number) => {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    viewerRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
    };
  }, []);

  useEffect(() => {
    if (isVideo) {
      return;
    }

    setPhotoLargeSrc(null);
    setSmallImageReady(false);
    setSmallImageFailed(false);
    setPhotoState(smallSrc ? "loading" : "error");
    resetTransform();
    if (!largeSrc) {
      return;
    }

    let active = true;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (!active) {
        return;
      }
      setPhotoLargeSrc(largeSrc);
      setPhotoState("ready");
    };
    image.onerror = () => {
      if (!active) {
        return;
      }
      setPhotoState("error");
    };
    image.src = largeSrc;

    return () => {
      active = false;
      image.onload = null;
      image.onerror = null;
      image.src = "";
    };
  }, [isVideo, largeSrc, photoRetryKey, resetTransform, smallSrc]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoom((current) => clampZoom(current * 1.2));
        return;
      }

      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setZoom((current) => clampZoom(current / 1.2));
        return;
      }

      if (event.key === "0") {
        event.preventDefault();
        resetTransform();
        return;
      }

      if (event.key.startsWith("Arrow")) {
        event.preventDefault();
        if (zoom > 1) {
          const pan = 48;
          setOffset((current) => ({
            x: current.x + (event.key === "ArrowLeft" ? pan : event.key === "ArrowRight" ? -pan : 0),
            y: current.y + (event.key === "ArrowUp" ? pan : event.key === "ArrowDown" ? -pan : 0),
          }));
        } else if (event.key === "ArrowUp") {
          setZoom((current) => clampZoom(current * 1.2));
        } else if (event.key === "ArrowDown") {
          setZoom((current) => clampZoom(current / 1.2));
        }
        return;
      }

      if (event.key === "Tab") {
        const focusable = Array.from(
          viewerRef.current?.querySelectorAll<HTMLElement>(
            "button, [href], [tabindex]:not([tabindex='-1'])",
          ) ?? [],
        ).filter((element) => !element.hasAttribute("disabled"));
        if (focusable.length === 0) {
          return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [clampZoom, onClose, resetTransform, zoom]);

  const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [first, second] = Array.from(pointers.current.values());
      pinchOrigin.current = { distance: distance(first, second), zoom };
      dragOrigin.current = null;
    } else if (zoom > 1) {
      dragOrigin.current = { x: event.clientX - offset.x, y: event.clientY - offset.y };
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) {
      return;
    }

    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2 && pinchOrigin.current) {
      const [first, second] = Array.from(pointers.current.values());
      const nextZoom = clampZoom(
        pinchOrigin.current.zoom * (distance(first, second) / pinchOrigin.current.distance),
      );
      setZoom(nextZoom);
      return;
    }

    if (pointers.current.size === 1 && dragOrigin.current) {
      setOffset({
        x: event.clientX - dragOrigin.current.x,
        y: event.clientY - dragOrigin.current.y,
      });
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) {
      pinchOrigin.current = null;
    }
    if (pointers.current.size === 0) {
      dragOrigin.current = null;
    }
  };

  const startPlayback = async (useServerFallback = false) => {
    const taskId = playbackTask.current + 1;
    playbackTask.current = taskId;
    setDirectLinkFailed(false);

    if (useServerFallback) {
      setPlaybackState("loading");
      setPlaybackSource({ kind: "server", src: resolveMediaUrl(memory.file_url) });
      setPlaybackRetryKey((current) => current + 1);
      return;
    }

    setPlaybackState("loading");
    try {
      const link = await getMediaDirectLink(memory.id, "play");
      if (taskId !== playbackTask.current) {
        return;
      }
      recoveredDirectLink.current = false;
      refreshedDirectUrl.current = null;
      setDirectExpiresAt(link.expires_at);
      setPlaybackSource({ kind: "direct", src: link.direct_url });
      setPlaybackRetryKey((current) => current + 1);
    } catch {
      if (taskId !== playbackTask.current) {
        return;
      }
      setPlaybackState("idle");
      setDirectLinkFailed(true);
    }
  };

  const recoverPlayback = async (brokenUrl: string) => {
    const taskId = playbackTask.current;
    setPlaybackSource(null);
    setPlaybackState("loading");
    try {
      const refreshedUrl = refreshedDirectUrl.current;
      const link = refreshedUrl && refreshedUrl !== brokenUrl
        ? { direct_url: refreshedUrl, expires_at: directExpiresAt }
        : await getMediaDirectLink(memory.id, "play");
      if (link.direct_url === brokenUrl || taskId !== playbackTask.current) {
        playbackTask.current += 1;
        setPlaybackState("loading");
        setPlaybackSource({ kind: "server", src: resolveMediaUrl(memory.file_url) });
        return;
      }

      recoveredDirectLink.current = true;
      setPlaybackState("loading");
      setPlaybackSource({ kind: "direct", src: link.direct_url });
      setPlaybackRetryKey((current) => current + 1);
    } catch {
      playbackTask.current += 1;
      setPlaybackState("loading");
      setPlaybackSource({ kind: "server", src: resolveMediaUrl(memory.file_url) });
      setPlaybackRetryKey((current) => current + 1);
    } finally {
      isRecoveringPlayback.current = false;
    }
  };

  useEffect(() => {
    if (!directExpiresAt || playbackSource?.kind !== "direct") {
      return;
    }

    const expiresAt = Date.parse(directExpiresAt);
    if (!Number.isFinite(expiresAt)) {
      return;
    }

    const delay = Math.max(1000, expiresAt - 30_000 - Date.now());
    const timer = window.setTimeout(() => {
      void getMediaDirectLink(memory.id, "play")
        .then((link) => {
          refreshedDirectUrl.current = link.direct_url;
          setDirectExpiresAt(link.expires_at);
        })
        .catch(() => {
          refreshedDirectUrl.current = null;
        });
    }, delay);

    return () => window.clearTimeout(timer);
  }, [directExpiresAt, memory.id, playbackSource?.kind]);

  const handleVideoSourceError = (source: PlaybackSource) => {
    if (source.kind === "direct" && !recoveredDirectLink.current) {
      if (isRecoveringPlayback.current) {
        return;
      }

      isRecoveringPlayback.current = true;
      recoveredDirectLink.current = true;
      void recoverPlayback(source.src);
      return;
    }

    setPlaybackState("error");
  };

  const startDownload = async () => {
    setDownloadState("loading");
    try {
      const link = await getMediaDirectLink(memory.id, "download");
      const anchor = document.createElement("a");
      anchor.href = link.direct_url;
      anchor.rel = "noopener noreferrer";
      anchor.target = "_blank";
      anchor.download = memory.primary_file?.filename || `limedia-${memory.id}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      downloadRetried.current = false;
      setDownloadState("idle");
    } catch {
      if (downloadRetried.current) {
        setDownloadState("error");
        return;
      }

      downloadRetried.current = true;
      setDownloadState("idle");
      try {
        const link = await getMediaDirectLink(memory.id, "download");
      const anchor = document.createElement("a");
      anchor.href = link.direct_url;
      anchor.rel = "noopener noreferrer";
      anchor.target = "_blank";
        anchor.download = memory.primary_file?.filename || `limedia-${memory.id}`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        downloadRetried.current = false;
        setDownloadState("idle");
      } catch {
        setDownloadState("error");
      }
    }
  };

  useEffect(() => () => {
    playbackTask.current += 1;
  }, [memory.id]);

  return (
    <div
      aria-label={memory.title || brand.copy.detailPreviewAlt}
      aria-modal="true"
      className="photo-viewer"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      ref={viewerRef}
      role="dialog"
      tabIndex={0}
    >
      {isVideo ? (
        <div className="photo-viewer-stage">
          {playbackSource ? (
            <VideoPlayer
              key={`${playbackRetryKey}-${playbackSource.src}`}
              onReady={() => setPlaybackState("ready")}
              onSourceError={() => handleVideoSourceError(playbackSource)}
              poster={largeSrc ?? smallSrc ?? undefined}
              src={playbackSource.src}
            />
          ) : (
            <>
              {largeSrc || smallSrc ? (
                <img
                  alt={brand.copy.detailPreviewAlt}
                  className="photo-viewer-image is-loaded"
                  draggable={false}
                  src={largeSrc ?? smallSrc ?? undefined}
                />
              ) : (
                <div aria-hidden="true" className="media-frame" />
              )}
              <button
                aria-label={brand.copy.viewerPlay}
                className="video-viewer-play"
                disabled={playbackState === "loading"}
                onClick={() => void startPlayback()}
                type="button"
              >
                <Play aria-hidden="true" />
              </button>
            </>
          )}
          {playbackState === "loading" ? (
            <p aria-live="polite" className="photo-viewer-loading">
              <span className="spinner text-primary" />
              <span>{brand.copy.viewerPreparingPlayback}</span>
            </p>
          ) : null}
          {directLinkFailed ? (
            <div aria-live="assertive" className="viewer-fallback">
              <p>{brand.copy.viewerDirectLinkFailed}</p>
              <button
                aria-label={brand.copy.viewerUseServerFallback}
                onClick={() => void startPlayback(true)}
                type="button"
              >
                {brand.copy.viewerUseServerFallback}
              </button>
            </div>
          ) : null}
          {playbackState === "error" ? (
            <p aria-live="assertive" className="photo-viewer-error">
              {brand.copy.detailPlaybackFailed}
            </p>
          ) : null}
        </div>
      ) : (
        <div
          className="photo-viewer-stage"
          onDoubleClick={() => (zoom > 1 ? resetTransform() : setZoom(2.5))}
          onPointerCancel={handlePointerUp}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          {smallSrc && !smallImageFailed ? (
            <img
              alt=""
              aria-hidden="true"
              className={`photo-viewer-placeholder ${smallImageReady ? "is-loaded" : ""}`}
              decoding="async"
              onError={() => {
                setSmallImageFailed(true);
                setPhotoState("error");
              }}
              onLoad={() => setSmallImageReady(true)}
              src={smallSrc}
            />
          ) : null}
          {photoLargeSrc ? (
            <img
              alt={memory.title || brand.copy.detailPreviewAlt}
              className={`photo-viewer-image ${photoState === "ready" ? "is-loaded" : ""}`}
              draggable={false}
              key={photoRetryKey}
              onLoad={() => setPhotoState("ready")}
              src={photoLargeSrc}
              style={{
                transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})`,
              }}
            />
          ) : null}
          {photoState === "loading" ? (
            <p aria-live="polite" className="photo-viewer-loading">
              <span className="spinner text-primary" />
              <span className="sr-only">{brand.copy.detailMediaLoading}</span>
            </p>
          ) : null}
          {photoState === "error" ? (
            <p aria-live="assertive" className="photo-viewer-error">
              {brand.copy.detailImageLoadFailed}
            </p>
          ) : null}
        </div>
      )}

      <div aria-live="polite" className="viewer-status">
        <span className={`badge ${hasIndexFailure ? "badge-warning" : "badge-success"}`}>
          {statusText}
        </span>
      </div>

      <div className="photo-viewer-actions">
        <button
          aria-label={brand.copy.detailRetry}
          className="photo-viewer-button"
          onClick={() => {
            if (isVideo) {
              void startPlayback();
              return;
            }
            setPhotoState("loading");
            setPhotoRetryKey((current) => current + 1);
          }}
          type="button"
        >
          <RefreshCw aria-hidden="true" />
        </button>
        <button
          aria-label={downloadState === "error" ? brand.copy.viewerRetryDownload : brand.copy.viewerDownload}
          className="photo-viewer-button"
          disabled={downloadState === "loading"}
          onClick={() => void startDownload()}
          type="button"
        >
          {downloadState === "error" ? (
            <TriangleAlert aria-hidden="true" />
          ) : (
            <Download aria-hidden="true" />
          )}
        </button>
        <button
          aria-label={brand.copy.adminCancel}
          className="photo-viewer-button"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
