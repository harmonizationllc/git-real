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

/**
 * One hunk of three edited line pairs: unified rows ctx0, del1..3, add4..6, ctx7 (partners 1<->4,
 * 2<->5, 3<->6); split rows ctx, {1,4}, {2,5}, {3,6}, ctx.
 */
export const threePairDiff = (): FileDiff =>
  fileDiff([
    hunk(
      [
        L("context", "c", 1, 1),
        L("deletion", "one two three", 2, null),
        L("deletion", "four five six", 3, null),
        L("deletion", "seven eight nine", 4, null),
        L("addition", "one two THREE", null, 2),
        L("addition", "FOUR FIVE SIX", null, 3),
        L("addition", "SEVEN eight NINE", null, 4),
        L("context", "d", 5, 5),
      ],
      "@@ -1,5 +1,5 @@",
    ),
  ]);
