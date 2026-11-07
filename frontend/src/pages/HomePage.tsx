import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Images, RefreshCw, X } from "lucide-react";
import { useLocation, useSearchParams } from "react-router-dom";

import MemoryCard from "@/components/MemoryCard";
import { brand } from "@/lib/brand";
import {
  getMemoryById,
  getMemories,
  getMemoryRecommendations,
  getPublicPreheatStatus,
  type MemorySummary,
  type PublicPreheatStatus,
} from "@/lib/api";
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
  const [searchInput, setSearchInput] = useState(keyword);
  const [recommendations, setRecommendations] = useState<MemorySummary[]>([]);
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
    (next: URLSearchParams) => {
      const query = next.toString();
      setSearchParams(query ? `?${query}` : "");
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
    void loadPage(1, "replace");
  }, [loadPage]);

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
    if (keyword) {
      // 搜索时直接展示结果，不混入推荐内容。
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
  }, [activeKind, keyword, randomSeed]);

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

  const viewerMemories = canvasMemories;
  const canvasColumns = useMemo(() => {
    const columns = Array.from({ length: columnCount }, () => [] as MemorySummary[]);
    canvasMemories.forEach((memory, index) => {
      columns[index % columnCount].push(memory);
    });
    return columns;
  }, [canvasMemories, columnCount]);
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
  };

  const clearSearch = () => {
    setSearchInput("");
    if (keyword) {
      const next = new URLSearchParams(searchParams);
      next.delete("keyword");
      updateParams(next);
    }
  };

  const openViewer = useCallback(
    (memoryId: string) => {
      const next = new URLSearchParams(searchParams);
      scrollBeforeViewer = window.scrollY;
      next.set("viewer", memoryId);
      updateParams(next);
    },
    [searchParams, updateParams],
  );

  const closeViewer = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("viewer");
    setDirectMemory(null);
    setViewerMissing(false);
    updateParams(next);
    const previousScroll = scrollBeforeViewer;
    window.setTimeout(() => {
      if (Number.isFinite(previousScroll) && previousScroll > 0) {
        window.scrollTo({ behavior: "auto", top: previousScroll });
      }
    }, 100);
  };

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

  useDocumentTitle(
    activeMemory
      ? brand.pageTitleViewer.replace(
          "{title}",
          activeMemory.title || brand.copy.detailPreviewAlt,
        )
      : brand.pageTitleHome,
  );

  return (
    <section aria-labelledby="library-title" className="page-enter">
      <BlurText
        as="h1"
        className="page-title text-3xl font-semibold"
        id="library-title"
        text={brand.copy.libraryTitle}
      />
      <div aria-hidden="true" className="flow-rule mx-auto mt-3 w-16" />
      <p className="mt-2 text-center text-sm text-muted">{brand.copy.libraryDescription}</p>

      <p
        aria-live="polite"
        className="tnum mt-3 text-center text-sm text-muted"
        data-testid="public-count"
      >
        {publicCountState === "loading" ? (
          brand.copy.publicCountLoading
        ) : publicCountState === "error" ? (
          brand.copy.publicCountFailed
        ) : (
          <>
            <span className="font-medium text-foreground">
              {brand.copy.publicCountLabel} {counts.photo + counts.video}
            </span>
            <span aria-hidden="true" className="mx-2 text-border">·</span>
            {brand.copy.photoKind}{" "}
            <span className="font-medium text-foreground">{counts.photo}</span>
            <span aria-hidden="true" className="mx-2 text-border">·</span>
            {brand.copy.videoKind}{" "}
            <span className="font-medium text-foreground">{counts.video}</span>
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

      <div className="library-toolbar filter-toolbar mx-auto mt-6 w-full max-w-2xl">
        <form
          className="library-search"
          onSubmit={(event) => event.preventDefault()}
          role="search"
        >
          <label className="sr-only" htmlFor="library-search">
            {brand.copy.searchLabel}
          </label>
          <input
            className="input min-h-11 w-full"
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
        <div className="filter-toolbar-row flex items-center gap-2">
          <div aria-label={brand.copy.kindFilterLabel} className="segmented" role="group">
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
          <MediaSkeleton columnCount={columnCount} />
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
          <EmptyState art={Images}>
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
                {column.map((memory) => (
                  <MemoryCard
                    key={memory.id}
                    memory={memory}
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
                <span className="ml-2">
                  {brand.copy.canvasEndTotal.replace("{total}", String(total))}
                </span>
              </>
            ) : null}
          </div>
        </section>
      )}

      {viewerMissing ? (
        <Notice className="mt-8" tone="error">
          {brand.copy.notFoundText}
        </Notice>
      ) : null}
      {activeMemory ? (
        <Suspense fallback={null}>
          <MediaViewer
            memory={activeMemory}
            onClose={closeViewer}
            onNext={nextMemory ? () => openViewer(nextMemory.id) : undefined}
            onPrev={previousMemory ? () => openViewer(previousMemory.id) : undefined}
            prefetchTargets={viewerNeighbors}
          />
        </Suspense>
      ) : null}
    </section>
  );
}
