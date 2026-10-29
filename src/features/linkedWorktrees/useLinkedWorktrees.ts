import { useQuery } from "@tanstack/react-query";
import { listLinkedWorktrees, toAppError } from "../../lib/ipc";
import type { AppError, LinkedWorktree, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseLinkedWorktrees {
  /** Empty for a bare session; a non-bare repository always has at least one row. */
  list: LinkedWorktree[] | undefined;
  error: AppError | null;
  refetch(): void;
}

/** Every worktree of the repository; `repo-changed` and window focus keep it fresh. */
export function useLinkedWorktrees(repoId: RepoId): UseLinkedWorktrees {
  const query = useQuery<LinkedWorktree[], AppError>({
    queryKey: queryKeys.linkedWorktrees(repoId),
    queryFn: () =>
      listLinkedWorktrees(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
    refetchOnWindowFocus: true,
  });

  return {
    list: query.data,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
