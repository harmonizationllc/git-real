import { useQuery } from "@tanstack/react-query";
import { getStashFiles, toAppError } from "../../lib/ipc";
import type { AppError, RepoId, StashFiles } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseStashFiles {
  files: StashFiles | undefined;
  error: AppError | null;
  refetch(): void;
}

/** A stash's tracked and untracked files; a stash commit never changes, so never stale. */
export function useStashFiles(repoId: RepoId, oid: string | null): UseStashFiles {
  const query = useQuery<StashFiles, AppError>({
    queryKey: queryKeys.stashFiles(repoId, oid ?? ""),
    queryFn: () =>
      getStashFiles(repoId, oid as string).catch((e: unknown) => {
        throw toAppError(e);
      }),
    enabled: oid !== null,
    staleTime: Infinity,
  });

  return {
    files: query.data,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
