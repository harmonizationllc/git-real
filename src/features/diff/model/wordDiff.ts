import { lineEdits, type Range } from "./edits";

export type { Range };

export interface WordDiff {
  old: Range[];
  new: Range[];
}

const nonEmpty = (r: Range): boolean => r.end > r.start;

/**
 * Two changed words with one unchanged space between them read as one change, so their display
 * ranges merge across that space. The space is unchanged, so only these display ranges merge,
 * never the `lineEdits` units the conflict editor stages by.
 */
function bridgeSingleSpaces(text: string, ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of ranges) {
    const prev = out[out.length - 1];
    if (prev && r.start === prev.end + 1 && text[prev.end] === " ") {
      prev.end = r.end;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** Character ranges (UTF-16 offsets) that differ between two lines, by token-level LCS. */
export function wordDiff(a: string, b: string): WordDiff {
  const units = lineEdits(a, b);
  return {
    old: bridgeSingleSpaces(a, units.map((u) => u.old).filter(nonEmpty)),
    new: bridgeSingleSpaces(b, units.map((u) => u.new).filter(nonEmpty)),
  };
}
