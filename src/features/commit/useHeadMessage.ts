import { useQuery } from "@tanstack/react-query";
import { getHeadMessage, toAppError } from "../../lib/ipc";
import type { AppError, CommitMessage, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseHeadMessage {
  /** undefined while loading; null when HEAD is unborn. */
  head: CommitMessage | null | undefined;
  error: AppError | null;
}

export function useHeadMessage(repoId: RepoId): UseHeadMessage {
  const query = useQuery<CommitMessage | null, AppError>({
    queryKey: queryKeys.headMessage(repoId),
    queryFn: () =>
      getHeadMessage(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
  });
  return { head: query.data, error: query.error ?? null };
}
