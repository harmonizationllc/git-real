import { hostingListMyRepos } from "../../lib/ipc";
import type { AppError, HostedRepo } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { usePagedQuery } from "./usePagedQuery";

export interface UseMyRepos {
  repos: HostedRepo[] | undefined;
  error: AppError | null;
  hasMore: boolean;
  fetching: boolean;
  loadingMore: boolean;
  refetch(): void;
  loadMore(): void;
}

/**
 * The account's repositories matching `query`, a page at a time, each full name once. Nothing is
 * requested without an account; never refetched on focus.
 */
export function useMyRepos(accountId: string | null, query: string, enabled: boolean): UseMyRepos {
  const { items, ...rest } = usePagedQuery(
    queryKeys.myRepos(accountId ?? "", query),
    (page) => hostingListMyRepos(accountId as string, query, page),
    enabled && accountId !== null,
    (r) => r.fullName,
  );
  return { repos: items, ...rest };
}
