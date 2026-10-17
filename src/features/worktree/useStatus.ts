import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { getStatus, onRepoChanged, toAppError } from "../../lib/ipc";
import type { AppError, RepoId, WorkingTreeStatus } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseStatus {
  status: WorkingTreeStatus | undefined;
  isLoading: boolean;
  error: AppError | null;
  refetch(): void;
}

export function useStatus(repoId: RepoId): UseStatus {
  const queryClient = useQueryClient();
  const query = useQuery<WorkingTreeStatus, AppError>({
    queryKey: queryKeys.status(repoId),
    queryFn: () =>
      getStatus(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    let active = true;
    // A failed subscribe must not become an unhandled rejection; the query still works.
    const sub = onRepoChanged(repoId, () => {
      if (active) void queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) });
    }).catch(() => undefined);
    return () => {
      active = false;
      // Also releases a subscription that resolves after unmount.
      void sub.then((unlisten) => unlisten?.());
    };
  }, [repoId, queryClient]);

  return {
    status: query.data,
    isLoading: query.isPending,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
