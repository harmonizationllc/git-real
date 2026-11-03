import type { FileDiff } from "../../../lib/ipc";
import type { DiffRow } from "./rows";
import { rowLine } from "./selection";

export interface ChangeBlock {
  hunkIndex: number;
  firstRow: number;
  lastRow: number;
}

/** Whether the row shows a non-context line on either side. */
function isChanged(diff: FileDiff, rows: DiffRow[], row: number): boolean {
  return (["old", "new"] as const).some((side) => {
    const line = rowLine(diff, rows, row, side);
    return line !== null && diff.hunks[line.hunkIndex].lines[line.lineIndex].kind !== "context";
  });
}

/** Groups consecutive changed rows (within one hunk) into blocks. */
export function changeBlocks(diff: FileDiff, rows: DiffRow[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let open: ChangeBlock | null = null;
  rows.forEach((row, i) => {
    if (!isChanged(diff, rows, i)) {
      open = null;
    } else if (open && open.hunkIndex === row.hunkIndex) {
      open.lastRow = i;
    } else {
      open = { hunkIndex: row.hunkIndex, firstRow: i, lastRow: i };
      blocks.push(open);
    }
  });
  return blocks;
}
