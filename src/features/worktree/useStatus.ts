import { useQuery } from "@tanstack/react-query";
import { getStatus, toAppError } from "../../lib/ipc";
import type { AppError, RepoId, WorkingTreeStatus } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseStatus {
  status: WorkingTreeStatus | undefined;
  isLoading: boolean;
  error: AppError | null;
  refetch(): void;
}

export interface UseStatusOptions {
  /** False for a reader that mounts once its host has loaded the status, so it adds no fetch. */
  refetchOnMount?: boolean;
}

export function useStatus(repoId: RepoId, options: UseStatusOptions = {}): UseStatus {
  const query = useQuery<WorkingTreeStatus, AppError>({
    queryKey: queryKeys.status(repoId),
    queryFn: () =>
      getStatus(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
    refetchOnWindowFocus: true,
    refetchOnMount: options.refetchOnMount ?? true,
  });

  return {
    status: query.data,
    isLoading: query.isPending,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
