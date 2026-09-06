import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Play,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { createPortal } from "react-dom";

import VideoPlayer from "@/components/VideoPlayer";
import {
  getMediaDirectLink,
  resolveMediaUrl,
  resolveThumbnailUrl,
  type MemorySummary,
} from "@/lib/api";
import { brand } from "@/lib/brand";

type MediaViewerProps = {
  memory: MemorySummary;
  onClose: () => void;
  onNext?: () => void;
  onPrev?: () => void;
};

type PlaybackSource = {
  kind: "direct" | "server";
  src: string;
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

type CachedPlaybackLink = {
  directUrl: string;
  expiresAt: string | null;
};

const playbackLinkCache = new Map<string, CachedPlaybackLink>();
const playbackLinkRequests = new Map<string, Promise<CachedPlaybackLink>>();

function isPlaybackLinkFresh(link: CachedPlaybackLink): boolean {
  if (!link.expiresAt) {
    return false;
  }

  const expiresAt = Date.parse(link.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt - Date.now() > 30_000;
}

async function getPlaybackLink(
  memoryId: string,
  forceRefresh = false,
): Promise<CachedPlaybackLink> {
  const cached = playbackLinkCache.get(memoryId);
  if (!forceRefresh && cached && isPlaybackLinkFresh(cached)) {
    return cached;
  }

  const pending = playbackLinkRequests.get(memoryId);
  if (pending) {
    return pending;
  }

  const request = getMediaDirectLink(memoryId, "play")
    .then((link) => {
      const cachedLink: CachedPlaybackLink = {
        directUrl: link.direct_url,
        expiresAt: link.expires_at,
      };
      playbackLinkCache.set(memoryId, cachedLink);
      return cachedLink;
    })
    .finally(() => {
      playbackLinkRequests.delete(memoryId);
    });

  playbackLinkRequests.set(memoryId, request);
  return request;
}

export default function MediaViewer({ memory, onClose, onNext, onPrev }: MediaViewerProps) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const pinchOrigin = useRef<{ distance: number; zoom: number } | null>(null);
  const playbackTask = useRef(0);
  const isStartingPlayback = useRef(false);
  const recoveredDirectLink = useRef(false);
  const isRecoveringPlayback = useRef(false);
  const downloadRetried = useRef(false);
  const isRefreshingDownload = useRef(false);

  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [photoLargeSrc, setPhotoLargeSrc] = useState<string | null>(null);
  const [smallImageReady, setSmallImageReady] = useState(false);
  const [smallImageFailed, setSmallImageFailed] = useState(false);
  const [photoState, setPhotoState] = useState<"loading" | "ready" | "error">("loading");
  const [photoRetryKey, setPhotoRetryKey] = useState(0);

  const [playbackSource, setPlaybackSource] = useState<PlaybackSource | null>(null);
  const [playbackState, setPlaybackState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [directLinkFailed, setDirectLinkFailed] = useState(false);

  const [downloadState, setDownloadState] = useState<"idle" | "loading" | "error">("idle");
  const [posterSize, setPosterSize] = useState<"480" | "1280">(() => {
    return window.matchMedia("(max-width: 767px)").matches ? "480" : "1280";
  });

  const smallSrc = resolveThumbnailUrl(memory.thumbnail_url, "480");
  const largeSrc = resolveThumbnailUrl(memory.thumbnail_url, posterSize);
  const isVideo = memory.kind === "video";
  const aspectRatio = memory.width && memory.height
    ? memory.width / memory.height
    : 16 / 9;
  const videoShellStyle = {
    "--aspect-ratio": String(aspectRatio),
  } as CSSProperties;
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
      : photoState === "loading"
        ? brand.copy.viewerStatusLoading
        : brand.copy.viewerStatusReady;
  const shouldShowStatus = !isVideo || playbackState === "ready" || playbackState === "error";

  const resetTransform = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const clampZoom = useCallback((value: number) => {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  }, []);

  useEffect(() => {
    const posterQuery = window.matchMedia("(max-width: 767px)");
    const updatePosterSize = () => {
      setPosterSize(posterQuery.matches ? "480" : "1280");
    };

    updatePosterSize();
    posterQuery.addEventListener("change", updatePosterSize);
    return () => posterQuery.removeEventListener("change", updatePosterSize);
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

      if (event.key === "ArrowLeft" && onPrev && (isVideo || zoom <= 1)) {
        event.preventDefault();
        onPrev();
        return;
      }

      if (event.key === "ArrowRight" && onNext && (isVideo || zoom <= 1)) {
        event.preventDefault();
        onNext();
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
  }, [clampZoom, isVideo, onClose, onNext, onPrev, resetTransform, zoom]);

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

  const startPlayback = async (
    useServerFallback = false,
    forceRefresh = false,
  ) => {
    if (isStartingPlayback.current || isRecoveringPlayback.current) {
      return;
    }

    const taskId = playbackTask.current + 1;
    playbackTask.current = taskId;
    isStartingPlayback.current = true;
    setDirectLinkFailed(false);

    if (useServerFallback) {
      setPlaybackState("loading");
      setPlaybackSource({ kind: "server", src: resolveMediaUrl(memory.file_url) });
      isStartingPlayback.current = false;
      return;
    }

    setPlaybackState("loading");
    try {
      const link = await getPlaybackLink(memory.id, forceRefresh);
      if (taskId !== playbackTask.current) {
        return;
      }
      recoveredDirectLink.current = false;
      if (playbackSource?.src !== link.directUrl) {
        setPlaybackSource({ kind: "direct", src: link.directUrl });
      }
    } catch {
      if (taskId !== playbackTask.current) {
        return;
      }
      setPlaybackState("idle");
      setDirectLinkFailed(true);
    } finally {
      isStartingPlayback.current = false;
    }
  };

  const recoverPlayback = async (brokenUrl: string) => {
    const taskId = playbackTask.current;
    setPlaybackSource(null);
    setPlaybackState("loading");
    try {
      const link = await getPlaybackLink(memory.id, true);
      if (link.directUrl === brokenUrl || taskId !== playbackTask.current) {
        playbackTask.current += 1;
        setPlaybackState("loading");
        setPlaybackSource({ kind: "server", src: resolveMediaUrl(memory.file_url) });
        return;
      }

      recoveredDirectLink.current = true;
      setPlaybackState("loading");
      setPlaybackSource({ kind: "direct", src: link.directUrl });
    } catch {
      playbackTask.current += 1;
      setPlaybackState("loading");
      setPlaybackSource({ kind: "server", src: resolveMediaUrl(memory.file_url) });
    } finally {
      isRecoveringPlayback.current = false;
    }
  };

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
    if (isRefreshingDownload.current) {
      return;
    }

    isRefreshingDownload.current = true;
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
    } finally {
      isRefreshingDownload.current = false;
    }
  };

  useEffect(() => {
    playbackTask.current += 1;
    isStartingPlayback.current = false;
    recoveredDirectLink.current = false;
    isRecoveringPlayback.current = false;
    isRefreshingDownload.current = false;
    downloadRetried.current = false;
    setPlaybackSource(null);
    setPlaybackState("idle");
    setDirectLinkFailed(false);
    setDownloadState("idle");

    return () => {
      playbackTask.current += 1;
    };
  }, [memory.id]);

  return createPortal(
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
        <div className="photo-viewer-stage is-video">
          <div className="video-viewer-shell" style={videoShellStyle}>
            {playbackSource ? (
              <VideoPlayer
                key={memory.id}
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
          </div>
          {playbackState === "loading" || directLinkFailed || playbackState === "error" ? (
            <div aria-live="assertive" className="video-playback-overlay">
              {playbackState === "loading" ? (
                <p className="video-playback-message">
                  <span className="spinner text-primary" />
                  <span>{brand.copy.viewerPreparingPlayback}</span>
                </p>
              ) : directLinkFailed ? (
                <>
                  <p>{brand.copy.viewerDirectLinkFailed}</p>
                  <button
                    aria-label={brand.copy.viewerUseServerFallback}
                    onClick={() => void startPlayback(true)}
                    type="button"
                  >
                    {brand.copy.viewerUseServerFallback}
                  </button>
                </>
              ) : (
                <>
                  <p>{brand.copy.detailPlaybackFailed}</p>
                  <button
                    onClick={() => void startPlayback(false, playbackSource?.kind === "direct")}
                    type="button"
                  >
                    {brand.copy.detailRetry}
                  </button>
                </>
              )}
            </div>
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

      {shouldShowStatus ? (
        <div aria-live="polite" className="viewer-status">
          <span className={`badge ${hasIndexFailure ? "badge-warning" : "badge-success"}`}>
            {statusText}
          </span>
        </div>
      ) : null}

      {onPrev ? (
        <button
          aria-label={brand.copy.viewerPrevious}
          className="photo-viewer-button photo-viewer-nav photo-viewer-nav-prev"
          onClick={onPrev}
          type="button"
        >
          <ChevronLeft aria-hidden="true" />
        </button>
      ) : null}
      {onNext ? (
        <button
          aria-label={brand.copy.viewerNext}
          className="photo-viewer-button photo-viewer-nav photo-viewer-nav-next"
          onClick={onNext}
          type="button"
        >
          <ChevronRight aria-hidden="true" />
        </button>
      ) : null}

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
    </div>,
    document.body,
  );
}
