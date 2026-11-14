import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Images, Orbit, RefreshCw, Search, X } from "lucide-react";
import { useLocation, useSearchParams } from "react-router-dom";

import MemoryCard from "@/components/MemoryCard";
import HeroFeature from "@/components/HeroFeature";
import { brand } from "@/lib/brand";
import {
  getMemoryById,
  getMemories,
  getMemoryRecommendations,
  getPublicPreheatStatus,
  type MemorySummary,
  type PublicPreheatStatus,
} from "@/lib/api";
import {
  distributeMasonryColumns,
  FALLBACK_MASONRY_RATIO,
  writeCanvasComposition,
  type CompositionSize,
} from "@/lib/canvas-composition";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import MediaSkeleton from "@/components/ui/MediaSkeleton";
import Notice from "@/components/ui/Notice";
import ProgressBar from "@/components/ui/ProgressBar";
import BlurText from "@/components/ui/BlurText";
import { useDocumentTitle } from "@/lib/useDocumentTitle";

const PAGE_SIZE = 18;
const RECOMMENDATION_COUNT = 8;
const SCROLL_STORAGE_KEY = "limedia:home-scroll";
const PREHEAT_POLL_INTERVAL_MS = 20000;
const PREHEAT_RETRY_DELAYS_MS = [500, 1000, 2000] as const;
// 终态不再轮询：预热任务未启动时状态不会自行变化，下次进页重新查询。
const PREHEAT_TERMINAL_STATUSES = new Set(["ready", "degraded", "unavailable"]);
let scrollBeforeViewer = 0;
const MEMORY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function normalizeViewerId(raw: string | null): string | undefined {
  // viewer 来自 URL 输入：不合法直接视为无查看器，避免进入请求路径。
  return raw && MEMORY_ID_PATTERN.test(raw) ? raw : undefined;
}

const MediaViewer = lazy(() => import("@/components/MediaViewer"));
const SpaceGallery = lazy(() => import("@/components/space/SpaceGallery"));

function createRandomSeed() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function prefetchMediaViewerChunk() {
  void import("@/components/MediaViewer").catch(() => {
    // Prefetching is an optimization; lazy loading remains the fallback.
  });
}

type ColumnBreakpoint = {
  query: string;
  count: 2 | 3 | 4 | 5 | 6;
};

type CanvasFooterState = "hidden" | "loading" | "retry" | "end";

type RandomSeedState = {
  kind: "photo" | "video" | undefined;
  seed: string;
};

const columnBreakpoints: ColumnBreakpoint[] = [
  { query: "(min-width: 1600px)", count: 6 },
  { query: "(min-width: 1280px)", count: 5 },
  { query: "(min-width: 1024px)", count: 4 },
  { query: "(min-width: 768px)", count: 3 },
] as const;

// 预热到终态时，只有停在页面顶部附近的用户才自动补图刷新。
const AUTO_REFRESH_MAX_SCROLL_Y = 120;

// hero 精选的比例门槛：全出血舞台按 cover 裁切，比例差得越远裁得越多。
// 以「可见面积占比」衡量——图像比例与舞台比例之比低于该值(裁剩 <60%)
// 的图像不进随机池，避免竖图在宽幅舞台被裁成细条；全部不合适时回退全集。
const HERO_FIT_MIN_VISIBLE = 0.6;

/** hero 舞台当前比例（与 CSS 同口径：桌面 clamp(560px, 92svh, 920px)，
 *  移动端 ≤768px 全屏 100svh——innerHeight 即 svh 可见视口高） */
function heroStageRatio(): number {
  const isMobile = window.matchMedia("(max-width: 768px)").matches;
  const stageHeight = isMobile
    ? window.innerHeight
    : Math.min(Math.max(window.innerHeight * 0.92, 560), 920);
  return window.innerWidth / stageHeight;
}

/** 图像在 hero 舞台上按 cover 展示时的可见面积占比（0-1] */
function heroVisibleFraction(width: number, height: number): number {
  const imageRatio = width / height;
  const stageRatio = heroStageRatio();
  return Math.min(imageRatio, stageRatio) / Math.max(imageRatio, stageRatio);
}

function useCanvasColumnCount() {
  const [columnCount, setColumnCount] = useState(2);

  useEffect(() => {
    const queries = columnBreakpoints.map(({ query }) =>
      window.matchMedia(query),
    );
    const update = () => {
      const matchedIndex = queries.findIndex((query) => query.matches);
      setColumnCount(matchedIndex >= 0 ? columnBreakpoints[matchedIndex].count : 2);
    };

    update();
    queries.forEach((query) => query.addEventListener("change", update));
    return () => {
      queries.forEach((query) => query.removeEventListener("change", update));
    };
  }, []);

  return columnCount;
}

export default function HomePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { pathname } = useLocation();
  const kind = searchParams.get("kind") ?? undefined;
  const viewerId = normalizeViewerId(searchParams.get("viewer"));
  const keyword = (searchParams.get("keyword") ?? "").trim();
  // 空间画廊视图：/?view=space 切换沉浸式时间回廊，网格数据流整体让位
  const isSpaceView = searchParams.get("view") === "space";
  const [searchInput, setSearchInput] = useState(keyword);
  const [recommendations, setRecommendations] = useState<MemorySummary[]>([]);
  // 回廊已载条目上报：查看器在此视图下从回廊列表解析相邻内容与位置
  const [spaceState, setSpaceState] = useState<{
    items: MemorySummary[];
    total: number;
  }>({ items: [], total: 0 });
  // 3D 沉浸态（flat 时间线不算）：驱动页眉压图配色与页脚隐藏
  const [spaceImmersive, setSpaceImmersive] = useState(false);
  const [memories, setMemories] = useState<MemorySummary[]>([]);
  const [directMemory, setDirectMemory] = useState<MemorySummary | null>(null);
  const [viewerMissing, setViewerMissing] = useState(false);
  const [counts, setCounts] = useState({ photo: 0, video: 0 });
  const [total, setTotal] = useState(0);
  const [publicCountState, setPublicCountState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [preheatSummary, setPreheatSummary] = useState<PublicPreheatStatus | null>(null);
  const [preheatState, setPreheatState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const preheatStatusRef = useRef<PublicPreheatStatus | null>(null);
  const [isLoadingInitial, setIsLoadingInitial] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const hasRestoredScroll = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const requestTokenRef = useRef(0);
  const pageRef = useRef(1);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const activeKind = kind === "photo" || kind === "video" ? kind : undefined;
  const columnCount = useCanvasColumnCount();

  // 分段筛选滑动指示器：测量激活项的偏移与宽度，覆盖层用 transform/width
  // 过渡滑过去（覆盖层不参与文档流，宽度变化不引起外部回流）。
  // 依赖：类型切换、计数位数（按钮宽度随数字变化）、容器尺寸（换行/缩放）。
  const segmentedRef = useRef<HTMLDivElement>(null);
  const [segmentIndicator, setSegmentIndicator] = useState({
    x: 0,
    w: 0,
    ready: false,
  });
  useLayoutEffect(() => {
    const container = segmentedRef.current;
    if (!container) {
      return;
    }

    const measure = () => {
      const active = container.querySelector<HTMLElement>('[data-active="true"]');
      if (!active) {
        setSegmentIndicator((current) =>
          current.ready ? { ...current, ready: false } : current,
        );
        return;
      }
      setSegmentIndicator({
        x: active.offsetLeft,
        w: active.offsetWidth,
        ready: true,
      });
    };

    measure();
    // 字体就绪会改变按钮文字宽度；首帧后补量一次
    if (typeof document.fonts?.ready?.then === "function") {
      void document.fonts.ready.then(measure).catch(() => {});
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeKind, counts.photo, counts.video]);
  const [seedState, setSeedState] = useState<RandomSeedState>(() => ({
    kind: activeKind,
    seed: createRandomSeed(),
  }));

  if (seedState.kind !== activeKind) {
    setSeedState({
      kind: activeKind,
      seed: createRandomSeed(),
    });
  }

  const randomSeed = seedState.seed;
  const hasNextPage = memories.length > 0 && memories.length < total;

  // setSearchParams is stable across renders; memoizing keeps openViewer
  // referentially stable so memoized MemoryCards skip reconciliation while
  // the URL (and therefore searchParams) is unchanged.
  const updateParams = useCallback(
    (next: URLSearchParams, options?: { replace?: boolean }) => {
      const query = next.toString();
      setSearchParams(query ? `?${query}` : "", options);
    },
    [setSearchParams],
  );

  const loadPage = useCallback(async (
    page: number,
    mode: "replace" | "append",
  ) => {
    const requestToken = requestTokenRef.current + 1;
    requestTokenRef.current = requestToken;

    if (mode === "replace") {
      setIsLoadingInitial(true);
      setMemories([]);
      setViewerMissing(false);
    } else {
      setIsLoadingMore(true);
    }

    try {
      const data = await getMemories({
        kind: activeKind,
        keyword: keyword || undefined,
        page,
        page_size: PAGE_SIZE,
        seed: randomSeed,
        sort: "random",
      });

      if (requestToken !== requestTokenRef.current) {
        return false;
      }

      pageRef.current = page;

      setMemories((current) => {
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
      // 计数行与类型页签都用「可展示口径」：与画布实际可见内容一致，
      // 预热推进时同步增长；全量公开口径（public_counts）留给后台审计。
      if (data.counts) {
        setCounts(data.counts);
        setPublicCountState("ready");
      } else {
        setPublicCountState("error");
      }
      setError(null);
      setLoadMoreError(null);
      return true;
    } catch {
      if (requestToken === requestTokenRef.current) {
        if (mode === "replace") {
          setError(brand.copy.loadFailed);
        } else {
          setLoadMoreError(brand.copy.loadMoreFailed);
        }
      }
      return false;
    } finally {
      if (requestToken === requestTokenRef.current) {
        if (mode === "replace") {
          setIsLoadingInitial(false);
        } else {
          setIsLoadingMore(false);
        }
      }
    }
  }, [activeKind, keyword, randomSeed]);

  useEffect(() => {
    // 空间视图有自己的 captured_desc 数据流，网格初始加载让位；
    // 返回网格时本 effect 随依赖重建自动恢复。
    if (isSpaceView) {
      return;
    }
    void loadPage(1, "replace");
  }, [loadPage, isSpaceView]);

  // 预热轮询 effect 不随筛选/种子重建，用 ref 拿到最新的 loadPage。
  const loadPageRef = useRef(loadPage);
  useEffect(() => {
    loadPageRef.current = loadPage;
  }, [loadPage]);

  // 搜索输入防抖同步到 URL keyword 参数；URL 外部变化（如切换类型清除
  // 关键词）时回填输入框，保持单一事实来源。
  useEffect(() => {
    setSearchInput(keyword);
  }, [keyword]);

  useEffect(() => {
    const normalized = searchInput.trim();
    if (normalized === keyword) {
      return;
    }

    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (normalized) {
        next.set("keyword", normalized);
      } else {
        next.delete("keyword");
      }
      updateParams(next);
      // 新关键词生效后从顶部看结果（与换一批行为对齐）
      window.scrollTo({ behavior: "auto", top: 0 });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [keyword, searchInput, searchParams, updateParams]);

  useEffect(() => {
    let active = true;
    let pollTimer = 0;
    let failureAttempts = 0;

    const clearPollTimer = () => {
      window.clearTimeout(pollTimer);
    };

    const schedulePoll = (delayMs: number) => {
      clearPollTimer();
      pollTimer = window.setTimeout(loadPreheatStatus, delayMs);
    };

    const loadPreheatStatus = () => {
      getPublicPreheatStatus()
        .then((summary) => {
          if (!active) {
            return;
          }
          const previous = preheatStatusRef.current;
          preheatStatusRef.current = summary;
          setPreheatSummary(summary);
          setPreheatState("ready");
          failureAttempts = 0;
          const becameTerminal =
            previous !== null &&
            !PREHEAT_TERMINAL_STATUSES.has(previous.status) &&
            PREHEAT_TERMINAL_STATUSES.has(summary.status);
          if (becameTerminal && window.scrollY <= AUTO_REFRESH_MAX_SCROLL_Y) {
            // 预热刚到终态：顶部附近的用户即刻补齐新就绪的内容；
            // 滚动深处不打扰，下一次筛选/换一批自然生效。
            void loadPageRef.current(1, "replace");
          }
          if (!PREHEAT_TERMINAL_STATUSES.has(summary.status)) {
            schedulePoll(PREHEAT_POLL_INTERVAL_MS);
          }
        })
        .catch(() => {
          if (!active) {
            return;
          }
          setPreheatSummary(null);
          setPreheatState("error");
          if (failureAttempts < PREHEAT_RETRY_DELAYS_MS.length) {
            const delay = PREHEAT_RETRY_DELAYS_MS[failureAttempts];
            failureAttempts += 1;
            schedulePoll(delay);
          }
        });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const current = preheatStatusRef.current;
      // 终态不因切回标签页重新请求；尚未拿到状态或非终态时立即刷新。
      if (current === null || !PREHEAT_TERMINAL_STATUSES.has(current.status)) {
        failureAttempts = 0;
        schedulePoll(0);
      }
    };

    loadPreheatStatus();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      active = false;
      clearPollTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (keyword || isSpaceView) {
      // 搜索时直接展示结果，不混入推荐内容；空间视图不拉推荐。
      setRecommendations([]);
      return;
    }

    let active = true;

    getMemoryRecommendations(RECOMMENDATION_COUNT, activeKind)
      .then((items) => {
        if (active && Array.isArray(items)) {
          setRecommendations(items);
        } else if (active) {
          setRecommendations([]);
        }
      })
      .catch(() => {
        if (active) {
          setRecommendations([]);
        }
      });

    return () => {
      active = false;
    };
  }, [activeKind, keyword, randomSeed, isSpaceView]);

  const refreshRandomOrder = useCallback(() => {
    if (isLoadingInitial) {
      return;
    }

    setSeedState((current) => ({
      ...current,
      seed: createRandomSeed(),
    }));
    window.scrollTo({ behavior: "auto", top: 0 });
  }, [isLoadingInitial]);

  const canvasMemories = useMemo(() => {
    const unique = new Map<string, MemorySummary>();
    [...recommendations, ...memories].forEach((memory) => {
      unique.set(memory.id, memory);
    });
    return Array.from(unique.values());
  }, [recommendations, memories]);
  const canvasFooterState: CanvasFooterState = canvasMemories.length === 0
    ? "hidden"
    : loadMoreError
      ? "retry"
      : isLoadingMore
        ? "loading"
        : memories.length >= total
          ? "end"
          : "hidden";

  // 查看器内容序列：网格视图用画布列表；空间视图用回廊已载列表
  // （total 用回廊全量口径，查看器位置「第 n / 总数」与相机 HUD 一致）
  const viewerMemories = isSpaceView ? spaceState.items : canvasMemories;
  const viewerTotal = isSpaceView
    ? Math.max(spaceState.total, spaceState.items.length)
    : viewerMemories.length;

  // 图像 hero：首屏数据一到就捕获精选集（≤5 条），之后画布换批/翻页/
  // 筛选都不再改动 hero——它是「这个库长什么样」的第一印象，保持稳定。
  // 捕获必须在渲染期完成：若放到 effect，列表到达时会先提交一帧
  // 「hero 消失」再提交「hero 出现」，整页内容两次大跳（CLS 预算实测 0.18）。
  // 捕获时按舞台比例过滤随机池：只随机 cover 后仍保留 ≥60% 可见面积的
  // 图像（比例贴合），竖图在宽幅舞台不会再被裁成细条；无合适图像时
  // （移动端全屏舞台比例更极端，常见 4:5 竖图也会低于门槛）按可见占比
  // 降序取前 5——hero 永远选最贴合的图，不因比例门槛而退场。
  const [heroSource, setHeroSource] = useState<MemorySummary[] | null>(null);
  if (heroSource === null && !isLoadingInitial && canvasMemories.length > 0) {
    const fraction = (memory: MemorySummary) =>
      !memory.width || !memory.height
        ? 1
        : heroVisibleFraction(memory.width, memory.height);
    const ranked = canvasMemories.map((memory) => ({
      memory,
      visible: fraction(memory),
    }));
    const fitting = ranked.filter((item) => item.visible >= HERO_FIT_MIN_VISIBLE);
    const pool = fitting.length > 0
      ? fitting
      : [...ranked].sort((a, b) => b.visible - a.visible);
    setHeroSource(pool.slice(0, 5).map((item) => item.memory));
  }
  const heroMemories = heroSource ?? [];

  // 骨架屏按真实宽高实时计算：优先内存中的真实 items（筛选/换批场景
  // 直接复用上一批尺寸），数据到达后写入构图缓存供下次刷新复用。
  const knownSizes = useMemo(
    () =>
      canvasMemories
        .slice(0, 36)
        .map((memory) =>
          memory.width && memory.height
            ? { width: memory.width, height: memory.height }
            : null,
        )
        .filter((size): size is CompositionSize => size !== null),
    [canvasMemories],
  );
  useEffect(() => {
    if (!isLoadingInitial && canvasMemories.length > 0) {
      writeCanvasComposition(canvasMemories);
    }
  }, [canvasMemories, isLoadingInitial]);

  // 页眉压图配色开关：hero 在首屏时页眉切浅色（滚过阈值由 .is-scrolled 接管）；
  // 搜索态收起 hero（见下），页眉回到常规配色，结果区顶到工具条。
  // 空间画廊 3D 沉浸态同样压图（页眉悬在回廊上方），flat 时间线不压。
  useEffect(() => {
    const immersive = isSpaceView && spaceImmersive;
    document.body.classList.toggle(
      "has-hero",
      immersive || (!isSpaceView && heroMemories.length > 0 && !keyword),
    );
    // 沉浸态隐藏页脚并去掉画布底部留白，滚轮不链式滚出舞台（CSS 联动）
    document.body.classList.toggle("has-space-stage", immersive);
    return () => {
      document.body.classList.remove("has-hero");
      document.body.classList.remove("has-space-stage");
    };
  }, [heroMemories.length, keyword, isSpaceView, spaceImmersive]);
  // 瀑布屏分配：最短列优先（按已知宽高比估算列高），列底基本齐平，
  // 消除轮转均分因横竖图聚集造成的大片空白；未知尺寸用 4/5 兜底。
  const canvasColumns = useMemo(
    () =>
      distributeMasonryColumns(canvasMemories, columnCount, (memory) =>
        memory.width && memory.height
          ? memory.height / memory.width
          : FALLBACK_MASONRY_RATIO,
      ),
    [canvasMemories, columnCount],
  );
  const firstRowIds = useMemo(
    () =>
      new Set(
        canvasColumns
          .map((column) => column[0])
          .filter((memory): memory is MemorySummary => Boolean(memory))
          .map((memory) => memory.id),
      ),
    [canvasColumns],
  );
  useEffect(() => {
    if (!viewerId || viewerMemories.some((memory) => memory.id === viewerId)) {
      return;
    }

    let active = true;
    setDirectMemory(null);
    setViewerMissing(false);
    getMemoryById(viewerId)
      .then((memory) => {
        if (active) {
          setDirectMemory(memory);
        }
      })
      .catch(() => {
        if (active) {
          setViewerMissing(true);
        }
      });

    return () => {
      active = false;
    };
  }, [viewerId, viewerMemories]);

  useEffect(() => {
    const saveScroll = () => {
      window.sessionStorage.setItem(SCROLL_STORAGE_KEY, String(window.scrollY));
    };

    window.addEventListener("scroll", saveScroll, { passive: true });
    return () => window.removeEventListener("scroll", saveScroll);
  }, []);

  useEffect(() => {
    if (isLoadingInitial || hasRestoredScroll.current) {
      return;
    }

    hasRestoredScroll.current = true;
    const previousScroll = Number(window.sessionStorage.getItem(SCROLL_STORAGE_KEY) ?? "0");
    if (!Number.isFinite(previousScroll) || previousScroll <= 0 || pathname !== "/") {
      return;
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.scrollTo({ behavior: "auto", top: previousScroll });
      });
    });
  }, [isLoadingInitial, pathname]);

  // 从空间画廊返回网格时恢复进入前的滚动位置（进入时已由滚动监听存档）
  const wasSpaceViewRef = useRef(false);
  useEffect(() => {
    if (isSpaceView) {
      wasSpaceViewRef.current = true;
      return;
    }
    if (!wasSpaceViewRef.current || isLoadingInitial) {
      return;
    }
    wasSpaceViewRef.current = false;
    const previousScroll = Number(
      window.sessionStorage.getItem(SCROLL_STORAGE_KEY) ?? "0",
    );
    if (!Number.isFinite(previousScroll) || previousScroll <= 0 || pathname !== "/") {
      return;
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.scrollTo({ behavior: "auto", top: previousScroll });
      });
    });
  }, [isSpaceView, isLoadingInitial, pathname]);

  useEffect(() => {
    if (isLoadingInitial || canvasMemories.length === 0) {
      return;
    }

    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(() => prefetchMediaViewerChunk());
      return () => window.cancelIdleCallback(idleId);
    }

    const timer = window.setTimeout(prefetchMediaViewerChunk, 1);
    return () => window.clearTimeout(timer);
  }, [canvasMemories.length, isLoadingInitial]);

  useEffect(() => {
    if (viewerId) {
      return;
    }

    const previousScroll = scrollBeforeViewer;
    if (!Number.isFinite(previousScroll) || previousScroll <= 0 || pathname !== "/") {
      return;
    }

    window.setTimeout(() => {
      window.scrollTo({ behavior: "auto", top: previousScroll });
    }, 100);
  }, [pathname, viewerId]);

  const loadNextPage = useCallback(() => {
    if (isLoadingInitial || isLoadingMore || isLoadingMoreRef.current || error || loadMoreError || !hasNextPage) {
      return;
    }

    isLoadingMoreRef.current = true;
    void loadPage(pageRef.current + 1, "append").finally(() => {
      isLoadingMoreRef.current = false;
    });
  }, [
    error,
    hasNextPage,
    isLoadingInitial,
    isLoadingMore,
    loadMoreError,
    loadPage,
  ]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || isLoadingInitial || isLoadingMore || error || loadMoreError || !hasNextPage) {
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
  }, [
    error,
    hasNextPage,
    isLoadingInitial,
    isLoadingMore,
    loadNextPage,
  ]);

  const changeKind = (nextKind: "photo" | "video" | undefined) => {
    const next = new URLSearchParams(searchParams);
    if (nextKind) {
      next.set("kind", nextKind);
    } else {
      next.delete("kind");
    }
    next.delete("keyword");
    next.delete("sort");
    next.delete("page");
    updateParams(next);
    // 直觉对齐：切换类型后从顶部看新结果（与换一批一致）
    window.scrollTo({ behavior: "auto", top: 0 });
  };

  const clearSearch = () => {
    setSearchInput("");
    if (keyword) {
      const next = new URLSearchParams(searchParams);
      next.delete("keyword");
      updateParams(next);
    }
  };

  // 空间画廊进出：view 参数驱动（URL 可深链分享），网格数据流原地让位
  const enterSpace = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.set("view", "space");
    updateParams(next);
  }, [searchParams, updateParams]);

  const exitSpace = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("view");
    updateParams(next);
  }, [searchParams, updateParams]);

  const handleSpaceItemsChange = useCallback((items: MemorySummary[], total: number) => {
    setSpaceState({ items, total });
  }, []);

  const handleSpaceImmersiveChange = useCallback((immersive: boolean) => {
    setSpaceImmersive(immersive);
  }, []);

  const openViewer = useCallback(
    (memoryId: string, options?: { replace?: boolean }) => {
      const next = new URLSearchParams(searchParams);
      // 仅从画布进入 viewer 时记录原位；翻页（replace）不覆盖滚动原点
      if (!searchParams.get("viewer")) {
        scrollBeforeViewer = window.scrollY;
      }
      next.set("viewer", memoryId);
      updateParams(next, options);
    },
    [searchParams, updateParams],
  );

  const closeViewer = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("viewer");
    setDirectMemory(null);
    setViewerMissing(false);
    // 关闭 viewer 用 replace：back 不应重新打开 viewer，而是离开本页
    updateParams(next, { replace: true });
    const previousScroll = scrollBeforeViewer;
    window.setTimeout(() => {
      if (Number.isFinite(previousScroll) && previousScroll > 0) {
        window.scrollTo({ behavior: "auto", top: previousScroll });
      }
    }, 100);
  };

  // hero CTA「进入回忆库」：滚动到画布工具条，尊重 reduced-motion 偏好
  const enterLibrary = useCallback(() => {
    const target = document.querySelector(".library-toolbar");
    if (!target) {
      return;
    }
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }, []);

  const activeMemory = viewerMemories.find((memory) => memory.id === viewerId)
    ?? directMemory;
  const activeMemoryIndex = activeMemory
    ? viewerMemories.findIndex((memory) => memory.id === activeMemory.id)
    : -1;
  const previousMemory = activeMemoryIndex > 0
    ? viewerMemories[activeMemoryIndex - 1]
    : null;
  const nextMemory = activeMemoryIndex >= 0
    && activeMemoryIndex < viewerMemories.length - 1
    ? viewerMemories[activeMemoryIndex + 1]
    : null;
  const viewerNeighbors = useMemo(
    () =>
      [previousMemory, nextMemory].filter(
        (neighbor): neighbor is MemorySummary => Boolean(neighbor),
      ),
    [previousMemory, nextMemory],
  );

  // 查看器接近已加载末尾时自动续载：翻到画布边界前先追加下一页，
  // 用户无需退出查看器回画布滚动；loadNextPage 内部守卫防并发与重复。
  useEffect(() => {
    if (!viewerId || !hasNextPage || isLoadingInitial) {
      return;
    }
    if (activeMemoryIndex >= 0 && activeMemoryIndex >= viewerMemories.length - 3) {
      loadNextPage();
    }
  }, [
    activeMemoryIndex,
    hasNextPage,
    isLoadingInitial,
    loadNextPage,
    viewerId,
    viewerMemories.length,
  ]);

  useDocumentTitle(
    activeMemory
      ? brand.pageTitleViewer.replace(
          "{title}",
          activeMemory.title || brand.copy.detailPreviewAlt,
        )
      : brand.pageTitleHome,
  );

  // URL 驱动查看器：两个视图共用（覆盖层不卸载底视图，回廊相机位置得以保留）
  const viewerNode = activeMemory ? (
    <Suspense fallback={null}>
      <MediaViewer
        memory={activeMemory}
        position={
          activeMemoryIndex >= 0
            ? { index: activeMemoryIndex + 1, total: viewerTotal }
            : undefined
        }
        isLoadingMore={isLoadingMore}
        onClose={closeViewer}
        onNext={nextMemory ? () => openViewer(nextMemory.id, { replace: true }) : undefined}
        onPrev={previousMemory ? () => openViewer(previousMemory.id, { replace: true }) : undefined}
        prefetchTargets={viewerNeighbors}
      />
    </Suspense>
  ) : null;
  const viewerMissingNode = viewerMissing ? (
    <Notice className="mt-8" tone="error">
      {brand.copy.notFoundText}
    </Notice>
  ) : null;

  // 空间画廊视图：hero/工具条/瀑布流整体让位，回廊即舞台。
  // 提前返回放在全部 hooks 之后，hook 调用顺序与视图无关。
  if (isSpaceView) {
    return (
      <section aria-labelledby="library-title" className="page-enter hero-page">
        <h1 className="sr-only" id="library-title">
          {brand.copy.libraryTitle}
        </h1>
        <Suspense
          fallback={
            <div aria-hidden="true" className="space-feature">
              <div className="space-stage-fallback" />
            </div>
          }
        >
          <SpaceGallery
            kind={activeKind}
            onExitSpace={exitSpace}
            onImmersiveChange={handleSpaceImmersiveChange}
            onItemsChange={handleSpaceItemsChange}
            onKindChange={changeKind}
            onOpenViewer={openViewer}
          />
        </Suspense>
        {viewerMissingNode}
        {viewerNode}
      </section>
    );
  }

  // 搜索态收起 hero：结果（含空结果态）直接顶到工具条，hero 不再隔一屏；
  // 清除搜索后按已捕获的 heroSource 原样恢复，第一印象不变。
  const heroHidden = keyword.length > 0 || heroMemories.length === 0;

  return (
    <section aria-labelledby="library-title" className="page-enter hero-page">
      {keyword ? null : (
        <HeroFeature
          loading={isLoadingInitial && heroMemories.length === 0}
          memories={heroMemories}
          onEnter={enterLibrary}
          onOpen={openViewer}
        />
      )}
      {/* hero 不在时保证页面恰有一个 h1：搜索态/空库/加载失败场景兜底 */}
      {heroHidden ? (
        <BlurText
          as="h1"
          className={`page-title text-3xl sm:text-5xl font-semibold tracking-wide ${
            isLoadingInitial ? "sr-only" : ""
          }`}
          id="library-title"
          text={brand.copy.libraryTitle}
        />
      ) : null}
      {heroHidden && !isLoadingInitial ? (
        <>
          <div aria-hidden="true" className="flow-rule mx-auto mt-4 w-16" />
          <p className="mt-3 text-center text-base text-muted">{brand.copy.libraryDescription}</p>
        </>
      ) : null}

      <p
        aria-live="polite"
        className="tnum page-enter mt-5 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-center"
        data-testid="public-count"
        style={{ animationDelay: "80ms" }}
      >
        {publicCountState === "loading" ? (
          <span className="text-sm text-muted">{brand.copy.publicCountLoading}</span>
        ) : publicCountState === "error" ? (
          <span className="text-sm text-muted">{brand.copy.publicCountFailed}</span>
        ) : (
          <>
            <span className="flex items-baseline gap-2">
              <span className="text-sm text-muted">{brand.copy.publicCountLabel}</span>
              <span className="font-display text-2xl font-semibold text-foreground">
                {" "}
                {counts.photo + counts.video}
              </span>
            </span>
            <span aria-hidden="true" className="h-8 w-px bg-border" />
            <span className="flex items-baseline gap-2">
              <span className="text-sm text-muted">{brand.copy.photoKind}</span>
              <span className="font-display text-2xl font-semibold text-foreground">
                {" "}
                {counts.photo}
              </span>
            </span>
            <span aria-hidden="true" className="h-8 w-px bg-border" />
            <span className="flex items-baseline gap-2">
              <span className="text-sm text-muted">{brand.copy.videoKind}</span>
              <span className="font-display text-2xl font-semibold text-foreground">
                {" "}
                {counts.video}
              </span>
            </span>
          </>
        )}
      </p>

      {/* 预热状态只在有信息量时渲染：加载中与 ready 不占位、不闪现。 */}
      {preheatState === "error" || preheatSummary?.status === "unavailable" ? (
        <p
          aria-live="polite"
          className="mt-2 text-center text-sm text-muted"
          data-testid="preheat-status"
        >
          {brand.copy.preheatStatusUnavailable}
        </p>
      ) : preheatSummary?.status === "running" ? (
        <div className="mx-auto mt-2 max-w-xs" data-testid="preheat-status">
          <p aria-live="polite" className="text-center text-sm text-muted">
            {brand.copy.preheatStatusRunning}
            <span className="ml-2">
              {brand.copy.preheatStatusProgress}{" "}
              {preheatSummary.processed}/{preheatSummary.total}
            </span>
          </p>
          <ProgressBar
            label={brand.copy.preheatStatusRunning}
            value={
              preheatSummary.total > 0
                ? (preheatSummary.processed / preheatSummary.total) * 100
                : 0
            }
          />
        </div>
      ) : preheatSummary?.status === "not_preheated" ? (
        <p
          aria-live="polite"
          className="mt-2 text-center text-sm text-muted"
          data-testid="preheat-status"
        >
          {brand.copy.preheatStatusNotPreheated}
        </p>
      ) : preheatSummary?.status === "degraded" ? (
        <p
          aria-live="polite"
          className="mt-2 text-center text-sm text-muted"
          data-testid="preheat-status"
        >
          {brand.copy.preheatStatusDegraded}
        </p>
      ) : null}

      <div
        className="library-toolbar filter-toolbar page-enter mx-auto mt-8 w-full max-w-2xl"
        style={{ animationDelay: "160ms" }}
      >
        <form
          className="library-search relative"
          onSubmit={(event) => event.preventDefault()}
          role="search"
        >
          <label className="sr-only" htmlFor="library-search">
            {brand.copy.searchLabel}
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted"
          />
          <input
            className="input min-h-11 w-full pl-10"
            id="library-search"
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={brand.copy.searchPlaceholder}
            type="search"
            value={searchInput}
          />
          {keyword ? (
            <Button
              aria-label={brand.copy.clearSearch}
              className="icon-btn shrink-0"
              onClick={clearSearch}
              title={brand.copy.clearSearch}
              variant="secondary"
            >
              <X aria-hidden="true" className="size-5" />
            </Button>
          ) : null}
        </form>
        <div className="filter-toolbar-row flex flex-wrap items-center gap-2">
          <div
            aria-label={brand.copy.kindFilterLabel}
            className="segmented"
            ref={segmentedRef}
            role="group"
          >
            <span
              aria-hidden="true"
              className="segmented-indicator"
              data-ready={segmentIndicator.ready ? "true" : "false"}
              style={{
                transform: `translateX(${segmentIndicator.x}px)`,
                width: segmentIndicator.w,
              }}
            />
            <button
              aria-pressed={!activeKind}
              data-active={!activeKind ? "true" : "false"}
              onClick={() => changeKind(undefined)}
              type="button"
            >
              {brand.copy.allKinds}
            </button>
            <button
              aria-pressed={activeKind === "photo"}
              data-active={activeKind === "photo" ? "true" : "false"}
              onClick={() => changeKind("photo")}
              type="button"
            >
              {brand.copy.photoKind}
              <span className="segmented-count">{counts.photo}</span>
            </button>
            <button
              aria-pressed={activeKind === "video"}
              data-active={activeKind === "video" ? "true" : "false"}
              onClick={() => changeKind("video")}
              type="button"
            >
              {brand.copy.videoKind}
              <span className="segmented-count">{counts.video}</span>
            </button>
          </div>
          <Button
            aria-label={brand.copy.homeRefresh}
            className="icon-btn"
            disabled={isLoadingInitial}
            onClick={refreshRandomOrder}
            title={brand.copy.homeRefresh}
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className={`size-5 ${isLoadingInitial ? "animate-spin" : ""}`} />
          </Button>
          <Button
            aria-label={brand.copy.space.toggle}
            onClick={enterSpace}
            title={brand.copy.space.toggle}
            variant="secondary"
          >
            <Orbit aria-hidden="true" className="size-5" />
            {/* 窄屏收成纯图标：筛选条一行放不下图标+文字（横向溢出回归） */}
            <span className="hidden sm:inline">{brand.copy.space.toggle}</span>
          </Button>
        </div>
      </div>

      {keyword ? (
        <p
          aria-live="polite"
          className="mt-3 text-center text-sm text-muted"
          data-testid="search-summary"
        >
          {brand.copy.resultSummary.replace("{total}", String(total))}
        </p>
      ) : null}

      {isLoadingInitial ? (
        <>
          <span className="sr-only">{brand.copy.loadingLibrary}</span>
          <MediaSkeleton columnCount={columnCount} sizes={knownSizes} />
        </>
      ) : error ? (
        <Notice className="mt-8" tone="error">
          <span>{error}</span>
          <Button
            className="ml-2"
            onClick={() => void loadPage(1, "replace")}
            variant="secondary"
          >
            {brand.copy.loadFailedAction}
          </Button>
        </Notice>
      ) : canvasMemories.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            action={
              keyword ? (
                <Button onClick={clearSearch} variant="secondary">
                  {brand.copy.clearSearch}
                </Button>
              ) : null
            }
            art={Images}
          >
            {keyword
              ? brand.copy.emptySearch
              : preheatSummary !== null &&
                  !PREHEAT_TERMINAL_STATUSES.has(preheatSummary.status)
                ? brand.copy.emptyLibraryPreparing
                : brand.copy.emptyLibrary}
          </EmptyState>
        </div>
      ) : (
        <section
          aria-label={brand.copy.libraryTitle}
          className="infinite-canvas mx-auto w-full"
        >
          <div
            className="masonry"
            style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
          >
            {canvasColumns.map((column, columnIndex) => (
              <div className="canvas-column" key={columnIndex}>
                {column.map((memory, itemIndex) => (
                  <MemoryCard
                    key={memory.id}
                    memory={memory}
                    enterIndex={itemIndex * columnCount + columnIndex}
                    onPrefetch={prefetchMediaViewerChunk}
                    onOpen={openViewer}
                    priority={firstRowIds.has(memory.id)}
                  />
                ))}
              </div>
            ))}
          </div>
          <div aria-hidden="true" className="canvas-sentinel" ref={sentinelRef} />
          <div
            aria-live="polite"
            className="canvas-loading"
            data-testid="canvas-footer"
            data-state={canvasFooterState}
            role="status"
          >
            {canvasFooterState === "loading" ? (
              <span>{brand.copy.loadingMoreLibrary}</span>
            ) : canvasFooterState === "retry" ? (
              <>
                <span>{loadMoreError}</span>
                <Button
                  className="ml-2"
                  onClick={() => {
                    setLoadMoreError(null);
                    loadNextPage();
                  }}
                  variant="secondary"
                >
                  {brand.copy.retryLoadMore}
                </Button>
              </>
            ) : canvasFooterState === "end" ? (
              <>
                <span>{brand.copy.canvasEnd}</span>
                <span aria-hidden="true" className="mx-2 text-muted">·</span>
                <span>
                  {brand.copy.canvasEndTotal.replace("{total}", String(total))}
                </span>
              </>
            ) : null}
          </div>
        </section>
      )}

      {viewerMissingNode}
      {viewerNode}
    </section>
  );
}
