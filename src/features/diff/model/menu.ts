import type { FileDiff, HunkAction, HunkSelection } from "../../../lib/ipc";
import type { DiffRow } from "./rows";
import { orderedRange, rowLine, type MenuTarget, type TextRange } from "./selection";

/** The diff's right-click item copy, per action and target kind. */
export const LABELS: Record<HunkAction, Record<MenuTarget["kind"], string>> = {
  discard: { row: "Revert this line", range: "Revert this section" },
  stage: { row: "Stage this line", range: "Stage selection" },
  unstage: { row: "Unstage this line", range: "Unstage selection" },
};

/** Why an item is disabled when its target has nothing to apply. */
export const NOTHING_REASON: Record<MenuTarget["kind"], string> = {
  row: "Not a changed line",
  range: "No changed text in the selection",
};

/** The revert dialog copy: highlighted text, one line, or the number of rows the range reverts. */
export function revertBody(
  diff: FileDiff,
  rows: DiffRow[],
  target: MenuTarget,
  selection: HunkSelection,
): string {
  const tail = `in ${diff.path}? This cannot be undone.`;
  if (selection.edits?.length) return `Revert the highlighted text ${tail}`;
  const n = target.kind === "row" ? 1 : revertedRows(diff, rows, target.range, selection);
  return n === 1 ? `Revert this line ${tail}` : `Revert ${n} lines ${tail}`;
}

/** Rows in the range that show a selected line on either side: a split pair counts once. */
export function revertedRows(
  diff: FileDiff,
  rows: DiffRow[],
  range: TextRange,
  selection: HunkSelection,
): number {
  const { start, end } = orderedRange(range);
  const picked = new Set(selection.lines);
  const covered = Array.from({ length: end.row - start.row + 1 }, (_, i) => start.row + i);
  return covered.filter((row) =>
    (["old", "new"] as const).some((side) => {
      const line = rowLine(diff, rows, row, side);
      return line !== null && line.hunkIndex === selection.hunkIndex && picked.has(line.lineIndex);
    }),
  ).length;
}
