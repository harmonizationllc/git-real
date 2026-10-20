import { useQuery } from "@tanstack/react-query";
import { listStashes, toAppError } from "../../lib/ipc";
import type { AppError, RepoId, StashEntry } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseStashes {
  stashes: StashEntry[] | undefined;
  error: AppError | null;
  refetch(): void;
}

/** The repository's stashes, newest first; `repo-changed` and window focus keep it fresh. */
export function useStashes(repoId: RepoId): UseStashes {
  const query = useQuery<StashEntry[], AppError>({
    queryKey: queryKeys.stashes(repoId),
    queryFn: () =>
      listStashes(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
    refetchOnWindowFocus: true,
  });

  return {
    stashes: query.data,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
