import { useQuery } from "@tanstack/react-query";
import { listBranches, toAppError } from "../../lib/ipc";
import type { AppError, BranchList, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseBranches {
  branches: BranchList | undefined;
  isLoading: boolean;
  error: AppError | null;
  refetch(): void;
}

export function useBranches(repoId: RepoId): UseBranches {
  const query = useQuery<BranchList, AppError>({
    queryKey: queryKeys.branches(repoId),
    queryFn: () =>
      listBranches(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
    refetchOnWindowFocus: true,
  });

  return {
    branches: query.data,
    isLoading: query.isPending,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
