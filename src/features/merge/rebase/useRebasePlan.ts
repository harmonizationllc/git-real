import { useQuery } from "@tanstack/react-query";
import { rebasePlan, toAppError } from "../../../lib/ipc";
import type { AppError, RebaseCommit, RepoId } from "../../../lib/ipc";
import { queryKeys } from "../../../lib/query/keys";

export interface UseRebasePlan {
  commits: RebaseCommit[] | undefined;
  error: AppError | null;
  loading: boolean;
}

/** The commits `git rebase -i base` would replay, in git's order; refetched with the repo, never retried. */
export function useRebasePlan(repoId: RepoId, base: string): UseRebasePlan {
  const query = useQuery<RebaseCommit[], AppError>({
    queryKey: queryKeys.rebasePlan(repoId, base),
    queryFn: () =>
      rebasePlan(repoId, base).catch((e: unknown) => {
        throw toAppError(e);
      }),
    retry: false,
  });
  return { commits: query.data, error: query.error, loading: query.isPending };
}
