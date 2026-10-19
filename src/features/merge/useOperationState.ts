import { useQuery } from "@tanstack/react-query";
import { getOperationState, toAppError } from "../../lib/ipc";
import type { AppError, OperationState, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseOperationState {
  state: OperationState | undefined;
  error: AppError | null;
  refetch(): void;
}

/** The repository's in-progress operation; `repo-changed` and window focus keep it fresh. */
export function useOperationState(repoId: RepoId): UseOperationState {
  const query = useQuery<OperationState, AppError>({
    queryKey: queryKeys.operation(repoId),
    queryFn: () =>
      getOperationState(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
    refetchOnWindowFocus: true,
  });

  return {
    state: query.data,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
