import type { Blame, BlameHunk } from "../../../lib/ipc";

export interface BlameRow {
  /** 0-based line index into `blame.lines`; the line number is index + 1. */
  index: number;
  hunk: BlameHunk;
  /** Position of `hunk` in `blame.hunks`; parity drives the alternating background. */
  hunkIndex: number;
  firstOfHunk: boolean;
}

/**
 * One row per blamed line. libgit2 counts hunk lines and blob lines independently, so rows are
 * clamped to `blame.lines`; a zero-line hunk (an empty file) emits nothing.
 */
export function blameRows(blame: Blame): BlameRow[] {
  const rows: BlameRow[] = [];
  blame.hunks.forEach((hunk, hunkIndex) => {
    for (let k = 0; k < hunk.lines; k++) {
      const index = hunk.start - 1 + k;
      if (index >= blame.lines.length) break;
      rows.push({ index, hunk, hunkIndex, firstOfHunk: k === 0 });
    }
  });
  return rows;
}
