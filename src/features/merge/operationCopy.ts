import type { HeadState, OperationState } from "../../lib/ipc";
import { shortOid } from "../graph/model/layout";

export type ActiveOperation = Exclude<OperationState, { kind: "none" }>;
export type CommittingOperation = Extract<
  OperationState,
  { kind: "merge" | "cherryPick" | "revert" }
>;

export type OperationNoun = "merge" | "rebase" | "cherry-pick" | "revert";

export const IN_PROGRESS_TITLE = "Finish or abort the current operation first";

export function operationNoun(state: ActiveOperation): OperationNoun {
  switch (state.kind) {
    case "merge":
      return "merge";
    case "rebase":
      return "rebase";
    case "cherryPick":
      return "cherry-pick";
    case "revert":
      return "revert";
  }
}

/** The current branch name; "HEAD" when detached, unborn or not yet loaded. */
export function headName(head: HeadState | undefined): string {
  return head?.kind === "branch" ? head.name : "HEAD";
}

function conflictSuffix(conflicts: number): string {
  if (conflicts === 0) return ", no conflicts remaining";
  if (conflicts === 1) return ", 1 conflict remaining";
  return `, ${conflicts} conflicts remaining`;
}

function operationTitle(state: ActiveOperation, head: string): string {
  switch (state.kind) {
    case "merge":
      return `Merging ${state.branch ?? shortOid(state.head)} into ${head}`;
    case "rebase":
      // HEAD is detached mid-rebase, so the rebased branch comes from the state.
      return `Rebasing ${state.branch ?? head} onto ${state.ontoName ?? shortOid(state.onto)}, step ${state.step} of ${state.total}`;
    case "cherryPick":
      return `Cherry-picking ${shortOid(state.oid)}`;
    case "revert":
      return `Reverting ${shortOid(state.oid)}`;
  }
}

export function bannerTitle(state: ActiveOperation, head: string, conflicts: number): string {
  return operationTitle(state, head) + conflictSuffix(conflicts);
}

/** Names for the two sides of a conflict; neutral labels without an operation. */
export function sideLabels(
  state: OperationState | undefined,
  head: string,
): { ours: string; theirs: string } {
  switch (state?.kind) {
    case "merge":
      return { ours: head, theirs: state.branch ?? shortOid(state.head) };
    case "rebase":
      return { ours: state.ontoName ?? shortOid(state.onto), theirs: state.branch ?? head };
    case "cherryPick":
    case "revert":
      return { ours: head, theirs: shortOid(state.oid) };
    case "none":
    case undefined:
      return { ours: "ours", theirs: "theirs" };
  }
}

/** Operations finished by committing through the commit box (a rebase continues instead). */
export function commitsThroughBox(state: OperationState | undefined): state is CommittingOperation {
  return (
    state !== undefined &&
    (state.kind === "merge" || state.kind === "cherryPick" || state.kind === "revert")
  );
}

/** The commit button's label during an operation that commits through the box. */
export function commitButtonLabel(state: OperationState | undefined): string | null {
  return commitsThroughBox(state) ? `Commit and ${operationNoun(state)}` : null;
}
