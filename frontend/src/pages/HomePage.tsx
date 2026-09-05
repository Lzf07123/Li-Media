import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Images, Search, X } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import MemoryCard from "@/components/MemoryCard";
import { brand } from "@/lib/brand";
import { getMemories, type Memory } from "@/lib/api";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import IconButton from "@/components/ui/IconButton";
import MediaSkeleton from "@/components/ui/MediaSkeleton";
import Notice from "@/components/ui/Notice";
import Pagination from "@/components/ui/Pagination";

const PAGE_SIZE = 24;

export default function HomePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const kind = searchParams.get("kind") ?? undefined;
  const keyword = searchParams.get("keyword") ?? "";
  const page = Number(searchParams.get("page") ?? "1");
  const [searchInput, setSearchInput] = useState(keyword);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const updateParams = (next: URLSearchParams) => {
    const query = next.toString();
    setSearchParams(query ? `?${query}` : "");
  };

  const loadMemories = useCallback(async (activePage: number) => {
    setIsLoading(true);
    try {
      const data = await getMemories({
        kind: kind === "photo" || kind === "video" ? kind : undefined,
        keyword: keyword || undefined,
        page: activePage,
        page_size: PAGE_SIZE,
      });
      setMemories(data.items);
      setTotal(data.total);
      setError(null);
    } catch {
      setError(brand.copy.loadFailed);
    } finally {
      setIsLoading(false);
    }
  }, [kind, keyword]);

  useEffect(() => {
    let active = true;
    const requestPage = Number.isFinite(page) && page > 0 ? page : 1;

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
    setSearchInput(keyword);
  }, [keyword]);

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = new URLSearchParams(searchParams);

    if (searchInput) {
      next.set("keyword", searchInput);
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

  return (
    <section aria-labelledby="library-title">
      <h1 className="page-title text-3xl font-semibold" id="library-title">
        {brand.copy.libraryTitle}
      </h1>
      <p className="mt-2 text-center text-sm text-muted">{brand.copy.libraryDescription}</p>

      <form className="list-filters mt-6" onSubmit={submitSearch}>
        <label className="sr-only" htmlFor="library-search">
          {brand.copy.searchLabel}
        </label>
        <div className="relative w-full sm:w-72">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            className="input pl-10"
            id="library-search"
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={brand.copy.searchPlaceholder}
            type="search"
            value={searchInput}
          />
        </div>
        {keyword ? (
          <Button onClick={clearSearch} variant="secondary">
            <X aria-hidden="true" className="size-4" />
            {brand.copy.clearSearch}
          </Button>
        ) : null}
        <Button type="submit">
          <Search aria-hidden="true" className="size-4" />
          {brand.copy.searchLabel}
        </Button>
      </form>

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
            {memories.map((memory) => (
              <MemoryCard key={memory.id} memory={memory} />
            ))}
          </div>
          <Pagination onPageChange={changePage} page={page} pageSize={PAGE_SIZE} total={total} />
        </>
      )}
    </section>
  );
}
