import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  abortOperation,
  cherryPick,
  continueRebase,
  mergeBranch,
  rebaseInteractive,
  rebaseOnto,
  resolveConflicts,
  revertCommit,
  toAppError,
} from "../../lib/ipc";
import type { AppError, ConflictSide, RebaseStep, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export type IntegrationRequest =
  | { action: "merge"; branch: string }
  | { action: "fastForward"; branch: string }
  | { action: "rebase"; onto: string }
  | { action: "rebaseInteractive"; base: string; steps: RebaseStep[] }
  | { action: "cherryPick"; oid: string }
  | { action: "revert"; oid: string }
  | { action: "abort" }
  | { action: "continue" }
  | { action: "resolve"; paths: string[]; side: ConflictSide };

/** `run` never rejects: it resolves with the AppError or null, and `error` mirrors the last result. */
export interface UseIntegrationActions {
  run(req: IntegrationRequest): Promise<AppError | null>;
  pending: boolean;
  error: AppError | null;
  clearError(): void;
}

function execute(repoId: RepoId, req: IntegrationRequest): Promise<unknown> {
  switch (req.action) {
    case "merge":
      return mergeBranch(repoId, req.branch, "merge");
    case "fastForward":
      return mergeBranch(repoId, req.branch, "fastForward");
    case "rebase":
      return rebaseOnto(repoId, req.onto);
    case "rebaseInteractive":
      return rebaseInteractive(repoId, req.base, req.steps);
    case "cherryPick":
      return cherryPick(repoId, req.oid);
    case "revert":
      return revertCommit(repoId, req.oid);
    case "abort":
      return abortOperation(repoId);
    case "continue":
      return continueRebase(repoId);
    case "resolve":
      return resolveConflicts(repoId, req.paths, req.side);
  }
}

export function useIntegrationActions(repoId: RepoId): UseIntegrationActions {
  const queryClient = useQueryClient();
  const mutation = useMutation<unknown, AppError, IntegrationRequest>({
    mutationFn: (req) =>
      execute(repoId, req).catch((e: unknown) => {
        throw toAppError(e);
      }),
    // Returning the promise keeps `pending` true until the refetch is triggered. Runs on
    // failure too, since a failed operation may have partly applied. A "conflicts" outcome
    // resolves like success: the refetched status and operation state carry the conflicts.
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
