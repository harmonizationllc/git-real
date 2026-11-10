import { useMutation, useQueryClient } from "@tanstack/react-query";
import { resolveConflicts, stagePaths, toAppError } from "../../../lib/ipc";
import type { AppError, ConflictKind, RepoId } from "../../../lib/ipc";
import { queryKeys } from "../../../lib/query/keys";

/** Both actions never reject: they resolve with the AppError or null, and `error` mirrors the last. */
export interface UseOneSidedResolution {
  /** Stages the surviving file as it is in the working tree. */
  keepFile(): Promise<AppError | null>;
  /** Takes the deleting side, so the deletion is staged. */
  deleteFile(): Promise<AppError | null>;
  pending: boolean;
  error: AppError | null;
  clearError(): void;
}

type Action = "keep" | "delete";

/** Resolves a modify/delete conflict on `path` by keeping or deleting the file. */
export function useOneSidedResolution(
  repoId: RepoId,
  path: string,
  kind: ConflictKind,
): UseOneSidedResolution {
  const queryClient = useQueryClient();
  const deleter = kind === "deletedByUs" ? "ours" : "theirs";
  const mutation = useMutation<unknown, AppError, Action>({
    mutationFn: (action) =>
      (action === "keep"
        ? stagePaths(repoId, [path])
        : resolveConflicts(repoId, [path], deleter)
      ).catch((e: unknown) => {
        throw toAppError(e);
      }),
    // A failed action may still have touched the index, so the repo refetches either way.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) }),
  });
  const { mutateAsync } = mutation;
  const run = (action: Action) =>
    mutateAsync(action).then(
      () => null,
      (e: AppError) => e,
    );

  return {
    keepFile: () => run("keep"),
    deleteFile: () => run("delete"),
    pending: mutation.isPending,
    error: mutation.error,
    clearError: mutation.reset,
  };
}
