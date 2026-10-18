import { useQuery } from "@tanstack/react-query";
import { getCommitConfig, toAppError } from "../../lib/ipc";
import type { AppError, CommitConfig, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseCommitConfig {
  config: CommitConfig | undefined;
  error: AppError | null;
  refetch(): void;
}

/** Author identity and signing from Git config; refetches on focus to catch ~/.gitconfig edits. */
export function useCommitConfig(repoId: RepoId): UseCommitConfig {
  const query = useQuery<CommitConfig, AppError>({
    queryKey: queryKeys.commitConfig(repoId),
    queryFn: () =>
      getCommitConfig(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
    refetchOnWindowFocus: true,
  });
  return {
    config: query.data,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
