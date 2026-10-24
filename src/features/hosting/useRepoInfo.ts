import { useQuery } from "@tanstack/react-query";
import { hostingRepoInfo, toAppError } from "../../lib/ipc";
import type { AppError, HostedRepoInfo, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

/** The provider's answer changes rarely; five minutes spares repeat calls across dialogs. */
const STALE_MS = 5 * 60 * 1000;

export interface UseRepoInfo {
  info: HostedRepoInfo | undefined;
  error: AppError | null;
  refetch(): void;
}

/** The hosted repository's default branch and issue tracker state, asked only when enabled. */
export function useRepoInfo(repoId: RepoId, enabled: boolean): UseRepoInfo {
  const query = useQuery<HostedRepoInfo, AppError>({
    queryKey: queryKeys.hostingRepoInfo(repoId),
    queryFn: () =>
      hostingRepoInfo(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
    enabled,
    refetchOnWindowFocus: false,
    staleTime: STALE_MS,
  });

  return {
    info: query.data,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
