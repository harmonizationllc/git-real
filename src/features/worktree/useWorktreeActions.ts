import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  addToGitignore,
  applyHunk,
  discardPaths,
  stageAll,
  stagePaths,
  toAppError,
  unstageAll,
  unstagePaths,
} from "../../lib/ipc";
import type { AppError, HunkAction, HunkSelection, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

type WorktreeRequest =
  | { action: "stage"; paths: string[] }
  | { action: "unstage"; paths: string[] }
  | { action: "stageAll" }
  | { action: "unstageAll" }
  | { action: "discard"; paths: string[] }
  | { action: "addToGitignore"; path: string }
  | { action: "applyHunk"; path: string; hunkAction: HunkAction; selection: HunkSelection };

/** Actions are fire-and-forget: failures surface through `error`, never as rejections. */
export interface UseWorktreeActions {
  stage(paths: string[]): void;
  unstage(paths: string[]): void;
  stageAll(): void;
  unstageAll(): void;
  discard(paths: string[]): void;
  addToGitignore(path: string): void;
  applyHunk(path: string, action: HunkAction, selection: HunkSelection): void;
  pending: boolean;
  error: AppError | null;
  clearError(): void;
}

function execute(repoId: RepoId, req: WorktreeRequest): Promise<unknown> {
  switch (req.action) {
    case "stage":
      return stagePaths(repoId, req.paths);
    case "unstage":
      return unstagePaths(repoId, req.paths);
    case "stageAll":
      return stageAll(repoId);
    case "unstageAll":
      return unstageAll(repoId);
    case "discard":
      return discardPaths(repoId, req.paths);
    case "addToGitignore":
      return addToGitignore(repoId, req.path);
    case "applyHunk":
      return applyHunk(repoId, req.path, req.hunkAction, req.selection);
  }
}

export function useWorktreeActions(repoId: RepoId): UseWorktreeActions {
  const queryClient = useQueryClient();
  const mutation = useMutation<unknown, AppError, WorktreeRequest>({
    mutationFn: (req) =>
      execute(repoId, req).catch((e: unknown) => {
        throw toAppError(e);
      }),
    // Returning the promise keeps `pending` true until the refetch is triggered. Runs on
    // failure too, since a failed action may have partly applied.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) }),
  });
  const { mutate } = mutation;

  return {
    stage: (paths) => mutate({ action: "stage", paths }),
    unstage: (paths) => mutate({ action: "unstage", paths }),
    stageAll: () => mutate({ action: "stageAll" }),
    unstageAll: () => mutate({ action: "unstageAll" }),
    discard: (paths) => mutate({ action: "discard", paths }),
    addToGitignore: (path) => mutate({ action: "addToGitignore", path }),
    applyHunk: (path, action, selection) =>
      mutate({ action: "applyHunk", path, hunkAction: action, selection }),
    pending: mutation.isPending,
    error: mutation.error,
    clearError: mutation.reset,
  };
}
