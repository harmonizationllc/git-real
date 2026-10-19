import { useQuery } from "@tanstack/react-query";
import { getCommitFiles, toAppError } from "../../lib/ipc";
import type { AppError, CommitFile, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseCommitFiles {
  files: CommitFile[] | undefined;
  isLoading: boolean;
  error: AppError | null;
  refetch(): void;
}

/** The files a commit changed against its first parent; immutable, so never stale. */
export function useCommitFiles(repoId: RepoId, oid: string): UseCommitFiles {
  const query = useQuery<CommitFile[], AppError>({
    queryKey: queryKeys.commitFiles(repoId, oid),
    queryFn: () =>
      getCommitFiles(repoId, oid).catch((e: unknown) => {
        throw toAppError(e);
      }),
    staleTime: Infinity,
  });

  return {
    files: query.data,
    isLoading: query.isPending,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
