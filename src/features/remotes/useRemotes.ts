import { useQuery } from "@tanstack/react-query";
import { listRemotes, toAppError } from "../../lib/ipc";
import type { AppError, RemoteInfo, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseRemotes {
  remotes: RemoteInfo[] | undefined;
  error: AppError | null;
  refetch(): void;
}

export function useRemotes(repoId: RepoId): UseRemotes {
  const query = useQuery<RemoteInfo[], AppError>({
    queryKey: queryKeys.remotes(repoId),
    queryFn: () =>
      listRemotes(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
  });

  return {
    remotes: query.data,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
