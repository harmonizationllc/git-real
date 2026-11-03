import { lineEdits, type Range } from "./edits";

export type { Range };

export interface WordDiff {
  old: Range[];
  new: Range[];
}

const nonEmpty = (r: Range): boolean => r.end > r.start;

/** Character ranges (UTF-16 offsets) that differ between two lines, by token-level LCS. */
export function wordDiff(a: string, b: string): WordDiff {
  const units = lineEdits(a, b);
  return {
    old: units.map((u) => u.old).filter(nonEmpty),
    new: units.map((u) => u.new).filter(nonEmpty),
  };
}
