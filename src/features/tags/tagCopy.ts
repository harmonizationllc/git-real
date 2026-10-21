import type { AppError } from "../../lib/ipc";
import type { TagStatus } from "./useTagActions";

export const NO_REMOTES_TITLE = "No remotes configured";
export const MAKE_COMMIT_FIRST = "Make a commit first";

export const statusText = ({ kind, name, remote }: TagStatus): string =>
  kind === "pushed" ? `Pushed ${name} to ${remote}.` : `Deleted ${name} from ${remote}.`;

/** The panel's copy for a tag action's error: a vanished tag says the list was refreshed. */
export function displayError(error: AppError, name: string | null): AppError {
  if (error.kind === "tagNotFound" && name !== null)
    return { ...error, message: `Tag ${name} no longer exists; the list has been refreshed.` };
  return error;
}

/** The create dialog's inline copy for `error`, naming the tag `name`. */
export function createErrorText(error: AppError, name: string): string {
  switch (error.kind) {
    case "invalidTagName":
      return `${name} is not a valid tag name.`;
    case "tagExists":
      return `A tag named ${name} already exists.`;
    case "commitNotFound":
      return "That commit no longer exists.";
    case "emptyMessage":
      return "Enter a message for an annotated tag.";
    default:
      return error.message; // operationFailed carries git's text
  }
}

/** The Tags header: `Tags (n)`, or `Tags (m of n)` while the filter narrows the list. */
export const tagCountLabel = (shown: number, total: number, filtering: boolean): string =>
  filtering ? `Tags (${shown} of ${total})` : `Tags (${total})`;
