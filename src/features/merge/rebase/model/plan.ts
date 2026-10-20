import type { RebaseAction, RebaseCommit, RebaseStep, Signature } from "../../../../lib/ipc";

/** One row of the interactive rebase plan, as the dialog shows it. */
export interface PlanStep {
  oid: string;
  subject: string;
  author: Signature;
  action: RebaseAction;
}

export const ACTIONS: readonly { action: RebaseAction; label: string }[] = [
  { action: "pick", label: "Pick — keep the commit" },
  { action: "squash", label: "Squash — fold into the commit below, keep both messages" },
  { action: "fixup", label: "Fixup — fold into the commit below, discard its message" },
  { action: "edit", label: "Edit — stop after applying it to amend" },
  { action: "drop", label: "Drop — leave the commit out" },
];

const isFold = (action: RebaseAction) => action === "squash" || action === "fixup";

/** Newest first, like the graph; every commit picked. `commits` comes in git's order. */
export function initialPlan(commits: RebaseCommit[]): PlanStep[] {
  return commits.map((c): PlanStep => ({ ...c, action: "pick" })).reverse();
}

/** The steps with the one at `from` moved to `to`; the same array when nothing would move. */
export function move(steps: PlanStep[], from: number, to: number): PlanStep[] {
  if (to < 0 || to >= steps.length || from === to) return steps;
  const next = steps.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function setAction(steps: PlanStep[], index: number, action: RebaseAction): PlanStep[] {
  return steps.map((s, i) => (i === index ? { ...s, action } : s));
}

/** The oldest kept step cannot fold into the commit below it (the older one git folds into): there is none. */
export function foldBlocked(steps: PlanStep[], index: number): boolean {
  if (!isFold(steps[index].action)) return false;
  return !steps.slice(index + 1).some((s) => s.action !== "drop");
}

export function summary(steps: PlanStep[]): { kept: number; squashed: number; dropped: number } {
  let kept = 0;
  let squashed = 0;
  let dropped = 0;
  for (const { action } of steps) {
    if (action === "drop") dropped += 1;
    else if (isFold(action)) squashed += 1;
    else kept += 1;
  }
  return { kept, squashed, dropped };
}

export function summaryText({ kept, squashed, dropped }: ReturnType<typeof summary>): string {
  return `${kept} ${kept === 1 ? "commit" : "commits"}, ${squashed} squashed, ${dropped} dropped`;
}

/** What the IPC takes: git's order, oldest first. */
export function toSteps(steps: PlanStep[]): RebaseStep[] {
  return steps.map(({ action, oid }) => ({ action, oid })).reverse();
}

/** Start needs at least one kept step and no fold without a kept step below it. */
export function canStart(steps: PlanStep[]): boolean {
  return summary(steps).kept > 0 && !steps.some((_, i) => foldBlocked(steps, i));
}
