import type { AutoStash } from "../../lib/ipc";
import { useToasts } from "../../lib/store/toasts";
import type { ToastVariant } from "../../lib/store/toasts";

export interface AutoStashNotice {
  text: string;
  variant: ToastVariant;
  sticky: boolean;
  details: string | null;
}

const files = (n: number, adjective: string): string =>
  `${n} ${adjective} ${n === 1 ? "file" : "files"}`;

/** Exported for tests: the toast's text, variant, stickiness and details for a report. */
export function autoStashNotice(report: AutoStash, target: string): AutoStashNotice {
  const on = target;
  switch (report.reapply) {
    case "applied":
      return {
        text: `Stashed ${files(report.files, "changed")} and reapplied ${report.files === 1 ? "it" : "them"} on ${on}.`,
        variant: "success",
        sticky: false,
        details: null,
      };
    case "conflicts":
      return {
        text: `Switched to ${on}, but reapplying your ${files(report.files, "stashed")} hit conflicts. Resolve them, then drop the stash.`,
        variant: "error",
        sticky: true,
        details: null,
      };
    case "appliedNotDropped":
      return {
        text: `Reapplied your ${files(report.files, "stashed")} on ${on}; the stash could not be dropped and is still listed.`,
        variant: "info",
        sticky: false,
        details: null,
      };
    case "kept":
      return {
        text: `Switched to ${on}, but your ${files(report.files, "changed")} could not be reapplied. They are in the stash list.`,
        variant: "error",
        sticky: true,
        details: report.detail,
      };
  }
}

/** Shows the toast an auto-stash report calls for; no-op for null. `target` is the branch name or short oid. */
export function toastAutoStash(report: AutoStash | null, target: string): void {
  if (report === null) return;
  useToasts.getState().notify(autoStashNotice(report, target));
}
