import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CloneProgressPayload, Progress, RepoChangedPayload, RepoId } from "./types";

export type { UnlistenFn } from "@tauri-apps/api/event";

// Mirrors the Rust events::CLONE_PROGRESS constant.
const CLONE_PROGRESS = "clone-progress";
// Mirrors the Rust events::REPO_CHANGED constant.
const REPO_CHANGED = "repo-changed";

export function onCloneProgress(
  cloneId: number,
  handler: (p: Progress) => void,
): Promise<UnlistenFn> {
  return listen<CloneProgressPayload>(CLONE_PROGRESS, (e) => {
    if (e.payload.cloneId === cloneId) handler(e.payload.progress);
  });
}

export function onRepoChanged(repoId: RepoId, handler: () => void): Promise<UnlistenFn> {
  return listen<RepoChangedPayload>(REPO_CHANGED, (e) => {
    if (e.payload.repoId === repoId) handler();
  });
}
