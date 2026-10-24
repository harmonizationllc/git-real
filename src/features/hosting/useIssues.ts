import { hostingListIssues } from "../../lib/ipc";
import type { AppError, Issue, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { usePagedQuery } from "./usePagedQuery";

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
  const { items, ...rest } = usePagedQuery(
    queryKeys.issues(repoId, query),
    (page) => hostingListIssues(repoId, query, page),
    enabled,
    (i) => i.number,
  );
  return { issues: items, ...rest };
}
