import { useQuery } from "@tanstack/react-query";
import { hostingRepoContext, toAppError } from "../../lib/ipc";
import type { AppError, RepoContext, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseRepoContext {
  /** null when origin is not on a supported host; undefined while loading. */
  context: RepoContext | null | undefined;
  error: AppError | null;
}

/** The hosted repository behind `origin` and its account; `repo-changed` keeps it fresh. */
export function useRepoContext(repoId: RepoId): UseRepoContext {
  const query = useQuery<RepoContext | null, AppError>({
    queryKey: queryKeys.hostingContext(repoId),
    queryFn: () =>
      hostingRepoContext(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
  });

  return { context: query.data, error: query.error ?? null };
}
