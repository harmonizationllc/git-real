import type { DiffLine } from "../../../lib/ipc";

export interface LinePair {
  old: number | null;
  new: number | null;
}

/** Pairs a run of deletions with the addition run that follows it, per hunk. */
export function pairLines(lines: DiffLine[]): LinePair[] {
  const pairs: LinePair[] = [];
  let dels: number[] = [];
  let adds: number[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) pairs.push({ old: dels[k] ?? null, new: adds[k] ?? null });
    dels = [];
    adds = [];
  };
  lines.forEach((line, i) => {
    if (line.kind === "context") {
      flush();
      pairs.push({ old: i, new: i });
    } else if (line.kind === "deletion") {
      if (adds.length > 0) flush();
      dels.push(i);
    } else {
      adds.push(i);
    }
  });
  flush();
  return pairs;
}
