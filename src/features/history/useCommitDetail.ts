import { useQuery } from "@tanstack/react-query";
import { getCommit, toAppError } from "../../lib/ipc";
import type { AppError, CommitDetail, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseCommitDetail {
  commit: CommitDetail | undefined;
  isLoading: boolean;
  error: AppError | null;
  refetch(): void;
}

/** One commit's metadata; immutable once fetched, so it is never stale. */
export function useCommitDetail(repoId: RepoId, oid: string): UseCommitDetail {
  const query = useQuery<CommitDetail, AppError>({
    queryKey: queryKeys.commit(repoId, oid),
    queryFn: () =>
      getCommit(repoId, oid).catch((e: unknown) => {
        throw toAppError(e);
      }),
    staleTime: Infinity,
  });

  return {
    commit: query.data,
    isLoading: query.isPending,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
