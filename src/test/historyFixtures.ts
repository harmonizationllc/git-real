import type { Blame, BlameHunk, CommitFile, FileHistoryEntry } from "../lib/ipc";
import { oidOf } from "./graphFixtures";

/** A file-history entry for the commit `oidOf(n)`: a modification of `a.txt` by Alice. */
export const historyEntry = (
  n: number,
  over: Partial<FileHistoryEntry> = {},
): FileHistoryEntry => ({
  oid: oidOf(n),
  subject: `Subject ${n}`,
  authorName: "Alice",
  authorEmail: "alice@x.io",
  authorTime: 1_700_000_000,
  change: "modified",
  path: "a.txt",
  oldPath: null,
  ...over,
});

export const commitFile = (path: string, over: Partial<CommitFile> = {}): CommitFile => ({
  path,
  oldPath: null,
  change: "modified",
  ...over,
});

/** A blame hunk of `lines` lines from 1-based `start`, attributed to the commit `oidOf(n)`. */
export const blameHunk = (
  n: number,
  start: number,
  lines: number,
  over: Partial<BlameHunk> = {},
): BlameHunk => ({
  start,
  lines,
  oid: oidOf(n),
  author: { name: "Alice", email: "alice@x.io", time: 1_700_000_000 },
  summary: `Summary ${n}`,
  ...over,
});

export const blameOf = (hunks: BlameHunk[], lines: string[], path = "a.txt"): Blame => ({
  oid: oidOf(99),
  path,
  hunks,
  lines,
});
