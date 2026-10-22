import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  checkoutBranch,
  checkoutRemoteBranch,
  createBranch,
  deleteBranch,
  renameBranch,
  toAppError,
} from "../../lib/ipc";
import type { AppError, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export type BranchRequest =
  | { action: "create"; name: string; startPoint: string | null; checkout: boolean }
  | { action: "rename"; oldName: string; newName: string }
  | { action: "delete"; name: string; force: boolean }
  | { action: "checkout"; name: string }
  | { action: "checkoutRemote"; remote: string; name: string };

/** `run` never rejects: it resolves with the AppError or null, and `error` mirrors the last result. */
export interface UseBranchActions {
  run(req: BranchRequest): Promise<AppError | null>;
  pending: boolean;
  error: AppError | null;
  clearError(): void;
}

function execute(repoId: RepoId, req: BranchRequest): Promise<unknown> {
  switch (req.action) {
    case "create":
      return createBranch(repoId, req.name, req.startPoint, req.checkout);
    case "rename":
      return renameBranch(repoId, req.oldName, req.newName);
    case "delete":
      return deleteBranch(repoId, req.name, req.force);
    case "checkout":
      return checkoutBranch(repoId, req.name);
    case "checkoutRemote":
      return checkoutRemoteBranch(repoId, req.remote, req.name);
  }
}

export function useBranchActions(repoId: RepoId): UseBranchActions {
  const queryClient = useQueryClient();
  const mutation = useMutation<unknown, AppError, BranchRequest>({
    mutationFn: (req) =>
      execute(repoId, req).catch((e: unknown) => {
        throw toAppError(e);
      }),
    // Returning the promise keeps `pending` true until the refetch is triggered. Runs on
    // failure too, since a failed switch or create may have partly applied.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) }),
  });
  const { mutateAsync } = mutation;

  return {
    run: (req) =>
      mutateAsync(req).then(
        () => null,
        (e: AppError) => e,
      ),
    pending: mutation.isPending,
    error: mutation.error,
    clearError: mutation.reset,
  };
}
