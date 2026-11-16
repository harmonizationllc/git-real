import type { BranchList, LocalBranch } from "../../lib/ipc";
import type { BranchTarget } from "./BranchRow";

const keyOf = (t: BranchTarget): string =>
  t.kind === "local" ? `local:${t.branch.name}` : `${t.branch.remote}/${t.branch.name}`;
const groupOf = (t: BranchTarget): string => (t.kind === "local" ? "local" : t.branch.remote);

/**
 * What a context-menu action applies to: when the right-clicked row is selected, the selected
 * rows of its group (Local, or one remote) in display order; otherwise the row alone.
 */
export function batchTargets(
  menu: BranchTarget,
  selected: ReadonlySet<string>,
  orderedKeys: string[],
  list: BranchList,
): BranchTarget[] {
  if (!selected.has(keyOf(menu))) return [menu];
  const byKey = new Map<string, BranchTarget>();
  for (const branch of list.local) byKey.set(`local:${branch.name}`, { kind: "local", branch });
  for (const g of list.remotes) {
    for (const branch of g.branches) {
      byKey.set(`${g.remote}/${branch.name}`, { kind: "remote", branch });
    }
  }
  const group = groupOf(menu);
  return orderedKeys
    .filter((k) => selected.has(k))
    .map((k) => byKey.get(k))
    .filter((t): t is BranchTarget => t !== undefined && groupOf(t) === group);
}

/** The local branches among `targets` that can be deleted: not HEAD, not checked out elsewhere. */
export const deletableLocal = (targets: BranchTarget[]): LocalBranch[] =>
  targets.flatMap((t) =>
    t.kind === "local" && !t.branch.isHead && t.branch.worktree === null ? [t.branch] : [],
  );
