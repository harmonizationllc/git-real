import type { BranchList } from "../../lib/ipc";

/** HEAD's commit as full hex, or null while loading or on an unborn branch. */
export function headCommit(list: BranchList | undefined): string | null {
  if (list === undefined) return null;
  switch (list.head.kind) {
    case "detached":
      return list.head.oid;
    case "branch":
      return list.local.find((b) => b.isHead)?.oid ?? null;
    case "unborn":
      return null;
  }
}
