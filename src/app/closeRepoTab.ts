import { closeRepo, isAppError } from "../lib/ipc";
import type { RepoId } from "../lib/ipc";
import { useCommitDraft } from "../lib/store/commitDraft";
import { useRepoTabs } from "../lib/store/repoTabs";
import { useWorkspace } from "../lib/store/workspace";

/** Closes a repository tab and drops its per-repo state; a stale unknown-repo close is ignored. */
export function closeRepoTab(id: RepoId): void {
  useRepoTabs.getState().closeTab(id);
  useWorkspace.getState().clear(id);
  useCommitDraft.getState().clear(id);
  closeRepo(id).catch((e: unknown) => {
    if (isAppError(e) && e.kind === "unknownRepo") return;
    console.error("close_repo failed", e);
  });
}
