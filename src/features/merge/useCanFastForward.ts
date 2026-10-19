import { useQuery } from "@tanstack/react-query";
import { canFastForward, toAppError } from "../../lib/ipc";
import type { AppError, FastForwardCheck, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseCanFastForward {
  check: FastForwardCheck | undefined;
  isLoading: boolean;
}

/** Whether HEAD can fast-forward to `branch`; checked afresh on every mount, none for null. */
export function useCanFastForward(repoId: RepoId, branch: string | null): UseCanFastForward {
  const query = useQuery<FastForwardCheck, AppError>({
    queryKey: queryKeys.fastForward(repoId, branch ?? ""),
    // Runs only while enabled, so `branch` is a string here.
    queryFn: () =>
      canFastForward(repoId, branch as string).catch((e: unknown) => {
        throw toAppError(e);
      }),
    enabled: branch !== null,
    staleTime: 0,
    gcTime: 0,
  });

  // `isLoading`, not `isPending`: a disabled query stays pending forever.
  return { check: query.data, isLoading: query.isLoading };
}
