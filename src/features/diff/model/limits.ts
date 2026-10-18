import type { FileDiff } from "../../../lib/ipc";

/** Above this many diff lines the viewer skips syntax highlighting. */
export const HIGHLIGHT_LIMIT = 20_000;
/** Line cap requested by "Load full diff". */
export const FULL_DIFF_LINES = 1_000_000;
/** Lines with more tokens than this are marked changed as a whole. */
export const WORD_DIFF_MAX_TOKENS = 400;

export function totalLines(diff: FileDiff): number {
  return diff.hunks.reduce((n, h) => n + h.lines.length, 0);
}
