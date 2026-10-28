import { closeRepo, isAppError } from "../lib/ipc";
import type { RepoId } from "../lib/ipc";
import { useCommitDraft } from "../lib/store/commitDraft";
import { useRepoTabs } from "../lib/store/repoTabs";
import { useWorkspace } from "../lib/store/workspace";

/**
 * Closes a repository tab and drops its per-repo state at once, then resolves after the backend
 * close settles. A stale unknown-repo close is ignored, any other failure is logged; never rejects.
 */
export function closeRepoTab(id: RepoId): Promise<void> {
  useRepoTabs.getState().closeTab(id);
  useWorkspace.getState().clear(id);
  useCommitDraft.getState().clear(id);
  return closeRepo(id).catch((e: unknown) => {
    if (isAppError(e) && e.kind === "unknownRepo") return;
    console.error("close_repo failed", e);
  });
}
