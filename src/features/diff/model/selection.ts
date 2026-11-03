import type { FileDiff, HunkAction, HunkSelection, LineEdit } from "../../../lib/ipc";
import { applyUnits, lineEdits, type EditUnit, type Range } from "./edits";
import type { DiffRow } from "./rows";

export type Side = "old" | "new";

export interface TextPoint {
  row: number;
  offset: number;
}

export interface TextRange {
  side: Side;
  anchor: TextPoint;
  focus: TextPoint;
}

export type MenuTarget = { kind: "range"; range: TextRange } | { kind: "row"; row: number };

export function orderedRange(range: TextRange): { start: TextPoint; end: TextPoint } {
  const { anchor, focus } = range;
  const forward =
    anchor.row < focus.row || (anchor.row === focus.row && anchor.offset <= focus.offset);
  return forward ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

/** The line a row shows on a side (a unified row has one line for both sides). */
export function rowLine(
  _diff: FileDiff,
  rows: DiffRow[],
  row: number,
  side: Side,
): { hunkIndex: number; lineIndex: number } | null {
  const r = rows[row];
  const lineIndex = r.kind === "unified" ? r.lineIndex : r[side];
  return lineIndex === null ? null : { hunkIndex: r.hunkIndex, lineIndex };
}

/**
 * The text a range covers on its side, rows joined by newlines. A unified end row of the other
 * kind (a deletion on the new side, an addition on the old side) is covered whole.
 */
export function coveredText(diff: FileDiff, rows: DiffRow[], range: TextRange): string {
  const { start, end } = orderedRange(range);
  const parts: string[] = [];
  for (let row = start.row; row <= end.row; row++) {
    const line = rowLine(diff, rows, row, range.side);
    if (line === null) continue;
    const { content: text, kind } = diff.hunks[line.hunkIndex].lines[line.lineIndex];
    // Only a unified row can hold a line of the other kind: a split side shows its own lines.
    const cut = kind === "context" || (kind === "deletion") === (range.side === "old");
    parts.push(
      text.slice(
        cut && row === start.row ? start.offset : 0,
        cut && row === end.row ? end.offset : text.length,
      ),
    );
  }
  return parts.join("\n");
}

interface Pair {
  del: number;
  add: number;
  units: EditUnit[];
  chosen: Set<number>;
  whole: boolean;
}

function rowSelection(diff: FileDiff, rows: DiffRow[], row: number): HunkSelection | null {
  const r = rows[row];
  const lines = diff.hunks[r.hunkIndex].lines;
  const indices = r.kind === "unified" ? [r.lineIndex] : [r.old, r.new];
  const picked = [...new Set(indices.filter((i) => i !== null))].sort((x, y) => x - y);
  if (picked.every((i) => lines[i].kind === "context")) return null;
  return { hunkIndex: r.hunkIndex, lines: picked, edits: [] };
}

interface Entry {
  index: number;
  partner: number | null;
  onSide: boolean;
}

function rowEntries(diff: FileDiff, r: DiffRow, side: Side): Entry[] {
  if (r.kind === "unified") {
    const kind = diff.hunks[r.hunkIndex].lines[r.lineIndex].kind;
    const onSide = kind === "context" || (kind === "deletion") === (side === "old");
    return [{ index: r.lineIndex, partner: r.partner, onSide }];
  }
  const paired = r.old !== null && r.new !== null && r.old !== r.new;
  const entries: Entry[] = [];
  if (r.old !== null) {
    entries.push({ index: r.old, partner: paired ? r.new : null, onSide: side === "old" });
  }
  if (r.new !== null && r.new !== r.old) {
    entries.push({ index: r.new, partner: paired ? r.old : null, onSide: side === "new" });
  }
  return entries;
}

function rangeSelection(
  diff: FileDiff,
  rows: DiffRow[],
  range: TextRange,
  forward: boolean,
): HunkSelection | null {
  const { start, end } = orderedRange(range);
  const hunkIndex = rows[start.row].hunkIndex;
  const lines = diff.hunks[hunkIndex].lines;
  const pairs = new Map<number, Pair>();
  const solo = new Set<number>();

  const pairFor = (del: number, add: number): Pair => {
    let p = pairs.get(del);
    if (!p) {
      p = {
        del,
        add,
        units: lineEdits(lines[del].content, lines[add].content),
        chosen: new Set(),
        whole: false,
      };
      pairs.set(del, p);
    }
    return p;
  };

  /** Chooses a line outright (covered null) or the units its covered characters touch. */
  const mark = (index: number, partner: number | null, covered: Range | null) => {
    const line = lines[index];
    if (line.kind === "context") return;
    if (partner === null) {
      if (covered === null || covered.end > covered.start) solo.add(index);
      return;
    }
    const isDel = line.kind === "deletion";
    const p = isDel ? pairFor(index, partner) : pairFor(partner, index);
    if (covered === null) {
      p.whole = true;
      return;
    }
    p.units.forEach((u, k) => {
      const r = isDel ? u.old : u.new;
      const hit =
        r.end > r.start
          ? Math.max(r.start, covered.start) < Math.min(r.end, covered.end)
          : covered.start < r.start && r.start < covered.end;
      if (hit) p.chosen.add(k);
    });
  };

  for (let row = start.row; row <= end.row; row++) {
    const r = rows[row];
    if (r.hunkIndex !== hunkIndex) continue;
    const entries = rowEntries(diff, r, range.side);
    const partial = entries.some((e) => e.onSide) && (row === start.row || row === end.row);
    for (const e of entries) {
      if (!partial) {
        mark(e.index, e.partner, null);
      } else if (e.onSide) {
        const length = lines[e.index].content.length;
        mark(e.index, e.partner, {
          start: row === start.row ? start.offset : 0,
          end: row === end.row ? Math.min(end.offset, length) : length,
        });
      }
    }
  }

  const selected = new Set<number>(solo);
  const edits: LineEdit[] = [];
  for (const p of pairs.values()) {
    if (p.whole || (p.chosen.size > 0 && p.chosen.size === p.units.length)) {
      selected.add(p.del).add(p.add);
    } else if (p.chosen.size > 0) {
      const index = forward ? p.del : p.add;
      selected.add(index);
      const text = applyUnits(
        lines[p.del].content,
        lines[p.add].content,
        p.units,
        p.chosen,
        forward,
      );
      edits.push({ index, text });
    }
  }
  if (selected.size === 0) return null;
  edits.sort((x, y) => x.index - y.index);
  return { hunkIndex, lines: [...selected].sort((x, y) => x - y), edits };
}

/** Maps a menu target to the lines (and partial-line edits) an action should apply to. */
export function selectionRequest(
  diff: FileDiff,
  rows: DiffRow[],
  target: MenuTarget,
  action: HunkAction,
): HunkSelection | null {
  if (target.kind === "row") return rowSelection(diff, rows, target.row);
  return rangeSelection(diff, rows, target.range, action === "stage");
}
