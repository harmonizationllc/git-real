import { useInfiniteQuery } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { hostingListIssues, toAppError } from "../../lib/ipc";
import type { AppError, Issue, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

/** The provider's page size: a full page means there may be more. */
const PAGE_SIZE = 50;

export interface UseIssues {
  issues: Issue[] | undefined;
  error: AppError | null;
  hasMore: boolean;
  fetching: boolean;
  loadingMore: boolean;
  refetch(): void;
  loadMore(): void;
}

/**
 * The repository's open issues matching `query`, a page at a time. Keyed outside the repo prefix
 * and never refetched on focus, so only showing the section, a search, Refresh and Show more cost
 * an API call.
 */
export function useIssues(repoId: RepoId, query: string, enabled: boolean): UseIssues {
  const result = useInfiniteQuery<
    Issue[],
    AppError,
    InfiniteData<Issue[], number>,
    ReturnType<typeof queryKeys.issues>,
    number
  >({
    queryKey: queryKeys.issues(repoId, query),
    queryFn: ({ pageParam }) =>
      hostingListIssues(repoId, query, pageParam).catch((e: unknown) => {
        throw toAppError(e);
      }),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.length === PAGE_SIZE ? all.length + 1 : undefined),
    enabled,
    refetchOnWindowFocus: false,
  });

  return {
    issues: result.data?.pages.flat(),
    error: result.error ?? null,
    hasMore: result.hasNextPage,
    fetching: result.isFetching,
    loadingMore: result.isFetchingNextPage,
    refetch: () => void result.refetch(),
    loadMore: () => void result.fetchNextPage(),
  };
}
