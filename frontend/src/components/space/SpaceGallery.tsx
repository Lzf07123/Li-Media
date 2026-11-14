import { ChevronDown, ChevronUp, Images, LayoutGrid } from "lucide-react";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type SyntheticEvent,
} from "react";

import { brand } from "@/lib/brand";
import {
  getMemories,
  type MemorySummary,
} from "@/lib/api";
import {
  pickPaneAt,
  useSpaceCamera,
  type SpaceCameraGeometry,
} from "./use-space-camera";
import SpacePane from "./SpacePane";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import IconButton from "@/components/ui/IconButton";
import Notice from "@/components/ui/Notice";

const SPACE_PAGE_SIZE = 18;
/** 挂载缓冲：焦点 ±5 档（呈现窗口 ±3 档，缓冲防快速推进时反复装卸） */
const MOUNT_BUFFER = 5;
/** 近景升档半径：落定档位 ±2 档取 480px */
const NEAR_RANGE = 2;
/** 相机落定档位距已载末尾 ≤4 档时续载下一页 */
const LOAD_MORE_AHEAD = 4;

const NAVIGATION_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "PageDown",
  "PageUp",
  "Home",
  "End",
]);

type SpaceGalleryProps = {
  kind: "photo" | "video" | undefined;
  onOpenViewer: (memoryId: string) => void;
  onExitSpace: () => void;
  onKindChange: (kind: "photo" | "video" | undefined) => void;
  /** 已载条目上报：供首页查看器在回廊场景下解析相邻内容与位置 */
  onItemsChange: (items: MemorySummary[], total: number) => void;
  /** 3D 沉浸态上报：驱动页眉压图配色与页脚隐藏（flat 时间线不沉浸） */
  onImmersiveChange: (immersive: boolean) => void;
};

/** 几何量与 CSS 令牌单一事实：全部从令牌读出（@property 注册后 computed
 *  为解析后的像素值，含窄屏覆盖），吸附前导量按比例推导 */
function readSpaceGeometry(): SpaceCameraGeometry {
  // 令牌名字面量按门禁口径只能出现在 index.css；运行时只做读取，名称在此拼装
  const tokenFamily = "limedia";
  const token = (suffix: string, fallback: number): number => {
    const parsed = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        `--${tokenFamily}-space-${suffix}`,
      ),
    );
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const gap = token("pane-gap", 460);
  return {
    gap,
    snapLead: Math.round(gap * 0.42),
    perspective: token("perspective", 1100),
    wallOffset: token("wall-offset", 420),
    wallAngleDeg: token("wall-angle", 18),
    paneWidth: token("pane-w", 500),
    paneHeight: token("pane-h", 680),
  };
}

function parseYear(capturedAt: string | null | undefined): number | null {
  if (!capturedAt) {
    return null;
  }
  const year = new Date(capturedAt).getFullYear();
  return Number.isFinite(year) ? year : null;
}

/** flat 降级：reduced-motion 或环境不支持 CSS 3D 时展开为纵向时间线 */
function computeFlat(): boolean {
  return (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    !CSS.supports("transform-style", "preserve-3d") ||
    !CSS.supports("perspective", "1px")
  );
}

function SpaceGallery({
  kind,
  onOpenViewer,
  onExitSpace,
  onKindChange,
  onItemsChange,
  onImmersiveChange,
}: SpaceGalleryProps) {
  const [items, setItems] = useState<MemorySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [settledIndex, setSettledIndex] = useState<number | null>(null);
  const [flat, setFlat] = useState(computeFlat);
  const [hintHidden, setHintHidden] = useState(false);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const corridorRef = useRef<HTMLDivElement | null>(null);
  const fogTargetsRef = useRef<Map<HTMLElement, number>>(new Map());
  const countRef = useRef(0);
  const pageRef = useRef(1);
  const requestTokenRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const focusedIndexRef = useRef(-1);
  const tailSentinelRef = useRef<HTMLDivElement | null>(null);
  const liveRegionRef = useRef<HTMLParagraphElement | null>(null);
  const [geometry] = useState(readSpaceGeometry);
  const geometryRef = useRef(geometry);
  // 窄屏覆盖/窗口尺寸变化时刷新几何（vw/svh 依赖窗口实测）
  useEffect(() => {
    const refresh = () => {
      geometryRef.current = readSpaceGeometry();
    };
    window.addEventListener("resize", refresh);
    return () => window.removeEventListener("resize", refresh);
  }, []);

  // —— flat 降级跟随系统偏好 ——
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setFlat(computeFlat());
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // 沉浸态上报（flat 时间线不沉浸：页眉恢复常规配色、页脚保留）
  useEffect(() => {
    onImmersiveChange(!flat);
  }, [flat, onImmersiveChange]);

  // —— 数据：captured_desc 让首页一页即「今天」，推进方向 = 分页顺序 ——
  const loadPage = useCallback(
    async (page: number, mode: "replace" | "append") => {
      const requestToken = requestTokenRef.current + 1;
      requestTokenRef.current = requestToken;
      // append 防并发；replace（切类型/重试）必须随时可打断在途的 append
      if (mode === "append" && loadingMoreRef.current) {
        return;
      }

      if (mode === "replace") {
        setIsLoading(true);
        setItems([]);
        setTotal(0);
        setFocusIndex(0);
        setSettledIndex(null);
        focusedIndexRef.current = -1;
      } else {
        setIsLoadingMore(true);
        loadingMoreRef.current = true;
      }

      try {
        const data = await getMemories({
          kind,
          page,
          page_size: SPACE_PAGE_SIZE,
          sort: "captured_desc",
        });
        if (requestToken !== requestTokenRef.current) {
          return;
        }
        pageRef.current = page;
        setItems((current) => {
          if (mode === "replace") {
            return data.items;
          }
          const knownIds = new Set(current.map((memory) => memory.id));
          return [
            ...current,
            ...data.items.filter((memory) => !knownIds.has(memory.id)),
          ];
        });
        setTotal(data.total);
        setError(null);
        setMoreError(null);
      } catch {
        if (requestToken === requestTokenRef.current) {
          if (mode === "replace") {
            setError(brand.copy.loadFailed);
          } else {
            setMoreError(brand.copy.loadMoreFailed);
          }
        }
      } finally {
        if (requestToken === requestTokenRef.current) {
          setIsLoading(false);
          setIsLoadingMore(false);
          loadingMoreRef.current = false;
        }
      }
    },
    [kind],
  );

  useEffect(() => {
    void loadPage(1, "replace");
  }, [loadPage]);

  useEffect(() => {
    countRef.current = items.length;
  }, [items.length]);

  useEffect(() => {
    onItemsChange(items, total);
  }, [items, total, onItemsChange]);

  const hasMore = items.length > 0 && items.length < total;

  const loadNextPage = useCallback(() => {
    if (isLoading || isLoadingMore || moreError || !hasMore) {
      return;
    }
    void loadPage(pageRef.current + 1, "append");
  }, [hasMore, isLoading, isLoadingMore, loadPage, moreError]);

  // 3D 续载：相机落定档位接近已载末尾时拉下一页（行进 sentinel）
  useEffect(() => {
    if (flat || settledIndex === null) {
      return;
    }
    if (settledIndex >= items.length - LOAD_MORE_AHEAD) {
      loadNextPage();
    }
  }, [flat, items.length, loadNextPage, settledIndex]);

  // flat 续载：尾哨兵进入视口时拉下一页
  useEffect(() => {
    const node = tailSentinelRef.current;
    if (!flat || !node || isLoading || isLoadingMore || moreError || !hasMore) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadNextPage();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [flat, hasMore, isLoading, isLoadingMore, loadNextPage, moreError]);

  // —— 相机 ——
  const handleIndexChange = useCallback((index: number) => {
    focusIndexRef.current = index;
    setFocusIndex(index);
  }, []);
  const handleSettled = useCallback((index: number | null) => {
    setSettledIndex(index);
  }, []);
  // 480 升档错峰：落定后 120ms 再升档，避免解码挤占吸附末帧
  const [enhancedIndex, setEnhancedIndex] = useState<number | null>(null);
  useEffect(() => {
    if (settledIndex === null) {
      setEnhancedIndex(null);
      return;
    }
    const timer = window.setTimeout(() => setEnhancedIndex(settledIndex), 120);
    return () => window.clearTimeout(timer);
  }, [settledIndex]);
  const camera = useSpaceCamera({
    stageRef,
    corridorRef,
    fogTargetsRef,
    countRef,
    geometryRef,
    enabled: !flat,
    onIndexChange: handleIndexChange,
    onSettled: handleSettled,
  });

  // 进入回廊把焦点移入舞台（focus-on-route-change；preventScroll 防跳动）
  useEffect(() => {
    stageRef.current?.focus({ preventScroll: true });
  }, []);

  // 几何拾取的舞台基准矩形：舞台贴视口顶全出血，位置稳定，仅尺寸随窗口变
  const stageRectRef = useRef({ left: 0, top: 0, width: 0, height: 0 });
  useEffect(() => {
    const measure = () => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (rect) {
        stageRectRef.current = {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const pickFromPointer = useCallback(
    (clientX: number, clientY: number): number | null => {
      return pickPaneAt({
        clientX,
        clientY,
        stageRect: stageRectRef.current,
        cameraPosition: camera.stateRef.current.position,
        geometry: geometryRef.current,
        perspective: geometryRef.current.perspective,
        wallOffset: geometryRef.current.wallOffset,
        wallAngleDeg: geometryRef.current.wallAngleDeg,
        paneWidth: geometryRef.current.paneWidth,
        paneHeight: geometryRef.current.paneHeight,
        paneHeightMin: geometryRef.current.paneHeight * 0.55,
        aspects: items.map((memory) => ({
          width: memory.width,
          height: memory.height,
        })),
      });
    },
    [items, camera],
  );

  // 键盘行进把焦点 pane 飞出窗口时焦点不落到 body：窗口并入焦点锚点
  const handleFocusCapture = useCallback((event: FocusEvent) => {
    const pane = (event.target as HTMLElement).closest("[data-space-index]");
    if (pane) {
      focusedIndexRef.current = Number(pane.getAttribute("data-space-index"));
    }
  }, []);

  // 查看器打开走 pointerup 几何拾取而非 DOM click：滑动后相机仍在缓慢归位，
  // pointerdown 与 pointerup 的命中目标会漂移；且 preserve-3d 场景里
  // pointer-events/clip-path 的 hit-test 有浏览器怪癖。抬手指一刻按
  // 射线-平面求交拾取命中的 pane（pickPaneAt），拖拽场景由
  // suppressPointerUp 抑制。键盘 Enter/Space 走 click（detail === 0）兜底。
  // 交互语义（两段式）：点中非焦点 pane = 走到它面前（档案馆隐喻）；
  // 点中焦点 pane = 打开查看器。点击必有反馈，永不落空。
  const focusIndexRef = useRef(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const openPaneAt = useCallback(
    (index: number) => {
      const memory = items[index];
      if (!memory) {
        return;
      }
      if (index === focusIndexRef.current) {
        onOpenViewer(memory.id);
      } else {
        camera.goToIndex(index);
      }
    },
    [items, onOpenViewer, camera],
  );
  const openPaneFromEvent = useCallback(
    (event: SyntheticEvent) => {
      const pane = (event.target as HTMLElement).closest("[data-space-index]");
      if (pane) {
        openPaneAt(Number(pane.getAttribute("data-space-index")));
      }
    },
    [openPaneAt],
  );

  // —— 渲染清单：3D 挂载窗口 = 焦点 ± 缓冲 ∪ 焦点 pane（键盘保有）；
  // flat 时间线全量挂载，交给原生 lazy loading 与尾哨兵续载 ——
  const renderList = useMemo(() => {
    if (flat) {
      return items.map((memory, index) => ({
        memory,
        index,
        mounted: true,
      }));
    }
    const anchors = [focusIndex, focusedIndexRef.current].filter(
      (anchor) => anchor >= 0,
    );
    const mounted = new Set<number>();
    for (const anchor of anchors) {
      const from = Math.max(0, anchor - MOUNT_BUFFER);
      const to = Math.min(items.length - 1, anchor + MOUNT_BUFFER);
      for (let index = from; index <= to; index += 1) {
        mounted.add(index);
      }
    }
    return items.map((memory, index) => ({
      memory,
      index,
      mounted: mounted.has(index),
    }));
  }, [items, focusIndex, flat]);

  // 年份里程碑：每年首张相片上方挂同墙衬线年号；无拍摄时间的相片不挂
  const milestoneFlags = useMemo(() => {
    const flags = new Array<boolean>(items.length).fill(false);
    let lastYear: number | null = null;
    let seenYear = false;
    items.forEach((memory, index) => {
      const year = parseYear(memory.captured_at);
      if (year !== null && (!seenYear || year !== lastYear)) {
        flags[index] = true;
        seenYear = true;
        lastYear = year;
      }
    });
    return flags;
  }, [items]);

  // 位置播报：视觉跟随焦点档位（即时），屏幕阅读器只在落定后更新
  const describePosition = useCallback(
    (index: number) => {
      const year = parseYear(items[index]?.captured_at);
      return brand.copy.space.position
        .replace("{year}", year !== null ? String(year) : "—")
        .replace("{index}", String(index + 1))
        .replace("{total}", String(Math.max(total, items.length)));
    },
    [items, total],
  );
  const positionText = describePosition(focusIndex);

  useEffect(() => {
    if (settledIndex === null) {
      return;
    }
    if (liveRegionRef.current) {
      liveRegionRef.current.textContent = describePosition(settledIndex);
    }
  }, [describePosition, settledIndex]);

  return (
    <section
      aria-label={brand.copy.space.stageLabel}
      className="space-feature"
    >
      <div
        className="space-stage"
        data-flat={flat ? "true" : undefined}
        onClick={(event) => {
          if (flat) {
            const pane = (event.target as HTMLElement).closest(
              "[data-space-index]",
            );
            if (pane) {
              const index = Number(pane.getAttribute("data-space-index"));
              if (index === focusIndexRef.current) {
                openPaneAt(index);
              } else {
                camera.goToIndex(index);
              }
            }
            return;
          }
          if (event.detail === 0) {
            // 键盘激活 button 的 click 无指针序号（detail === 0）：
            // 走到聚焦 pane 面前，若已到位则打开查看器
            const pane = (event.target as HTMLElement).closest(
              "[data-space-index]",
            );
            if (pane) {
              openPaneAt(Number(pane.getAttribute("data-space-index")));
            }
            return;
          }
          if (camera.suppressPointerUp()) {
            return; // 拖拽松手后短暂的 click 不拾取
          }
          const index = pickFromPointer(event.clientX, event.clientY);
          if (index === null) {
            return;
          }
          if (index === focusIndexRef.current) {
            onOpenViewer(items[index].id);
          } else {
            camera.goToIndex(index);
          }
        }}
        onKeyDown={(event) => {
          if (NAVIGATION_KEYS.has(event.key)) {
            setHintHidden(true);
          }
        }}
        onPointerDown={() => setHintHidden(true)}
        onPointerLeave={() => setHoveredIndex(null)}
        onPointerMove={(event) => {
          if (flat) {
            return;
          }
          const hit = pickFromPointer(event.clientX, event.clientY);
          setHoveredIndex((current) => (current === hit ? current : hit));
        }}
        onPointerUp={(event) => {
          setHintHidden(true);
          if (flat) {
            return; // flat 时间线整段走 click 两段式（pane 可命中）
          }
          if (camera.suppressPointerUp()) {
            return;
          }
          // pointerup 只负责「走」：点非焦点 pane = 相机走向它。
          // 「看」（打开查看器）放到 click 时机——viewer 覆盖层此刻才渲染，
          // 若在 pointerup 打开，紧随的 click 会命中遮罩把查看器秒关。
          const index = pickFromPointer(event.clientX, event.clientY);
          if (index !== null && index !== focusIndexRef.current) {
            camera.goToIndex(index);
          }
        }}
        onWheel={() => setHintHidden(true)}
        ref={stageRef}
        tabIndex={-1}
      >
        <div className="space-viewport">
          <div
            className="space-corridor"
            onFocusCapture={handleFocusCapture}
            ref={corridorRef}
          >
            {renderList.map(({ memory, index, mounted }) => {
              const worldZ = -(index + 1) * geometry.gap;
              const side: "left" | "right" = index % 2 === 0 ? "left" : "right";
              return (
                <Fragment key={memory.id}>
                  {mounted && milestoneFlags[index] ? (
                    <div
                      aria-hidden="true"
                      className="space-milestone"
                      ref={(element) => {
                        // React 19 ref cleanup：换绑/卸载自动从雾化注册表移除
                        const map = fogTargetsRef.current;
                        if (!element || !map) {
                          return;
                        }
                        map.set(element, worldZ);
                        return () => {
                          map.delete(element);
                        };
                      }}
                      style={
                        {
                          // 几何量在 CSS 由令牌推导，这里只给符号与深度
                          "--space-side": side === "left" ? -1 : 1,
                          "--space-z": `${worldZ}px`,
                        } as CSSProperties
                      }
                    >
                      {parseYear(memory.captured_at)}
                    </div>
                  ) : null}
                  {mounted ? (
                    <SpacePane
                      data-hovered={hoveredIndex === index ? "true" : undefined}
                      enhanced={
                        enhancedIndex !== null &&
                        Math.abs(index - enhancedIndex) <= NEAR_RANGE
                      }
                      fogTargetsRef={fogTargetsRef}
                      index={index}
                      memory={memory}
                      side={side}
                      windowed={!flat}
                      worldZ={worldZ}
                    />
                  ) : null}
                </Fragment>
              );
            })}
            {flat && hasMore ? (
              <div
                aria-hidden="true"
                className="canvas-sentinel"
                ref={tailSentinelRef}
              />
            ) : null}
            {flat && !hasMore && items.length > 0 ? (
              <p className="space-end-note py-6 text-center">
                {brand.copy.canvasEnd}
              </p>
            ) : null}
          </div>
        </div>
        {flat ? null : <div aria-hidden="true" className="space-scrim" />}
        {isLoading ? (
          <p aria-live="polite" className="space-stage-note">
            {brand.copy.loadingLibrary}
          </p>
        ) : null}
        {error ? (
          <div className="space-empty">
            <Notice tone="error">
              <span>{error}</span>
              <Button
                className="ml-2"
                onClick={() => void loadPage(1, "replace")}
                variant="secondary"
              >
                {brand.copy.loadFailedAction}
              </Button>
            </Notice>
          </div>
        ) : null}
        {!isLoading && !error && items.length === 0 ? (
          <div className="space-empty">
            <EmptyState art={Images}>{brand.copy.space.empty}</EmptyState>
          </div>
        ) : null}
        {flat ? null : (
          <>
            <p
              aria-hidden="true"
              className="space-hint"
              data-hidden={hintHidden ? "true" : "false"}
            >
              {brand.copy.space.hint}
            </p>
            <div className="space-hud">
              <button
                className="space-hud-exit"
                onClick={onExitSpace}
                type="button"
              >
                <LayoutGrid aria-hidden="true" className="size-4" />
                {brand.copy.space.toggleActive}
              </button>
              <span aria-hidden="true" className="space-kind-sep" />
              <button
                aria-pressed={!kind}
                className="space-kind-btn"
                onClick={() => onKindChange(undefined)}
                type="button"
              >
                {brand.copy.allKinds}
              </button>
              <button
                aria-pressed={kind === "photo"}
                className="space-kind-btn"
                onClick={() => onKindChange("photo")}
                type="button"
              >
                {brand.copy.photoKind}
              </button>
              <button
                aria-pressed={kind === "video"}
                className="space-kind-btn"
                onClick={() => onKindChange("video")}
                type="button"
              >
                {brand.copy.videoKind}
              </button>
              <span aria-hidden="true" className="space-kind-sep" />
              <span aria-hidden="true" className="space-hud-position tnum">
                {positionText}
              </span>
              <span aria-hidden="true" className="space-kind-sep" />
              <IconButton
                aria-label={brand.copy.space.prev}
                disabled={focusIndex <= 0}
                onClick={() => camera.stepBy(-1)}
              >
                <ChevronUp aria-hidden="true" className="size-5" />
              </IconButton>
              <IconButton
                aria-label={brand.copy.space.next}
                disabled={!hasMore && focusIndex >= items.length - 1}
                onClick={() => camera.stepBy(1)}
              >
                <ChevronDown aria-hidden="true" className="size-5" />
              </IconButton>
            </div>
            <p aria-live="polite" className="sr-only" ref={liveRegionRef} />
          </>
        )}
      </div>
    </section>
  );
}

export default memo(SpaceGallery);
