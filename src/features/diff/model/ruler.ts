import type { BlockKind, ChangeBlock } from "./changes";

/** Strip resolution: blocks whose marks fall in the same or adjacent thousandth of the strip merge. */
export const RULER_CELLS = 1000;

export interface RulerMark {
  /** Index range of the blocks this mark stands for (inclusive). */
  firstBlock: number;
  lastBlock: number;
  /** Row range covered (inclusive), from the first block's firstRow to the last block's lastRow. */
  firstRow: number;
  lastRow: number;
  /** The blocks' common kind, or "modified" when they differ. */
  kind: BlockKind;
}

/** One mark per run of touching strip cells, so a huge diff never renders thousands of buttons. */
export function rulerMarks(blocks: ChangeBlock[], rowCount: number): RulerMark[] {
  if (rowCount === 0) return [];
  const marks: RulerMark[] = [];
  let open: RulerMark | null = null;
  let openEndCell = 0;
  blocks.forEach((block, i) => {
    // Multiply before dividing so exact cell boundaries stay exact.
    const startCell = Math.floor((block.firstRow * RULER_CELLS) / rowCount);
    const endCell = Math.floor(((block.lastRow + 1) * RULER_CELLS) / rowCount);
    if (open && startCell <= openEndCell) {
      open.lastBlock = i;
      open.lastRow = block.lastRow;
      if (open.kind !== block.kind) open.kind = "modified";
      openEndCell = Math.max(openEndCell, endCell);
    } else {
      open = {
        firstBlock: i,
        lastBlock: i,
        firstRow: block.firstRow,
        lastRow: block.lastRow,
        kind: block.kind,
      };
      openEndCell = endCell;
      marks.push(open);
    }
  });
  return marks;
}
