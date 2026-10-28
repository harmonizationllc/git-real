import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  addLinkedWorktree,
  pruneLinkedWorktrees,
  removeLinkedWorktree,
  toAppError,
} from "../../lib/ipc";
import type { AppError, RepoId, WorktreeBranch } from "../../lib/ipc";
import { mutationKeys, queryKeys } from "../../lib/query/keys";
import { useRepoTabs } from "../../lib/store/repoTabs";
import { closeRepoTab } from "../../app/closeRepoTab";

/** Each action resolves with the AppError or null and never rejects. */
export interface UseLinkedWorktreeActions {
  add(path: string, branch: WorktreeBranch): Promise<AppError | null>;
  /** Closes the tabs open on `path` first; a failure leaves them closed. */
  remove(path: string, force: boolean): Promise<AppError | null>;
  /** Closes the tabs open on `paths` (the stale ones) first, then prunes. */
  prune(paths: string[]): Promise<AppError | null>;
  /** True while any worktree action of this repo runs, in this instance or another. */
  pending: boolean;
  error: AppError | null;
  clearError(): void;
}

type Request =
  | { action: "add"; path: string; branch: WorktreeBranch }
  | { action: "remove"; path: string; force: boolean }
  | { action: "prune" };

async function execute(repoId: RepoId, req: Request): Promise<void> {
  switch (req.action) {
    case "add":
      return addLinkedWorktree(repoId, req.path, req.branch);
    case "remove":
      return removeLinkedWorktree(repoId, req.path, req.force);
    case "prune":
      await pruneLinkedWorktrees(repoId);
  }
}

/** A tab open on a removed folder would point at nothing, so it goes first, watcher and all. */
function closeTabsOn(paths: string[]): Promise<void>[] {
  return useRepoTabs
    .getState()
    .tabs.filter((tab) => paths.includes(tab.summary.path))
    .map((tab) => closeRepoTab(tab.id));
}

export function useLinkedWorktreeActions(repoId: RepoId): UseLinkedWorktreeActions {
  const queryClient = useQueryClient();
  const [error, setError] = useState<AppError | null>(null);
  // Counted here rather than read from `isPending`, whose observer update lands a tick later.
  const [busy, setBusy] = useState(0);
  const elsewhere = useIsMutating({ mutationKey: mutationKeys.linkedWorktree(repoId) }) > 0;
  const { mutateAsync } = useMutation<void, AppError, Request>({
    mutationKey: mutationKeys.linkedWorktree(repoId),
    mutationFn: (req) =>
      execute(repoId, req).catch((e: unknown) => {
        throw toAppError(e);
      }),
    // Runs on failure too: a vanished worktree needs the new list. Recent gains or loses a folder.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.recent }),
      ]),
  });

  /** `closing` settles before the command starts, so no watcher holds the folder git touches. */
  const run = (req: Request, closing: Promise<void>[] = []): Promise<AppError | null> => {
    setError(null);
    setBusy((n) => n + 1);
    return Promise.all(closing)
      .then(() => mutateAsync(req))
      .then(
        () => null,
        (e: AppError) => {
          setError(e);
          return e;
        },
      )
      .finally(() => setBusy((n) => n - 1));
  };

  return {
    add: (path, branch) => run({ action: "add", path, branch }),
    remove: (path, force) => run({ action: "remove", path, force }, closeTabsOn([path])),
    prune: (paths) => run({ action: "prune" }, closeTabsOn(paths)),
    pending: busy > 0 || elsewhere,
    error,
    clearError: () => setError(null),
  };
}
