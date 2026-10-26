import type { FileDiff } from "../../../lib/ipc";
import type { DiffMode } from "../../../lib/ipc";
import { pairLines } from "./pairing";

export type DiffRow =
  | { kind: "header"; key: string; hunkIndex: number; header: string }
  | { kind: "unified"; key: string; hunkIndex: number; lineIndex: number; partner: number | null }
  | { kind: "split"; key: string; hunkIndex: number; old: number | null; new: number | null };

/** Key segment for one side of a split row; "-" marks a missing side. */
const side = (index: number | null): string => (index === null ? "-" : String(index));

/** Flattens a diff into virtualizable rows; `partner` links the two halves of an edited line. */
export function buildRows(diff: FileDiff, mode: DiffMode): DiffRow[] {
  const rows: DiffRow[] = [];
  diff.hunks.forEach((hunk, hunkIndex) => {
    rows.push({ kind: "header", key: `h${hunkIndex}`, hunkIndex, header: hunk.header });
    const pairs = pairLines(hunk.lines);
    if (mode === "split") {
      for (const p of pairs) {
        rows.push({
          kind: "split",
          key: `s${hunkIndex}:${side(p.old)}:${side(p.new)}`,
          hunkIndex,
          old: p.old,
          new: p.new,
        });
      }
      return;
    }
    const partner = new Map<number, number>();
    for (const p of pairs) {
      if (p.old !== null && p.new !== null && p.old !== p.new) {
        partner.set(p.old, p.new);
        partner.set(p.new, p.old);
      }
    }
    hunk.lines.forEach((_, lineIndex) => {
      rows.push({
        kind: "unified",
        key: `u${hunkIndex}:${lineIndex}`,
        hunkIndex,
        lineIndex,
        partner: partner.get(lineIndex) ?? null,
      });
    });
  });
  return rows;
}
