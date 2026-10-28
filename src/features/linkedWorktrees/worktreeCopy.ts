import type { HeadState, LinkedWorktree } from "../../lib/ipc";

/** A row's head text, worded as the repo header words it. */
export function headText(head: HeadState | null): string {
  if (head === null) return "unknown HEAD";
  switch (head.kind) {
    case "branch":
      return head.name;
    case "detached":
      return `detached at ${head.oid.slice(0, 7)}`;
    case "unborn":
      return `${head.name} (no commits yet)`;
  }
}

const lockedText = (reason: string): string => (reason === "" ? "Locked" : `Locked: ${reason}`);

/** Why Remove… is disabled for `w`; undefined when it can be removed. */
export function removeTitle(w: LinkedWorktree): string | undefined {
  if (w.isMain) return "The main worktree cannot be removed";
  if (w.isCurrent) return "Close this tab and remove it from another worktree";
  if (w.locked !== null) return lockedText(w.locked);
  return undefined;
}

/** Why Open is disabled for `w`; undefined when it can be opened. */
export function openTitle(w: LinkedWorktree): string | undefined {
  if (w.isCurrent) return "Already open in this tab";
  if (w.missing) return "Folder not found";
  return undefined;
}
