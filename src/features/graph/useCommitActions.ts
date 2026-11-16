import { useMutation, useQueryClient } from "@tanstack/react-query";
import { checkoutCommit, resetToCommit, toAppError } from "../../lib/ipc";
import type { AppError, AutoStash, RepoId, ResetMode } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { useAutoFetchState } from "../../lib/store/autoFetch";
import { toastAutoStash } from "../checkout/autoStashToast";

export type CommitRequest =
  { action: "checkout"; oid: string } | { action: "reset"; oid: string; mode: ResetMode };

/** `run` never rejects: it resolves with the AppError or null, and `error` mirrors the last result. */
export interface UseCommitActions {
  run(req: CommitRequest): Promise<AppError | null>;
  pending: boolean;
  error: AppError | null;
  clearError(): void;
}

/** What a checkout leaves to report; null for a reset. */
interface CheckoutReport {
  autoStash: AutoStash | null;
  target: string;
}

async function execute(repoId: RepoId, req: CommitRequest): Promise<CheckoutReport | null> {
  if (req.action === "reset") {
    await resetToCommit(repoId, req.oid, req.mode);
    return null;
  }
  const outcome = await checkoutCommit(repoId, req.oid);
  return { autoStash: outcome.autoStash, target: req.oid.slice(0, 7) };
}

export function useCommitActions(repoId: RepoId): UseCommitActions {
  const queryClient = useQueryClient();
  const mutation = useMutation<CheckoutReport | null, AppError, CommitRequest>({
    mutationFn: (req) =>
      execute(repoId, req).catch((e: unknown) => {
        throw toAppError(e);
      }),
    // A detached HEAD may be behind its remote, so the focused pane is asked to fetch.
    onSuccess: (data) => {
      if (data === null) return;
      useAutoFetchState.getState().request(repoId);
      toastAutoStash(data.autoStash, data.target);
    },
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
