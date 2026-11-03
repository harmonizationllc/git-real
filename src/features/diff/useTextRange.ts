import { useCallback, useLayoutEffect, useRef, useState } from "react";
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
  onPointerCancel(e: React.PointerEvent): void;
  onLostPointerCapture(e: React.PointerEvent): void;
  onDoubleClick(e: React.MouseEvent): void;
  clear(): void;
}

interface Drag {
  side: Side;
  anchor: TextPoint;
}

/** Pixels scrolled per animation frame while a drag is past the container's top or bottom. */
const EDGE_STEP = 16;
/** A word character, as in the edit tokens (edits.ts). */
const WORD = /[\p{L}\p{N}_]/u;
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
  // Unmounting or new rows end a drag that was still going. A layout effect, so its cleanup runs
  // inside the commit that brings the new rows: no move or frame can rebuild a stale range after.
  useLayoutEffect(() => stop, [rows, stop]);

  /** The text a row shows on a side; "" for an empty split cell. */
  const lineText = (row: number, side: Side) => {
    const line = rowLine(diff, rows, row, side);
    return line === null ? "" : diff.hunks[line.hunkIndex].lines[line.lineIndex].content;
  };

  /** Moves the focus to the hit at the point, with the point clamped into the container. */
  const extend = (from: Drag, x: number, y: number) => {
    const rect = scrollEl()!.getBoundingClientRect();
    const hit = hitAt(
      Math.min(Math.max(x, rect.left + 1), rect.right - 1),
      Math.min(Math.max(y, rect.top + 1), rect.bottom - 1),
    );
    if (hit === null) return;
    const r = rows[hit.row];
    // A split hit on the other cell, or on an empty cell, snaps to the row's line on the drag
    // side: its end at or below the anchor row, its start above; the other cell's offset is
    // never applied.
    const snap = r.kind === "split" && (hit.side !== from.side || r[from.side] === null);
    const below = hit.row >= from.anchor.row;
    const offset = !snap ? hit.offset : below ? lineText(hit.row, from.side).length : 0;
    setState({ ...from, focus: { row: hit.row, offset } });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // A touch pans the list (touch-action: pan-y); only mouse and pen drag a range.
    if (e.button !== 0 || e.pointerType === "touch") return;
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
    // The button was released where no pointerup reached us: the drag is over.
    if (e.buttons === 0) {
      stop();
      return;
    }
    extend(drag.current, e.clientX, e.clientY);
    const rect = scrollEl()!.getBoundingClientRect();
    const dir = e.clientY < rect.top ? -1 : e.clientY > rect.bottom ? 1 : 0;
    edge.current = { dir, x: e.clientX, y: e.clientY };
  };

  /** Ends the drag; one that ended back on its anchor leaves no range. */
  const end = () => {
    stop();
    const collapsed =
      range !== null &&
      range.anchor.row === range.focus.row &&
      range.anchor.offset === range.focus.offset;
    if (collapsed) setState(null);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    end();
  };

  /** A cancelled pointer or a lost capture ends the drag like a pointerup. */
  const onPointerCancel = () => end();

  const onDoubleClick = (e: React.MouseEvent) => {
    const hit = hitAt(e.clientX, e.clientY);
    if (hit === null) return;
    // The word containing the offset, else the word ending at it; none strictly inside spaces.
    const text = lineText(hit.row, hit.side);
    let wordStart = hit.offset;
    let wordEnd = hit.offset;
    while (wordStart > 0 && WORD.test(text[wordStart - 1])) wordStart--;
    while (wordEnd < text.length && WORD.test(text[wordEnd])) wordEnd++;
    if (wordStart === wordEnd) return;
    setState({
      side: hit.side,
      anchor: { row: hit.row, offset: wordStart },
      focus: { row: hit.row, offset: wordEnd },
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

  return {
    range,
    tint,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture: onPointerCancel,
    onDoubleClick,
    clear,
  };
}
