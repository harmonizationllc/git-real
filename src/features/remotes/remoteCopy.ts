import type { AppError } from "../../lib/ipc";

/** What the add / edit form sent: trimmed, with an empty push URL as null. */
export interface RemoteInput {
  name: string;
  url: string;
  pushUrl: string | null;
}

export type RemoteField = "name" | "url" | "pushUrl";

/** The confirmation shared by the Remotes dialog and the Branches remote heading menu. */
export function removeRemoteCopy(name: string): { title: string; body: string } {
  return {
    title: `Remove remote ${name}?`,
    body: "Its remote-tracking branches are deleted locally. Nothing changes on the server.",
  };
}

/** The form field an add / edit failure belongs to, or null when it is a message for the dialog. */
export function remoteFieldError(
  error: AppError,
  input: RemoteInput,
): { field: RemoteField; text: string } | null {
  switch (error.kind) {
    case "invalidRemoteName":
      return { field: "name", text: `${input.name} is not a valid remote name.` };
    case "remoteExists":
      return { field: "name", text: `A remote named ${input.name} already exists.` };
    case "invalidRemoteUrl":
      // Core checks the URL before the push URL and both raise invalidRemoteUrl. A trimmed,
      // single-line URL can fail the URL rule only by starting with "-", so any other URL passed
      // and the push URL is the one at fault.
      return {
        field: input.pushUrl !== null && !input.url.startsWith("-") ? "pushUrl" : "url",
        text: "Enter a valid URL.",
      };
    default:
      return null;
  }
}
