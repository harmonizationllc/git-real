import type { AppError } from "../../lib/ipc";
import type { StashNotice } from "./useStashActions";

export const stashRef = (index: number): string => `stash@{${index}}`;

export const STALE_MESSAGE = "The stash list changed; it has been refreshed.";
export const NOTHING_TO_STASH_MESSAGE = "No local changes to stash.";

const CONFLICTS = "Applied with conflicts. Resolve them in Changes.";
const KEPT = " The stash was kept; drop it once resolved.";

export const noticeText = (notice: StashNotice): string =>
  notice.kind === "pop" ? CONFLICTS + KEPT : CONFLICTS;

/** The error as shown to the user: stash-specific kinds get the app's own wording. */
export function displayError(error: AppError): AppError {
  if (error.kind === "staleStash") return { ...error, message: STALE_MESSAGE };
  if (error.kind === "nothingToStash") return { ...error, message: NOTHING_TO_STASH_MESSAGE };
  return error;
}

/** The message without git's branch prefix; the row and summary show the branch separately. */
export function stashSubject(message: string): string {
  const prefix = /^(?:WIP on|On) [^:]*: /.exec(message);
  return prefix ? message.slice(prefix[0].length) : message;
}
