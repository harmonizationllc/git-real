import { useCallback, useEffect, useRef, useState } from "react";
import type { FileDiff } from "../../lib/ipc";
import type { CaretResolver } from "./caretResolver";
import type { DiffRow } from "./model/rows";
import {
  orderedRange,
  rowLine,
  type Side,
  type TextPoint,
  type TextRange,
} from "./model/selection";

/** The part of a row a range shades on `side`; null means "to that end of the line". */
export interface RowTint {
  side: Side;
  from: number | null;
  to: number | null;
}

export interface UseTextRange {
  range: TextRange | null;
  tint(row: number): RowTint | null;
  onPointerDown(e: React.PointerEvent): void;
  onPointerMove(e: React.PointerEvent): void;
  onPointerUp(e: React.PointerEvent): void;
  onDoubleClick(e: React.MouseEvent): void;
  clear(): void;
}

interface Drag {
  side: Side;
  anchor: TextPoint;
}

/** Pixels scrolled per animation frame while a drag is past the container's top or bottom. */
const EDGE_STEP = 16;
const WORD = /[A-Za-z0-9_]/;
const NO_HIT: CaretResolver = () => null;

/**
 * A text range dragged over the diff rows on one side, owned by the viewer instead of the
 * browser's selection. Resets whenever `rows` changes identity.
 */
export function useTextRange(
  rows: DiffRow[],
  resolve: CaretResolver | null,
  scrollEl: () => HTMLElement | null,
  diff: FileDiff,
): UseTextRange {
  const [state, setState] = useState<TextRange | null>(null);
  const [seenRows, setSeenRows] = useState(rows);

  // Reset during render (not in an effect) so a stale range is never painted.
  let range = state;
  if (seenRows !== rows) {
    setSeenRows(rows);
    setState(null);
    range = null;
  }

  const hitAt = resolve ?? NO_HIT;
  /** The pointerdown hit while the primary button is held; not rendered, so a ref. */
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);
  /** The latest pointer position and which edge it is past (-1 above, 1 below, 0 inside). */
  const edge = useRef({ dir: 0, x: 0, y: 0 });

  const stop = useCallback(() => {
    cancelAnimationFrame(frame.current);
    drag.current = null;
  }, []);
  // Unmounting or new rows end a drag that was still going.
  useEffect(() => stop, [rows, stop]);

  /** Moves the focus to the hit at the point, with y clamped into the container. */
  const extend = (from: Drag, x: number, y: number) => {
    const rect = scrollEl()!.getBoundingClientRect();
    const hit = hitAt(x, Math.min(Math.max(y, rect.top + 1), rect.bottom - 1));
    if (hit === null) return;
    setState({ ...from, focus: { row: hit.row, offset: hit.offset } });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    stop();
    const hit = hitAt(e.clientX, e.clientY);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    (e.currentTarget as HTMLElement).focus();
    setState(null);
    if (hit === null) return;
    const from: Drag = { side: hit.side, anchor: { row: hit.row, offset: hit.offset } };
    drag.current = from;
    edge.current = { dir: 0, x: e.clientX, y: e.clientY };
    // One loop per drag: it scrolls while the pointer is past an edge, and the focus follows
    // the content moving under the still pointer.
    const step = () => {
      const { dir, x, y } = edge.current;
      if (dir !== 0) {
        scrollEl()!.scrollBy(0, dir * EDGE_STEP);
        extend(from, x, y);
      }
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.current === null) return;
    extend(drag.current, e.clientX, e.clientY);
    const rect = scrollEl()!.getBoundingClientRect();
    const dir = e.clientY < rect.top ? -1 : e.clientY > rect.bottom ? 1 : 0;
    edge.current = { dir, x: e.clientX, y: e.clientY };
  };

  const onPointerUp = (e: React.PointerEvent) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    stop();
    // A drag back onto its anchor leaves no range.
    const collapsed =
      range !== null &&
      range.anchor.row === range.focus.row &&
      range.anchor.offset === range.focus.offset;
    if (collapsed) setState(null);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const hit = hitAt(e.clientX, e.clientY);
    if (hit === null) return;
    // A hit is always on a cell that shows a line (the resolver gives null on an empty cell).
    const line = rowLine(diff, rows, hit.row, hit.side)!;
    const text = diff.hunks[line.hunkIndex].lines[line.lineIndex].content;
    if (!WORD.test(text.charAt(hit.offset))) return;
    let start = hit.offset;
    let end = hit.offset;
    while (start > 0 && WORD.test(text[start - 1])) start--;
    while (end < text.length && WORD.test(text[end])) end++;
    setState({
      side: hit.side,
      anchor: { row: hit.row, offset: start },
      focus: { row: hit.row, offset: end },
    });
  };

  const clear = useCallback(() => setState(null), []);

  const tint = (row: number): RowTint | null => {
    if (range === null) return null;
    const { start, end } = orderedRange(range);
    if (row < start.row || row > end.row) return null;
    return {
      side: range.side,
      from: row === start.row ? start.offset : null,
      to: row === end.row ? end.offset : null,
    };
  };

  return { range, tint, onPointerDown, onPointerMove, onPointerUp, onDoubleClick, clear };
}
