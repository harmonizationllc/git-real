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
  // The open block with the flags accumulated over its rows.
  let open: { block: ChangeBlock; added: boolean; removed: boolean } | null = null;
  rows.forEach((row, i) => {
    const { added, removed } = changedSides(diff, rows, i);
    if (!added && !removed) {
      open = null;
    } else if (open && open.block.hunkIndex === row.hunkIndex) {
      open.added ||= added;
      open.removed ||= removed;
      open.block.lastRow = i;
      open.block.kind = blockKind(open.added, open.removed);
    } else {
      const block = {
        hunkIndex: row.hunkIndex,
        firstRow: i,
        lastRow: i,
        kind: blockKind(added, removed),
      };
      open = { block, added, removed };
      blocks.push(block);
    }
  });
  return blocks;
}
