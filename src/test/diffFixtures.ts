import type { DiffLine, DiffLineKind, FileDiff, Hunk } from "../lib/ipc";

/** Builds one diff line; line numbers default to null (not part of that side). */
export const L = (
  kind: DiffLineKind,
  content: string,
  old: number | null = null,
  nu: number | null = null,
): DiffLine => ({ kind, content, oldLineno: old, newLineno: nu, noNewlineAtEof: false });

export const hunk = (lines: DiffLine[], header = "@@ -1,2 +1,2 @@"): Hunk => ({
  oldStart: 1,
  oldLines: 2,
  newStart: 1,
  newLines: 2,
  header,
  lines,
});

export const fileDiff = (hunks: Hunk[], extra: Partial<FileDiff> = {}): FileDiff => ({
  path: "a.ts",
  oldPath: null,
  scope: "unstaged",
  change: "modified",
  isBinary: false,
  hunks,
  truncated: false,
  oldEncoding: null,
  newEncoding: null,
  ...extra,
});
