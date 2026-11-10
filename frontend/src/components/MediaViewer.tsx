import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
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
  resolveThumbnailUrl,
  resolveTrustedMediaUrl,
  type MemorySummary,
} from "@/lib/api";
import { imageLoadQueue, loadQueuedImage } from "@/lib/image-load-queue";
import { brand } from "@/lib/brand";
import {
  createMediaLifecycleMap,
  isFailureMediaState,
  reduceMediaLifecycle,
  selectActiveMediaState,
} from "@/lib/media-state";

type MediaViewerProps = {
  memory: MemorySummary;
  onClose: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  // 相邻回忆：空闲时预取其查看器尺寸图片，翻页即可显示。
  prefetchTargets?: MemorySummary[];
  /** 画布内位置（1 起）：直接打开（URL 直链）不在画布内时不传、不显示计数 */
  position?: { index: number; total: number };
  /** 画布正在追加下一页：位置计数旁提示「正在加载更多回忆」 */
  isLoadingMore?: boolean;
};

type PlaybackSource = {
  kind: "direct" | "server";
  src: string;
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

// 滑动翻页：zoom<=1 时横向为主（|dx|>60 且 |dx|>2|dy|）才翻页，
// 纵向滑动让位；拖拽期间内容按系数跟手，松手回弹或翻页。
const SWIPE_THRESHOLD_PX = 60;
const SWIPE_AXIS_RATIO = 2;
const SWIPE_FOLLOW_FACTOR = 0.35;

export default function MediaViewer({
  memory,
  onClose,
  onNext,
  onPrev,
  prefetchTargets,
  position,
  isLoadingMore = false,
}: MediaViewerProps) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const pinchOrigin = useRef<{ distance: number; zoom: number } | null>(null);
  // 滑动翻页：起点 + 是否处于跟手状态（渲染为位移，pointerup 结算）
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const [swipeDx, setSwipeDx] = useState(0);
  const [swipeFollowing, setSwipeFollowing] = useState(false);

  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [zoomPillVisible, setZoomPillVisible] = useState(false);
  const [photoLargeSrc, setPhotoLargeSrc] = useState<string | null>(null);
  const [queuedSmallSrc, setQueuedSmallSrc] = useState<string | null>(null);
  const [queuedPosterSrc, setQueuedPosterSrc] = useState<string | null>(null);
  const [smallImageReady, setSmallImageReady] = useState(false);
  const [smallImageFailed, setSmallImageFailed] = useState(false);
  const [photoRetryKey, setPhotoRetryKey] = useState(0);
  const [mediaState, dispatchMediaState] = useReducer(
    reduceMediaLifecycle,
    undefined,
    createMediaLifecycleMap,
  );
  const [playbackSource, setPlaybackSource] = useState<PlaybackSource | null>(null);
  const [posterSize, setPosterSize] = useState<"480" | "1280">(() => {
    return window.matchMedia("(max-width: 767px)").matches ? "480" : "1280";
  });

  // 小图先行与画布同源（240px 预热即所得，秒开不等待）；
  // 大图桌面 1280 / 移动 480，加载完成后替换小图。
  const smallSrc = resolveThumbnailUrl(memory.thumbnail_url, "240");
  const largeSrc = resolveThumbnailUrl(memory.thumbnail_url, posterSize);
  const isVideo = memory.kind === "video";
  const aspectRatio = memory.width && memory.height
    ? memory.width / memory.height
    : 16 / 9;
  const videoShellStyle = {
    "--aspect-ratio": String(aspectRatio),
  } as CSSProperties;
  const remoteState = memory.primary_file?.remote_state;
  const thumbnailState = memory.primary_file?.thumbnail_state;
  const streamState = memory.primary_file?.stream_state;
  // 流只属于视频：照片的 stream_state 恒为 unavailable（无流概念），
  // 计入失败会把所有健康照片误标为「失败」。
  const remoteBroken = remoteState === "failed" || remoteState === "missing";
  const thumbnailBroken = thumbnailState === "failed" || thumbnailState === "missing";
  const streamBroken = streamState === "failed" || streamState === "unavailable";
  const hasIndexFailure = remoteBroken || thumbnailBroken || (isVideo && streamBroken);
  const activeMediaState = selectActiveMediaState([
    { scope: "download", state: mediaState.download },
    { scope: "playback", state: mediaState.playback },
    { scope: "preview", state: mediaState.preview },
  ]);
  const statusText = hasIndexFailure
    ? brand.copy.viewerStatusFailed
    : activeMediaState.scope === "download"
      ? activeMediaState.state === "loading"
        ? brand.copy.viewerDownloading
        : isFailureMediaState(activeMediaState.state)
          ? brand.copy.viewerDownloadFailed
          : brand.copy.viewerStatusReady
      : activeMediaState.scope === "playback"
        ? activeMediaState.state === "unsupported"
          ? brand.copy.videoCodecUnsupported
          : activeMediaState.state === "loading"
            ? brand.copy.viewerPreparingPlayback
            : activeMediaState.state === "buffering"
              ? brand.copy.detailBuffering
              : isFailureMediaState(activeMediaState.state)
                ? brand.copy.detailPlaybackFailed
                : brand.copy.viewerStatusReady
        : activeMediaState.state === "loading" || activeMediaState.state === "queued"
          ? brand.copy.viewerStatusLoading
          : isFailureMediaState(activeMediaState.state)
            ? brand.copy.viewerStatusRetrying
            : brand.copy.viewerStatusReady;
  // 就绪且无索引失败时隐藏状态徽章，减少常驻视觉噪声。
  const statusSettled =
    !hasIndexFailure &&
    !isFailureMediaState(activeMediaState.state) &&
    activeMediaState.state !== "loading" &&
    activeMediaState.state !== "queued" &&
    activeMediaState.state !== "buffering";

  const resetTransform = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const clampZoom = useCallback((value: number) => {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  }, []);

  // 滚轮缩放：viewer 全屏且 body 滚动已锁定，普通滚轮不与页面滚动冲突；
  // Ctrl/Cmd+滚轮保留给浏览器页面缩放。
  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey) {
      return;
    }
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    setZoom((current) => clampZoom(current * factor));
  };

  // 缩放指示：放大时短暂显示当前倍率，回弹到 1x 即隐藏。
  useEffect(() => {
    if (zoom <= 1) {
      setZoomPillVisible(false);
      return;
    }

    setZoomPillVisible(true);
    const timer = window.setTimeout(() => setZoomPillVisible(false), 900);
    return () => window.clearTimeout(timer);
  }, [zoom]);

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
    // 关闭时把焦点归还给打开查看器的触发元素，键盘用户不掉回 body。
    const previousActive = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    document.body.style.overflow = "hidden";
    viewerRef.current?.focus();
    // Park canvas thumbnail loads so the viewer's high-priority images can
    // claim both queue slots immediately; parked tasks resume on close.
    imageLoadQueue.suspendAll();

    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
      imageLoadQueue.resume();
      previousActive?.focus();
    };
  }, []);

  useEffect(() => {
    if (isVideo) {
      return;
    }

    setPhotoLargeSrc(null);
    setSmallImageReady(false);
    setSmallImageFailed(false);
    dispatchMediaState({ scope: "preview", type: smallSrc ? "queued" : "fail" });
    dispatchMediaState({ scope: "preview", type: smallSrc ? "load" : "fail" });
    resetTransform();
    if (!largeSrc) {
      return;
    }

    const controller = new AbortController();
    loadQueuedImage(largeSrc, {
      priority: "high",
      retries: 4,
      signal: controller.signal,
    })
      .then(() => {
        if (controller.signal.aborted) {
          return;
        }
        setPhotoLargeSrc(largeSrc);
        dispatchMediaState({ scope: "preview", type: "ready" });
      })
      .catch((error) => {
        if (controller.signal.aborted || error.name === "AbortError") {
          return;
        }
        dispatchMediaState({ scope: "preview", type: "fail" });
      });

    return () => controller.abort();
  }, [isVideo, largeSrc, photoRetryKey, resetTransform, smallSrc]);

  useEffect(() => {
    if (isVideo || !smallSrc) {
      setQueuedSmallSrc(null);
      return;
    }

    const controller = new AbortController();
    loadQueuedImage(smallSrc, {
      // 查看器关键路径（小图先行）：高优先级，避免被普通任务占住槽位。
      priority: "high",
      retries: 4,
      signal: controller.signal,
    })
      .then(() => {
        if (!controller.signal.aborted) {
          setQueuedSmallSrc(smallSrc);
        }
      })
      .catch(() => {
        setQueuedSmallSrc(null);
      });

    return () => controller.abort();
  }, [isVideo, smallSrc]);

  useEffect(() => {
    if (!isVideo) {
      setQueuedPosterSrc(null);
      return;
    }

    const posterSource = largeSrc ?? smallSrc;
    if (!posterSource) {
      setQueuedPosterSrc(null);
      return;
    }

    const controller = new AbortController();
    dispatchMediaState({ scope: "preview", type: "queued" });
    dispatchMediaState({ scope: "preview", type: "load" });
    loadQueuedImage(posterSource, {
      priority: "high",
      retries: 4,
      signal: controller.signal,
    })
      .then(() => {
        if (!controller.signal.aborted) {
          setQueuedPosterSrc(posterSource);
          dispatchMediaState({ scope: "preview", type: "ready" });
        }
      })
      .catch(() => {
        setQueuedPosterSrc(null);
      });

    return () => controller.abort();
  }, [isVideo, largeSrc, smallSrc]);

  useEffect(() => {
    if (!prefetchTargets || prefetchTargets.length === 0) {
      return;
    }

    const controllers: AbortController[] = [];
    const startPrefetch = () => {
      prefetchTargets.forEach((neighbor) => {
        // 只预取图片（含视频海报），不触碰按需直链契约。
        const src = resolveThumbnailUrl(neighbor.thumbnail_url, posterSize);
        if (!src) {
          return;
        }
        const controller = new AbortController();
        controllers.push(controller);
        loadQueuedImage(src, {
          priority: "high",
          retries: 2,
          signal: controller.signal,
        }).catch(() => {
          // 预取失败静默降级；真正导航时按正常链路加载。
        });
      });
    };

    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(startPrefetch);
      return () => {
        window.cancelIdleCallback(idleId);
        controllers.forEach((controller) => controller.abort());
      };
    }

    const timer = window.setTimeout(startPrefetch, 1);
    return () => {
      window.clearTimeout(timer);
      controllers.forEach((controller) => controller.abort());
    };
  }, [prefetchTargets, posterSize]);

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
      swipeStart.current = null;
      setSwipeFollowing(false);
      setSwipeDx(0);
    } else if (zoom > 1) {
      dragOrigin.current = { x: event.clientX - offset.x, y: event.clientY - offset.y };
    } else {
      // zoom<=1 单指针：记录滑动起点；鼠标需要显式捕获才能在移出舞台后
      // 继续收到 move（触摸指针浏览器会隐式捕获）。
      swipeStart.current = { x: event.clientX, y: event.clientY };
      setSwipeFollowing(false);
      setSwipeDx(0);
      if (event.pointerType === "mouse") {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
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
      return;
    }

    // 滑动跟手：横向为主时按系数平移内容；纵向为主的滑动不跟手。
    // 减动效偏好下不做跟手位移，只在 pointerup 按阈值直接翻页。
    if (
      pointers.current.size === 1 &&
      swipeStart.current &&
      !pinchOrigin.current &&
      !swipeFollowing
    ) {
      const dx = event.clientX - swipeStart.current.x;
      const dy = event.clientY - swipeStart.current.y;
      if (
        Math.abs(dx) > Math.abs(dy) &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        setSwipeFollowing(true);
        setSwipeDx(dx * SWIPE_FOLLOW_FACTOR);
      }
      return;
    }

    if (pointers.current.size === 1 && swipeFollowing && swipeStart.current) {
      const dx = event.clientX - swipeStart.current.x;
      if (Math.abs(dx) > Math.abs(event.clientY - swipeStart.current.y)) {
        setSwipeDx(dx * SWIPE_FOLLOW_FACTOR);
      }
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

    // 滑动结算：横向位移过阈值且纵向占比小才翻页，否则回弹。
    const start = swipeStart.current;
    swipeStart.current = null;
    setSwipeFollowing(false);
    setSwipeDx(0);
    if (!start) {
      return;
    }
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (
      Math.abs(dx) > SWIPE_THRESHOLD_PX &&
      Math.abs(dx) > SWIPE_AXIS_RATIO * Math.abs(dy)
    ) {
      if (dx < 0) {
        onNext?.();
      } else {
        onPrev?.();
      }
    }
  };

  const startPlayback = () => {
    dispatchMediaState({ scope: "playback", type: "load" });
    const src = resolveTrustedMediaUrl(memory.file_url);
    if (!src) {
      dispatchMediaState({ scope: "playback", type: "fail" });
      return;
    }
    setPlaybackSource({ kind: "server", src });
  };

  const handleVideoSourceError = (source: PlaybackSource, error?: MediaError) => {
    dispatchMediaState({
      scope: "playback",
      type: error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        ? "unsupported"
        : "fail",
    });
  };

  const startDownload = () => {
    dispatchMediaState({ scope: "download", type: "load" });
    const href = resolveTrustedMediaUrl(memory.file_url);
    if (!href) {
      dispatchMediaState({ scope: "download", type: "fail" });
      return;
    }
    try {
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.rel = "noopener noreferrer";
      anchor.download = memory.primary_file?.filename || `limedia-${memory.id}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      dispatchMediaState({ scope: "download", type: "ready" });
    } catch {
      dispatchMediaState({ scope: "download", type: "fail" });
    }
  };

  // 暗区点击关闭：记录指针起点，click 命中 stage 本体且位移 < 8px 才触发
  //（拖拽平移与双击缩放位移大或 target 在图片上，不会误关）
  const backdropPointer = useRef<{ x: number; y: number } | null>(null);
  const handleStagePointerDown = (event: React.PointerEvent) => {
    backdropPointer.current = { x: event.clientX, y: event.clientY };
  };
  const handleStageBackdropClick = (event: React.MouseEvent) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    const start = backdropPointer.current;
    backdropPointer.current = null;
    if (!start) {
      return;
    }
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 8) {
      return;
    }
    onClose();
  };

  useEffect(() => {
    setPlaybackSource(null);
    dispatchMediaState({ type: "reset" });
  }, [memory.id]);

  return createPortal(
    <div
      aria-label={memory.title || brand.copy.detailPreviewAlt}
      aria-modal="true"
      className="photo-viewer"
      ref={viewerRef}
      role="dialog"
      tabIndex={0}
    >
      {isVideo ? (
        // 视频舞台不加滑动翻页：与点按播放/进度手势冲突，翻页走两侧按钮与键盘。
        <div
          className="photo-viewer-stage is-video"
          onClick={handleStageBackdropClick}
          onPointerDown={handleStagePointerDown}
        >
          <div
            className="video-viewer-shell"
            onClick={() => {
              // 点海报即播放（中央按钮仍保留）；已起播时忽略
              if (!playbackSource) {
                void startPlayback();
              }
            }}
            style={videoShellStyle}
          >
            {playbackSource ? (
              <VideoPlayer
                key={memory.id}
                onBufferingChange={(isBuffering) => dispatchMediaState({
                  scope: "playback",
                  type: isBuffering ? "buffer" : "ready",
                })}
                onReady={() => dispatchMediaState({ scope: "playback", type: "ready" })}
                onSourceError={(error) => handleVideoSourceError(playbackSource, error)}
                poster={queuedPosterSrc ?? queuedSmallSrc ?? undefined}
                src={playbackSource.src}
              />
            ) : (
              <>
                {queuedPosterSrc || queuedSmallSrc ? (
                  <img
                    alt={brand.copy.detailPreviewAlt}
                    className="photo-viewer-image is-loaded"
                    draggable={false}
                    src={queuedPosterSrc ?? queuedSmallSrc ?? undefined}
                  />
                ) : (
                  <div aria-hidden="true" className="media-frame" />
                )}
                <button
                  aria-label={brand.copy.viewerPlay}
                  className="video-viewer-play"
                  disabled={mediaState.playback === "loading"}
                  onClick={(event) => {
                    event.stopPropagation();
                    void startPlayback();
                  }}
                  type="button"
                >
                  <Play aria-hidden="true" />
                </button>
              </>
            )}
          </div>
          {mediaState.playback === "loading" || isFailureMediaState(mediaState.playback) ? (
            <div aria-live="assertive" className="video-playback-overlay">
              {mediaState.playback === "loading" ? (
                <p className="video-playback-message">
                  <span className="spinner text-primary" />
                  <span>{brand.copy.viewerPreparingPlayback}</span>
                </p>
              ) : (
                <>
                  <p>
                    {mediaState.playback === "unsupported"
                      ? brand.copy.videoCodecUnsupported
                      : brand.copy.detailPlaybackFailed}
                  </p>
                  <button
                    onClick={() => void startPlayback()}
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
          onClick={handleStageBackdropClick}
          onDoubleClick={() => (zoom > 1 ? resetTransform() : setZoom(2.5))}
          onPointerCancel={handlePointerUp}
          onPointerDown={(event) => {
            handleStagePointerDown(event);
            handlePointerDown(event);
          }}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
        >
          {/* 滑动跟手层：仅包裹图片内容，状态浮层不随滑动位移 */}
          <div
            className={`viewer-swipe-track ${swipeFollowing ? "is-following" : ""}`}
            style={{ transform: `translateX(${swipeDx}px)` }}
          >
            {smallSrc && !smallImageFailed ? (
              <img
                alt=""
                aria-hidden="true"
                className={`photo-viewer-placeholder ${smallImageReady ? "is-loaded" : ""}`}
                decoding="async"
                onError={() => {
                  setSmallImageFailed(true);
                  dispatchMediaState({ scope: "preview", type: "fail" });
                }}
                onLoad={() => setSmallImageReady(true)}
                src={queuedSmallSrc ?? undefined}
              />
            ) : null}
            {photoLargeSrc ? (
              <img
                alt={memory.title || brand.copy.detailPreviewAlt}
                className={`photo-viewer-image ${mediaState.preview === "ready" ? "is-loaded" : ""}`}
                draggable={false}
                key={photoRetryKey}
                onLoad={() => dispatchMediaState({ scope: "preview", type: "ready" })}
                src={photoLargeSrc}
                style={{
                  transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})`,
                }}
              />
            ) : null}
          </div>
          {mediaState.preview === "loading" || mediaState.preview === "queued" ? (
            <p aria-live="polite" className="photo-viewer-loading">
              <span className="spinner text-primary" />
              <span className="sr-only">{brand.copy.detailMediaLoading}</span>
            </p>
          ) : null}
          {mediaState.preview === "failed" ? (
            <div aria-live="assertive" className="video-playback-overlay">
              <p>{brand.copy.detailImageLoadFailed}</p>
              <button
                onClick={() => {
                  dispatchMediaState({ scope: "preview", type: "retry" });
                  setPhotoRetryKey((current) => current + 1);
                }}
                type="button"
              >
                {brand.copy.detailRetry}
              </button>
            </div>
          ) : null}
          <div
            aria-hidden="true"
            className={`viewer-zoom-pill ${zoomPillVisible ? "is-visible" : ""}`}
          >
            {Math.round(zoom * 100)}%
          </div>
        </div>
      )}

      {/* 状态元素常驻作为状态载体（测试与调试可读 data-state），
          全部就绪且无索引失败时整体隐藏，不再常驻“可用”徽章。 */}
      <div
        aria-live={isFailureMediaState(activeMediaState.state) ? "assertive" : "polite"}
        className="viewer-status"
        data-scope={activeMediaState.scope}
        data-state={activeMediaState.state}
        hidden={statusSettled || undefined}
        role="status"
      >
        <span
          className={`badge ${
            hasIndexFailure || isFailureMediaState(activeMediaState.state)
              ? "badge-warning"
              : "badge-success"
          }`}
        >
          {statusText}
        </span>
      </div>

      {/* 画布位置计数：视觉导航辅助（可读名已含标题），不进朗读树 */}
      {position && position.total > 1 ? (
        <div aria-hidden="true" className="viewer-counter tnum">
          {brand.copy.viewerPosition
            .replace("{index}", String(position.index))
            .replace("{total}", String(position.total))}
        </div>
      ) : null}
      {/* 末尾自动续载提示：位置计数上方浮层，画布追加期间可被读屏感知 */}
      {isLoadingMore && position ? (
        <div className="viewer-load-pill" role="status" aria-live="polite">
          {brand.copy.loadingMoreLibrary}
        </div>
      ) : null}

      {onPrev ? (
        <button
          aria-label={brand.copy.viewerPrevious}
          className="photo-viewer-button photo-viewer-nav photo-viewer-nav-prev"
          title={brand.copy.viewerPrevious}
          onClick={onPrev}
          type="button"
        >
          <ChevronLeft aria-hidden="true" />
        </button>
      ) : null}
      {onNext ? (
        <button
          aria-label={brand.copy.viewerNext}
          title={brand.copy.viewerNext}
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
          disabled={!isVideo && !hasIndexFailure && mediaState.preview === "ready"}
          title={brand.copy.detailRetry}
          onClick={() => {
            if (isVideo) {
              void startPlayback();
              return;
            }
            dispatchMediaState({ scope: "preview", type: "retry" });
            setPhotoRetryKey((current) => current + 1);
          }}
          type="button"
        >
          <RefreshCw aria-hidden="true" />
        </button>
        <button
          aria-label={mediaState.download === "failed"
            ? brand.copy.viewerRetryDownload
            : brand.copy.viewerDownload}
          className="photo-viewer-button"
          disabled={mediaState.download === "loading"}
          title={mediaState.download === "failed"
            ? brand.copy.viewerRetryDownload
            : brand.copy.viewerDownload}
          onClick={() => void startDownload()}
          type="button"
        >
          {mediaState.download === "failed" ? (
            <TriangleAlert aria-hidden="true" />
          ) : (
            <Download aria-hidden="true" />
          )}
        </button>
        <button
          aria-label={brand.copy.close}
          className="photo-viewer-button"
          onClick={onClose}
          title={brand.copy.close}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
