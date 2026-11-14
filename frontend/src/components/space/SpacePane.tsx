import { Image as ImageIcon, Play } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import { brand } from "@/lib/brand";
import { formatDate, formatDuration } from "@/lib/format";
import { resolveThumbnailUrl, type MemorySummary } from "@/lib/api";
import { loadQueuedImage } from "@/lib/image-load-queue";

// 回廊窗口模式：远端固定 240px 档（与画布同口径，预热即所得），
// 落定档位 ±2 档内升 480px 近景档，交叉淡入换源；查看器内再取高清。
const NEAR_TIER = "480" as const;
const FAR_TIER = "240" as const;

type SpacePaneProps = {
  memory: MemorySummary;
  index: number;
  /** 世界坐标 Z（px，负值）：几何唯一事实，同时用于雾化注册 */
  worldZ: number;
  /** 所在墙面：决定 x 偏移与朝向角的符号（几何量本体在 CSS 令牌） */
  side: "left" | "right";
  /** 近景升档：落定档位 ±2 档内取 480px */
  enhanced: boolean;
  /** true = 3D 窗口模式（走共享队列）；false = flat 时间线（原生 lazy） */
  windowed: boolean;
  /** 几何拾取的悬停态（3D 下 pane 不参与 DOM 命中，由舞台代理写入） */
  dataHovered?: "true";
  fogTargetsRef: RefObject<Map<HTMLElement, number>>;
};

function SpacePane({
  memory,
  index,
  worldZ,
  side,
  enhanced,
  windowed,
  dataHovered,
  fogTargetsRef,
}: SpacePaneProps) {
  const [loaded240, setLoaded240] = useState<string | null>(null);
  const [loaded480, setLoaded480] = useState<string | null>(null);
  const [flatReady, setFlatReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const url240 = resolveThumbnailUrl(memory.thumbnail_url, FAR_TIER);
  const url480 = resolveThumbnailUrl(memory.thumbnail_url, NEAR_TIER);

  useEffect(() => {
    if (!windowed || !url240) {
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setFailed(false);
    loadQueuedImage(url240, {
      priority: "normal",
      retries: 4,
      signal: controller.signal,
    })
      .then(() => {
        if (!cancelled) {
          setLoaded240(url240);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled && (error as { name?: string })?.name !== "AbortError") {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [windowed, url240]);

  useEffect(() => {
    if (!windowed || !enhanced || !url480) {
      return;
    }
    if (loaded480 === url480) {
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    loadQueuedImage(url480, {
      priority: "high",
      retries: 2,
      signal: controller.signal,
    })
      .then(() => {
        if (!cancelled) {
          setLoaded480(url480);
        }
      })
      .catch(() => {
        // 近景升档失败保持 240px 档，不打扰浏览
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [windowed, enhanced, url480, loaded480]);

  // 雾化注册：React 19 ref cleanup —— 卸载/回调换绑时自动从 Map 注销
  const registerElement = useCallback(
    (element: HTMLButtonElement | null) => {
      const map = fogTargetsRef.current;
      if (!element || !map) {
        return;
      }
      map.set(element, worldZ);
      return () => {
        map.delete(element);
      };
    },
    [fogTargetsRef, worldZ],
  );

  const shownSrc = windowed ? loaded240 : url240;
  const ready = windowed
    ? loaded240 !== null
    : flatReady || url240 === null;
  const accessibleName = [
    memory.title || brand.copy.detailPreviewAlt,
    memory.location,
    formatDate(memory.captured_at),
  ]
    .filter(Boolean)
    .join(" · ");
  const captionMeta = [memory.location, formatDate(memory.captured_at)]
    .filter(Boolean)
    .join(" · ");
  const videoDuration = formatDuration(memory.duration_seconds);
  const videoBadgeLabel = videoDuration
    ? `${brand.copy.videoKind} ${videoDuration}`
    : brand.copy.videoKind;
  const placeholderIcon = memory.kind === "video" ? (
    <Play className="size-8 opacity-40" />
  ) : (
    <ImageIcon className="size-8 opacity-40" />
  );

  return (
    <button
      aria-label={accessibleName}
      className="space-pane"
      data-hovered={dataHovered}
      data-space-index={index}
      ref={registerElement}
      style={
        {
          // 几何量（偏移/朝向角）在 CSS 由令牌推导，这里只给符号与深度
          "--space-side": side === "left" ? -1 : 1,
          "--space-y": "0px",
          "--space-z": `${worldZ}px`,
          // flat 时间线的自适应宽高比；3D 固定框 contain 不使用
          "--pane-aspect":
            memory.width && memory.height
              ? `${memory.width} / ${memory.height}`
              : undefined,
        } as CSSProperties
      }
      type="button"
    >
      {shownSrc ? (
        <img
          alt=""
          aria-hidden="true"
          className={`space-pane-img media-reveal media-crossfade ${
            ready ? "is-visible" : "is-hidden"
          }`}
          decoding="async"
          loading={windowed ? undefined : "lazy"}
          onLoad={() => setFlatReady(true)}
          src={shownSrc}
        />
      ) : null}
      {loaded480 ? (
        <img
          alt=""
          aria-hidden="true"
          className="space-pane-img media-crossfade is-visible"
          decoding="async"
          src={loaded480}
        />
      ) : null}
      {!ready || failed || !shownSrc ? (
        <span
          aria-hidden="true"
          className={`media-placeholder media-crossfade ${
            ready && !failed && shownSrc ? "is-hidden" : "is-visible"
          }`}
        >
          {placeholderIcon}
        </span>
      ) : null}
      {memory.kind === "video" ? (
        <span aria-hidden="true" className="waterfall-badge">
          <Play className="size-3.5" />
          {videoBadgeLabel}
        </span>
      ) : null}
      {memory.title || captionMeta ? (
        <span aria-hidden="true" className="space-caption">
          <span className="space-caption-title">{memory.title}</span>
          <span className="space-caption-meta">{captionMeta}</span>
        </span>
      ) : null}
    </button>
  );
}

// 相机行进中焦点档位频繁切换，memo 让窗口滑动时未变化的 pane 跳过重渲染
export default memo(SpacePane);
