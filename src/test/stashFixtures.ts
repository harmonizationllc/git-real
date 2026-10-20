import type { StashEntry, StashFiles, StatusEntry, WorkingTreeStatus } from "../lib/ipc";
import { oidOf } from "./graphFixtures";

/** The stash at index `i`; its oid is `oidOf(100 + i)` and its message names the branch `main`. */
export const stashEntry = (i: number, over: Partial<StashEntry> = {}): StashEntry => ({
  index: i,
  oid: oidOf(100 + i),
  message: `On main: stash ${i}`,
  branch: "main",
  time: 1_700_000_000,
  base: oidOf(0),
  hasUntracked: false,
  ...over,
});

export const stashFiles = (over: Partial<StashFiles> = {}): StashFiles => ({
  tracked: [],
  untracked: [],
  untrackedOid: null,
  ...over,
});

export const statusEntry = (path: string, over: Partial<StatusEntry> = {}): StatusEntry => ({
  path,
  oldPath: null,
  index: null,
  worktree: "modified",
  conflicted: false,
  ...over,
});

export const workingStatus = (
  entries: StatusEntry[] = [statusEntry("a.txt")],
  headUnborn = false,
): WorkingTreeStatus => ({ entries, headUnborn });
