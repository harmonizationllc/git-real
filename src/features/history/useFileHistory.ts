import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { getFileHistory, toAppError } from "../../lib/ipc";
import type { AppError, FileHistoryEntry, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseFileHistory {
  entries: FileHistoryEntry[] | undefined;
  isLoading: boolean;
  error: AppError | null;
  refetch(): void;
}

/**
 * The commits that touched `path` under log `generation`; disabled until the generation is known.
 * A `logStale` rejection (the backend rebuilt its cache) invalidates the summary once per
 * generation, reads as loading and is never shown as an error, as in `useLogPages`.
 */
export function useFileHistory(
  repoId: RepoId,
  generation: number | undefined,
  path: string,
): UseFileHistory {
  const queryClient = useQueryClient();
  const query = useQuery<FileHistoryEntry[], AppError>({
    queryKey: queryKeys.fileHistory(repoId, generation ?? -1, path),
    queryFn: () =>
      getFileHistory(repoId, generation as number, path).catch((e: unknown) => {
        throw toAppError(e);
      }),
    enabled: generation !== undefined,
    staleTime: Infinity,
  });

  const handled = useRef<number | null>(null);
  const stale = query.error?.kind === "logStale";
  useEffect(() => {
    if (!stale || handled.current === generation) return;
    handled.current = generation as number;
    void queryClient.invalidateQueries({ queryKey: queryKeys.log(repoId) });
  }, [stale, generation, repoId, queryClient]);

  return {
    entries: query.data,
    // Stale reads as loading until the new generation arrives.
    isLoading: query.isPending || stale,
    error: stale ? null : (query.error ?? null),
    refetch: () => void query.refetch(),
  };
}
