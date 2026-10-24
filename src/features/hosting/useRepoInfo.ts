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

/**
 * Whether the issues may be asked for: the repository has them turned on, or its info failed
 * for a reason other than the token or the rate limit (which a listing would only repeat).
 */
export function issuesAllowed(info: HostedRepoInfo | undefined, error: AppError | null): boolean {
  if (info !== undefined) return info.issuesEnabled;
  return error !== null && error.kind !== "hostingAuth" && error.kind !== "hostingRateLimited";
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
