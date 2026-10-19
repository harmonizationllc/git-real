import { useQuery } from "@tanstack/react-query";
import { getBlame, toAppError } from "../../lib/ipc";
import type { AppError, Blame, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseBlame {
  blame: Blame | undefined;
  isLoading: boolean;
  error: AppError | null;
  refetch(): void;
}

/**
 * `path` blamed at commit `oid`, which never changes, or at HEAD when `oid` is null, which
 * refreshes with every repo invalidation.
 */
export function useBlame(repoId: RepoId, path: string, oid: string | null): UseBlame {
  const query = useQuery<Blame, AppError>({
    queryKey:
      oid === null ? queryKeys.blameHead(repoId, path) : queryKeys.blameAt(repoId, path, oid),
    queryFn: () =>
      getBlame(repoId, path, oid).catch((e: unknown) => {
        throw toAppError(e);
      }),
    staleTime: oid === null ? undefined : Infinity,
  });

  return {
    blame: query.data,
    isLoading: query.isPending,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
