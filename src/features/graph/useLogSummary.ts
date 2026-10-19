import { useQuery } from "@tanstack/react-query";
import { getLogSummary, toAppError } from "../../lib/ipc";
import type { AppError, LogSummary, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseLogSummary {
  summary: LogSummary | undefined;
  isLoading: boolean;
  error: AppError | null;
  refetch(): void;
}

/** The log's generation, row count and lane width; refreshed with every repo invalidation. */
export function useLogSummary(repoId: RepoId): UseLogSummary {
  const query = useQuery<LogSummary, AppError>({
    queryKey: queryKeys.log(repoId),
    queryFn: () =>
      getLogSummary(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
  });

  return {
    summary: query.data,
    isLoading: query.isPending,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
