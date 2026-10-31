import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { getFileHistory, toAppError } from "../../lib/ipc";
import type { AppError, FileHistoryEntry, FileHistoryPage, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

/** Entries asked for per getFileHistory call. */
export const FILE_HISTORY_PAGE = 100;

/** The panel keeps fetching pages until at least this many entries are loaded or none remain. */
export const FILE_HISTORY_MIN_LOADED = 100;

export interface UseFileHistory {
  entries: FileHistoryEntry[] | undefined;
  isLoading: boolean;
  error: AppError | null;
  refetch(): void;
  /** True while the last page returned a nextRow. */
  hasMore: boolean;
  isFetchingMore: boolean;
  /** Fetches the next page; a no-op while one is in flight or none remains. */
  fetchMore(): void;
}

/** Where a page's scan starts: a row and the name the scan follows there. */
interface Cursor {
  startRow: number;
  followPath: string | null;
}

/**
 * The commits that touched `path` under log `generation`, in pages behind a resumable cursor;
 * disabled until the generation is known and the graph is complete. A `logStale` rejection (the
 * backend rebuilt its cache) invalidates the summary once per generation, reads as loading and
 * is never shown as an error, as in `useLogPages`.
 */
export function useFileHistory(
  repoId: RepoId,
  generation: number | undefined,
  path: string,
  complete: boolean,
): UseFileHistory {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery<
    FileHistoryPage,
    AppError,
    InfiniteData<FileHistoryPage, Cursor>,
    ReturnType<typeof queryKeys.fileHistory>,
    Cursor
  >({
    queryKey: queryKeys.fileHistory(repoId, generation ?? -1, path),
    queryFn: ({ pageParam }) =>
      getFileHistory(
        repoId,
        generation as number,
        path,
        pageParam.startRow,
        FILE_HISTORY_PAGE,
        pageParam.followPath,
      ).catch((e: unknown) => {
        throw toAppError(e);
      }),
    initialPageParam: { startRow: 0, followPath: null as string | null },
    getNextPageParam: (last) =>
      last.nextRow === null ? undefined : { startRow: last.nextRow, followPath: last.followPath },
    enabled: generation !== undefined && complete,
    staleTime: Infinity,
  });

  const handled = useRef<number | null>(null);
  const stale = query.error?.kind === "logStale";
  useEffect(() => {
    if (!stale || handled.current === generation) return;
    handled.current = generation as number;
    void queryClient.invalidateQueries({ queryKey: queryKeys.log(repoId) });
  }, [stale, generation, repoId, queryClient]);

  const entries = useMemo(() => query.data?.pages.flatMap((p) => p.entries), [query.data]);
  const { fetchNextPage, hasNextPage } = query;
  // cancelRefetch false joins a page already in flight instead of restarting it.
  const fetchMore = useCallback(() => {
    if (hasNextPage) void fetchNextPage({ cancelRefetch: false });
  }, [fetchNextPage, hasNextPage]);

  return {
    entries,
    // Stale reads as loading until the new generation arrives.
    isLoading: query.isPending || stale,
    error: stale ? null : (query.error ?? null),
    refetch: () => void query.refetch(),
    hasMore: hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    fetchMore,
  };
}
