import type { FileDiff } from "../../../lib/ipc";
import type { DiffRow } from "./rows";
import { rowLine } from "./selection";

export type BlockKind = "added" | "removed" | "modified";

export interface ChangeBlock {
  hunkIndex: number;
  firstRow: number;
  lastRow: number;
  kind: BlockKind;
}

/** Which kinds of change the row shows, on either side. */
function changedSides(
  diff: FileDiff,
  rows: DiffRow[],
  row: number,
): { added: boolean; removed: boolean } {
  const sides = { added: false, removed: false };
  for (const side of ["old", "new"] as const) {
    const line = rowLine(diff, rows, row, side);
    if (line === null) continue;
    const kind = diff.hunks[line.hunkIndex].lines[line.lineIndex].kind;
    if (kind === "addition") sides.added = true;
    if (kind === "deletion") sides.removed = true;
  }
  return sides;
}

function blockKind(added: boolean, removed: boolean): BlockKind {
  if (added && removed) return "modified";
  return added ? "added" : "removed";
}

/** Groups consecutive changed rows (within one hunk) into blocks. */
export function changeBlocks(diff: FileDiff, rows: DiffRow[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let open: ChangeBlock | null = null;
  let added = false;
  let removed = false;
  rows.forEach((row, i) => {
    const sides = changedSides(diff, rows, i);
    if (!sides.added && !sides.removed) {
      open = null;
      return;
    }
    if (open && open.hunkIndex === row.hunkIndex) {
      open.lastRow = i;
      added ||= sides.added;
      removed ||= sides.removed;
    } else {
      ({ added, removed } = sides);
      open = { hunkIndex: row.hunkIndex, firstRow: i, lastRow: i, kind: "added" };
      blocks.push(open);
    }
    open.kind = blockKind(added, removed);
  });
  return blocks;
}
