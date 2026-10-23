import { useInfiniteQuery } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { hostingListPullRequests, toAppError } from "../../lib/ipc";
import type { AppError, PullRequest, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

/** The provider's page size: a full page means there may be more. */
const PAGE_SIZE = 50;

export interface UsePullRequests {
  pullRequests: PullRequest[] | undefined;
  error: AppError | null;
  hasMore: boolean;
  fetching: boolean;
  loadingMore: boolean;
  refetch(): void;
  loadMore(): void;
}

/**
 * The repository's open pull requests, a page at a time. Keyed outside the repo prefix and never
 * refetched on focus, so only showing the section, Refresh, Show more and a network action cost
 * an API call.
 */
export function usePullRequests(repoId: RepoId, enabled: boolean): UsePullRequests {
  const query = useInfiniteQuery<
    PullRequest[],
    AppError,
    InfiniteData<PullRequest[], number>,
    ReturnType<typeof queryKeys.pullRequests>,
    number
  >({
    queryKey: queryKeys.pullRequests(repoId),
    queryFn: ({ pageParam }) =>
      hostingListPullRequests(repoId, pageParam).catch((e: unknown) => {
        throw toAppError(e);
      }),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.length === PAGE_SIZE ? all.length + 1 : undefined),
    enabled,
    refetchOnWindowFocus: false,
  });

  return {
    pullRequests: query.data?.pages.flat(),
    error: query.error ?? null,
    hasMore: query.hasNextPage,
    fetching: query.isFetching,
    loadingMore: query.isFetchingNextPage,
    refetch: () => void query.refetch(),
    loadMore: () => void query.fetchNextPage(),
  };
}
