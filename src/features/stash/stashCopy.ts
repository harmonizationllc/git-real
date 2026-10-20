import type { AppError } from "../../lib/ipc";
import type { StashNotice } from "./useStashActions";

export const stashRef = (index: number): string => `stash@{${index}}`;

export const STALE_MESSAGE = "The stash list changed; it has been refreshed.";
export const NOTHING_TO_STASH_MESSAGE = "No local changes to stash.";
export const POP_KEPT_TITLE = "Already applied. Use Drop… to remove the stash.";

const CONFLICTS = "Applied with conflicts. Resolve them in Changes.";
const KEPT = " The stash was kept; drop it once resolved.";
const POP_KEPT = "Applied, but the stash could not be dropped. Drop it once you no longer need it.";

export function noticeText(notice: StashNotice): string {
  switch (notice.kind) {
    case "popKept":
      return POP_KEPT;
    case "pop":
      return CONFLICTS + KEPT;
    case "apply":
      return CONFLICTS;
  }
}

/** The error as shown to the user: stash-specific kinds get the app's own wording. */
export function displayError(error: AppError): AppError {
  if (error.kind === "staleStash") return { ...error, message: STALE_MESSAGE };
  if (error.kind === "nothingToStash") return { ...error, message: NOTHING_TO_STASH_MESSAGE };
  return error;
}

/**
 * The message without git's "WIP on <b>: " / "On <b>: " prefix; the row and summary show the
 * branch separately. A branch is "(no branch)" or holds no space or ':' (git forbids both in
 * ref names), so hand-stored text like "On the fence: …" is kept. Mirrors core `branch_of`.
 */
export function stashSubject(message: string): string {
  const prefix = /^(?:WIP on|On) (?:\(no branch\)|[^ :]+): /.exec(message);
  return prefix ? message.slice(prefix[0].length) : message;
}
