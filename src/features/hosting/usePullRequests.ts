import { hostingListPullRequests } from "../../lib/ipc";
import type { AppError, PullRequest, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { usePagedQuery } from "./usePagedQuery";

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
  const { items, ...rest } = usePagedQuery(
    queryKeys.pullRequests(repoId),
    (page) => hostingListPullRequests(repoId, page),
    enabled,
    (i) => i.number,
  );
  return { pullRequests: items, ...rest };
}
