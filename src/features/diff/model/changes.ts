import type { FileDiff } from "../../../lib/ipc";
import type { DiffRow } from "./rows";

export interface ChangeBlock {
  hunkIndex: number;
  firstRow: number;
  lastRow: number;
}

function isChanged(diff: FileDiff, row: DiffRow): boolean {
  const indices =
    row.kind === "unified" ? [row.lineIndex] : [row.old, row.new].filter((i) => i !== null);
  return indices.some((i) => diff.hunks[row.hunkIndex].lines[i].kind !== "context");
}

/** Groups consecutive changed rows (within one hunk) into blocks. */
export function changeBlocks(diff: FileDiff, rows: DiffRow[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let open: ChangeBlock | null = null;
  rows.forEach((row, i) => {
    if (!isChanged(diff, row)) {
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
