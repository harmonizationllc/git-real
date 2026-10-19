import { useMutation, useQueryClient } from "@tanstack/react-query";
import { checkoutCommit, resetToCommit, toAppError } from "../../lib/ipc";
import type { AppError, RepoId, ResetMode } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export type CommitRequest =
  { action: "checkout"; oid: string } | { action: "reset"; oid: string; mode: ResetMode };

/** `run` never rejects: it resolves with the AppError or null, and `error` mirrors the last result. */
export interface UseCommitActions {
  run(req: CommitRequest): Promise<AppError | null>;
  pending: boolean;
  error: AppError | null;
  clearError(): void;
}

function execute(repoId: RepoId, req: CommitRequest): Promise<void> {
  return req.action === "checkout"
    ? checkoutCommit(repoId, req.oid)
    : resetToCommit(repoId, req.oid, req.mode);
}

export function useCommitActions(repoId: RepoId): UseCommitActions {
  const queryClient = useQueryClient();
  const mutation = useMutation<void, AppError, CommitRequest>({
    mutationFn: (req) =>
      execute(repoId, req).catch((e: unknown) => {
        throw toAppError(e);
      }),
    // Runs on failure too, since a failed checkout or reset may have partly applied.
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
