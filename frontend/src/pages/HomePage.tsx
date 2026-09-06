import { useCallback, useEffect, useRef, useState } from "react";
import { Images, Search, X } from "lucide-react";
import { useLocation, useSearchParams } from "react-router-dom";

import MemoryCard from "@/components/MemoryCard";
import MediaViewer from "@/components/MediaViewer";
import { brand } from "@/lib/brand";
import { getMemoryById, getMemories, type Memory } from "@/lib/api";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import IconButton from "@/components/ui/IconButton";
import MediaSkeleton from "@/components/ui/MediaSkeleton";
import Notice from "@/components/ui/Notice";
import Pagination from "@/components/ui/Pagination";

const PAGE_SIZE = 24;
const SCROLL_STORAGE_KEY = "limedia:home-scroll";
let scrollBeforeViewer = 0;

export default function HomePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { pathname } = useLocation();
  const kind = searchParams.get("kind") ?? undefined;
  const keyword = searchParams.get("keyword") ?? "";
  const page = Number(searchParams.get("page") ?? "1");
  const sort = searchParams.get("sort") ?? "captured_desc";
  const viewerId = searchParams.get("viewer");
  const [searchInput, setSearchInput] = useState(keyword);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [directMemory, setDirectMemory] = useState<Memory | null>(null);
  const [viewerMissing, setViewerMissing] = useState(false);
  const [counts, setCounts] = useState({ photo: 0, video: 0 });
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasRestoredScroll = useRef(false);
  const requestPage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const activeKind = kind === "photo" || kind === "video" ? kind : undefined;
  const activeSort = ["captured_desc", "captured_asc", "updated_desc"].includes(sort)
    ? sort
    : "captured_desc";

  const updateParams = (next: URLSearchParams) => {
    const query = next.toString();
    setSearchParams(query ? `?${query}` : "");
  };

  const loadMemories = useCallback(async (activePage: number) => {
    setIsLoading(true);
    try {
      const data = await getMemories({
        kind: activeKind,
        keyword: keyword || undefined,
        page: activePage,
        page_size: PAGE_SIZE,
        sort: activeSort,
      });
      setMemories(data.items);
      setTotal(data.total);
      setCounts(data.counts ?? { photo: 0, video: 0 });
      setError(null);
      setViewerMissing(false);
    } catch {
      setError(brand.copy.loadFailed);
    } finally {
      setIsLoading(false);
    }
  }, [activeKind, activeSort, keyword]);

  useEffect(() => {
    let active = true;
    void loadMemories(requestPage).then(() => {
      if (!active) {
        return;
      }
    });

    return () => {
      active = false;
    };
  }, [loadMemories, page]);

  useEffect(() => {
    if (!viewerId || memories.some((memory) => memory.id === viewerId)) {
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
  }, [memories, viewerId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (searchInput.trim() === keyword) {
        return;
      }

      const next = new URLSearchParams(searchParams);
      if (searchInput.trim()) {
        next.set("keyword", searchInput.trim());
      } else {
        next.delete("keyword");
      }
      next.delete("page");
      updateParams(next);
    }, 300);

    return () => window.clearTimeout(timer);
  }, [keyword, searchInput, searchParams]);

  useEffect(() => {
    const saveScroll = () => {
      window.sessionStorage.setItem(SCROLL_STORAGE_KEY, String(window.scrollY));
    };

    window.addEventListener("scroll", saveScroll, { passive: true });
    return () => window.removeEventListener("scroll", saveScroll);
  }, []);

  useEffect(() => {
    if (isLoading || hasRestoredScroll.current) {
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
  }, [isLoading, pathname]);

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

  useEffect(() => {
    setSearchInput(keyword);
  }, [keyword]);

  const updateSearch = (value: string) => {
    const next = new URLSearchParams(searchParams);

    if (value.trim()) {
      next.set("keyword", value.trim());
    } else {
      next.delete("keyword");
    }
    next.delete("page");
    updateParams(next);
  };

  const clearSearch = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("keyword");
    next.delete("page");
    setSearchInput("");
    updateParams(next);
  };

  const changePage = (nextPage: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(nextPage));
    updateParams(next);
  };

  const changeKind = (nextKind: "photo" | "video" | undefined) => {
    const next = new URLSearchParams(searchParams);
    if (nextKind) {
      next.set("kind", nextKind);
    } else {
      next.delete("kind");
    }
    next.delete("page");
    updateParams(next);
  };

  const changeSort = (nextSort: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("sort", nextSort);
    next.delete("page");
    updateParams(next);
  };

  const openViewer = (memoryId: string) => {
    const next = new URLSearchParams(searchParams);
    scrollBeforeViewer = window.scrollY;
    next.set("viewer", memoryId);
    updateParams(next);
  };

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

  const activeMemory = memories.find((memory) => memory.id === viewerId) ?? directMemory;

  return (
    <section aria-labelledby="library-title">
      <h1 className="page-title text-3xl font-semibold" id="library-title">
        {brand.copy.libraryTitle}
      </h1>
      <p className="mt-2 text-center text-sm text-muted">{brand.copy.libraryDescription}</p>

      <div className="filter-toolbar mx-auto mt-6 w-full max-w-6xl">
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

        <form className="search-cluster" onSubmit={(event) => {
          event.preventDefault();
          updateSearch(searchInput);
        }}>
          <div className="relative w-full min-w-56">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input
              aria-label={brand.copy.searchLabel}
              className="input pl-10"
              id="library-search"
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={brand.copy.searchPlaceholder}
              type="search"
              value={searchInput}
            />
          </div>
          {keyword ? (
            <Button aria-label={brand.copy.clearSearch} onClick={clearSearch} variant="secondary">
              <X aria-hidden="true" className="size-4" />
            </Button>
          ) : null}
        </form>

        <label className="sort-cluster">
          <select
            aria-label={brand.copy.sortLabel}
            className="input"
            onChange={(event) => changeSort(event.target.value)}
            value={activeSort}
          >
            <option value="captured_desc">{brand.copy.sortCapturedDesc}</option>
            <option value="captured_asc">{brand.copy.sortCapturedAsc}</option>
            <option value="updated_desc">{brand.copy.sortUpdatedDesc}</option>
          </select>
        </label>
      </div>

      <p aria-live="polite" className="result-meta mx-auto mt-3 w-full max-w-6xl">
        {brand.copy.resultSummary.replace("{total}", String(total))}
        {keyword ? ` · ${brand.copy.activeKeyword} ${keyword}` : ""}
      </p>

      {isLoading ? (
        <>
          <span className="sr-only">{brand.copy.loadingLibrary}</span>
          <MediaSkeleton />
        </>
      ) : error ? (
        <Notice className="mt-8" tone="error">
          <span>{error}</span>
          <Button className="ml-2" onClick={() => void loadMemories(page)} variant="secondary">
            {brand.copy.loadFailedAction}
          </Button>
        </Notice>
      ) : memories.length === 0 ? (
        <div className="mt-8">
          <EmptyState art={Images}>
            {keyword ? brand.copy.emptySearch : brand.copy.emptyLibrary}
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="masonry">
            {memories.map((memory, index) => (
              <MemoryCard
                key={memory.id}
                memory={memory}
                onOpen={openViewer}
                priority={index === 0}
              />
            ))}
          </div>
          <Pagination onPageChange={changePage} page={page} pageSize={PAGE_SIZE} total={total} />
        </>
      )}
      {viewerMissing ? (
        <Notice className="mt-8" tone="error">
          {brand.copy.notFoundText}
        </Notice>
      ) : null}
      {activeMemory ? (
        <MediaViewer memory={activeMemory} onClose={closeViewer} />
      ) : null}
    </section>
  );
}
