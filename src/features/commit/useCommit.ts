import { useMutation, useQueryClient } from "@tanstack/react-query";
import { commit as commitCommand, toAppError } from "../../lib/ipc";
import type { AppError, CommitMessage, CommitOutcome, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { useCommitDraft } from "../../lib/store/commitDraft";

export interface UseCommit {
  /** Fire-and-forget: failures surface through `error`, never as rejections. */
  commit(message: CommitMessage, amend: boolean): void;
  pending: boolean;
  error: AppError | null;
  clearError(): void;
}

interface CommitVars {
  message: CommitMessage;
  amend: boolean;
}

export function useCommit(repoId: RepoId): UseCommit {
  const queryClient = useQueryClient();
  // Callbacks live on the hook, not on mutate(), so they still run if the box unmounts mid-commit.
  const mutation = useMutation<CommitOutcome, AppError, CommitVars>({
    mutationFn: ({ message, amend }) =>
      commitCommand(repoId, message, amend).catch((e: unknown) => {
        throw toAppError(e);
      }),
    onSuccess: () => useCommitDraft.getState().clear(repoId),
    // Runs on failure too: a hook may have changed files before refusing.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) }),
  });
  const { mutate, reset } = mutation;
  return {
    commit: (message, amend) => mutate({ message, amend }),
    pending: mutation.isPending,
    error: mutation.error,
    clearError: reset,
  };
}
