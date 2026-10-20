import type { OperationState, WorkingTreeStatus } from "../../lib/ipc";
import { IN_PROGRESS_TITLE } from "../merge/operationCopy";

/** Whether a stash control is disabled, and why when the reason is worth telling. */
export interface Gate {
  disabled: boolean;
  title?: string;
}

export const RESOLVE_FIRST_TITLE = "Resolve all conflicts first";

const hasConflicts = (status: WorkingTreeStatus) => status.entries.some((e) => e.conflicted);

/** The gate of the + and Stash… buttons; disabled without a title while either input loads. */
export function pushGate(
  status: WorkingTreeStatus | undefined,
  state: OperationState | undefined,
): Gate {
  if (status === undefined || state === undefined) return { disabled: true };
  if (status.headUnborn) return { disabled: true, title: "Make a commit first" };
  if (state.kind !== "none") return { disabled: true, title: IN_PROGRESS_TITLE };
  if (hasConflicts(status)) return { disabled: true, title: RESOLVE_FIRST_TITLE };
  if (status.entries.length === 0) return { disabled: true, title: "No changes to stash" };
  return { disabled: false };
}

/** The gate of Apply and Pop; disabled without a title while either input loads. */
export function applyGate(
  status: WorkingTreeStatus | undefined,
  state: OperationState | undefined,
): Gate {
  if (status === undefined || state === undefined) return { disabled: true };
  if (state.kind !== "none") return { disabled: true, title: IN_PROGRESS_TITLE };
  if (hasConflicts(status)) return { disabled: true, title: RESOLVE_FIRST_TITLE };
  return { disabled: false };
}
