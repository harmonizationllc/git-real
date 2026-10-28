import type { LinkedWorktree } from "../lib/ipc";

/** The main worktree, open in the current tab, at `/repos/app` on `main`, unless overridden. */
export const linkedWorktree = (over: Partial<LinkedWorktree> = {}): LinkedWorktree => ({
  name: null,
  path: "/repos/app",
  head: { kind: "branch", name: "main" },
  isMain: true,
  isCurrent: true,
  missing: false,
  locked: null,
  ...over,
});
