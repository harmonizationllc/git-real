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

/** How often the summary is re-read while the graph is incomplete or refreshing. */
export const SUMMARY_POLL_MS = 500;

/**
 * The log's generation, row count, lane width and build state; refreshed with every repo
 * invalidation, and polled while the graph is still being built or rebuilt.
 */
export function useLogSummary(repoId: RepoId): UseLogSummary {
  const query = useQuery<LogSummary, AppError>({
    queryKey: queryKeys.log(repoId),
    queryFn: () =>
      getLogSummary(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
    refetchInterval: (q) => {
      // A failed poll keeps the last data, so polling on would restart a failing build
      // twice a second; Retry starts one build instead.
      if (q.state.status === "error") return false;
      const s = q.state.data;
      return s !== undefined && (!s.complete || s.refreshing) ? SUMMARY_POLL_MS : false;
    },
  });

  return {
    summary: query.data,
    isLoading: query.isPending,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
