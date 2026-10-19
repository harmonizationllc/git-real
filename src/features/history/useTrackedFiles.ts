import { useQuery } from "@tanstack/react-query";
import { listTrackedFiles, toAppError } from "../../lib/ipc";
import type { AppError, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseTrackedFiles {
  files: string[] | undefined;
  isLoading: boolean;
  error: AppError | null;
  refetch(): void;
}

/** The repo's tracked paths, fetched fresh each time the picker opens and dropped when it closes. */
export function useTrackedFiles(repoId: RepoId, open: boolean): UseTrackedFiles {
  const query = useQuery<string[], AppError>({
    queryKey: queryKeys.trackedFiles(repoId),
    queryFn: () =>
      listTrackedFiles(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
    enabled: open,
    gcTime: 0,
    staleTime: 0,
  });

  return {
    files: query.data,
    isLoading: query.isPending,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
