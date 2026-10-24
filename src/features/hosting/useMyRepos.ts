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
  // Without an account the query is disabled, so the empty id never reaches the provider.
  const id = accountId ?? "";
  const { items, ...rest } = usePagedQuery(
    queryKeys.myRepos(id, query),
    (page) => hostingListMyRepos(id, query, page),
    enabled && accountId !== null,
    (r) => r.fullName,
  );
  return { repos: items, ...rest };
}
