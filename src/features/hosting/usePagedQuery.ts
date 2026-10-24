import { useInfiniteQuery } from "@tanstack/react-query";
import type { InfiniteData, QueryKey } from "@tanstack/react-query";
import { toAppError } from "../../lib/ipc";
import type { AppError } from "../../lib/ipc";

/** The provider's page size: a full page means there may be more. */
const PAGE_SIZE = 50;

export interface PagedQuery<T> {
  /** Every loaded page in order, each key once (its first occurrence). */
  items: T[] | undefined;
  error: AppError | null;
  hasMore: boolean;
  fetching: boolean;
  loadingMore: boolean;
  refetch(): void;
  loadMore(): void;
}

/**
 * Pages of provider items, from page 1, never refetched on focus. A full raw page means there may
 * be more. Items that moved between pages while paging appear once, identified by `keyOf`.
 */
export function usePagedQuery<T>(
  queryKey: QueryKey,
  fetchPage: (page: number) => Promise<T[]>,
  enabled: boolean,
  keyOf: (item: T) => string | number,
): PagedQuery<T> {
  const query = useInfiniteQuery<T[], AppError, InfiniteData<T[], number>, QueryKey, number>({
    queryKey,
    queryFn: ({ pageParam }) =>
      fetchPage(pageParam).catch((e: unknown) => {
        throw toAppError(e);
      }),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.length === PAGE_SIZE ? all.length + 1 : undefined),
    enabled,
    refetchOnWindowFocus: false,
  });

  return {
    items: query.data && dedupe(query.data.pages.flat(), keyOf),
    error: query.error ?? null,
    hasMore: query.hasNextPage,
    fetching: query.isFetching,
    loadingMore: query.isFetchingNextPage,
    refetch: () => void query.refetch(),
    loadMore: () => void query.fetchNextPage(),
  };
}

/** The first item per key, in order. */
function dedupe<T>(items: T[], keyOf: (item: T) => string | number): T[] {
  const seen = new Set<string | number>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
