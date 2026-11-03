import { useVirtualizer } from "@tanstack/react-virtual";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DiffMode, FileDiff } from "../../lib/ipc";
import { domCaretResolver, type CaretResolver } from "./caretResolver";
import type { HighlightMap } from "./model/highlight";
import type { DiffRow } from "./model/rows";
import { coveredText, type MenuTarget } from "./model/selection";
import { SplitRow } from "./SplitRow";
import { UnifiedRow } from "./UnifiedRow";
import { useTextRange } from "./useTextRange";
import styles from "./DiffViewer.module.css";

export interface DiffViewerHandle {
  scrollToRow(index: number): void;
  firstVisibleRow(): number;
}

export interface DiffViewerProps {
  diff: FileDiff;
  rows: DiffRow[];
  mode: DiffMode;
  highlight: HighlightMap | null;
  /** Absent: a right-click does nothing and the browser's own menu opens. */
  onContextMenu?(target: MenuTarget, x: number, y: number): void;
  /** Fired once after the first render. */
  onMounted?(): void;
  /** A scroll the user made: any scroll event not caused by `scrollToRow`. */
  onUserScroll?(): void;
  /** Test seam; defaults to resolving carets from the rendered rows. */
  resolveCaret?: CaretResolver;
}

/** How many frames a scrollToRow waits for the virtualizer to measure before giving up. */
const MEASURE_FRAMES = 30;

/** Virtualized rows with a viewer-owned text range, copy and a context-menu target. */
export const DiffViewer = forwardRef<DiffViewerHandle, DiffViewerProps>(function DiffViewer(
  { diff, rows, highlight, onContextMenu, onMounted, onUserScroll, resolveCaret },
  ref,
) {
  // Held in state (a callback ref) so the default caret resolver is built once it exists, and in
  // a ref so the virtualizer already has it in the commit that attaches it: a scrollToRow from
  // the first effect would otherwise find no scroll element.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  const attach = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
    setScrollEl(el);
  }, []);
  // Keyed by row so measured heights follow their rows across mode switches and refetches.
  const getItemKey = useCallback((i: number) => rows[i].key, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => elRef.current,
    estimateSize: () => 22,
    overscan: 20,
    getItemKey,
  });

  const resolve = useMemo(
    () => resolveCaret ?? (scrollEl && domCaretResolver(scrollEl)),
    [resolveCaret, scrollEl],
  );
  const text = useTextRange(rows, resolve, () => scrollEl, diff);
  const { range } = text;

  // The scroll a scrollToRow causes is not the user's. Its own scroll event clears the flag, and
  // so does any wheel, pointer or key input, since a scroll to the current offset fires none.
  const programmatic = useRef(false);
  // The frame a deferred scrollToRow waits on; 0 is never a frame id, so cancelling it is a no-op.
  const frame = useRef({ id: 0 });
  useEffect(() => {
    const pending = frame.current;
    return () => cancelAnimationFrame(pending.id);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      scrollToRow: (index) => {
        programmatic.current = true;
        // A newer call replaces one still waiting for measurement.
        cancelAnimationFrame(frame.current.id);
        // Before the virtualizer has measured, a scroll is a no-op: retry on later frames.
        const attempt = (framesLeft: number) => {
          if (virtualizer.getTotalSize() > 0) {
            virtualizer.scrollToIndex(index, { align: "start" });
          } else if (framesLeft > 0) {
            frame.current.id = requestAnimationFrame(() => attempt(framesLeft - 1));
          }
        };
        attempt(MEASURE_FRAMES);
      },
      firstVisibleRow: () => virtualizer.range?.startIndex ?? 0,
    }),
    [virtualizer],
  );

  useEffect(() => {
    onMounted?.();
    // Once per mount by contract, whatever callback a later render passes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onScroll = () => {
    if (programmatic.current) programmatic.current = false;
    else onUserScroll?.();
  };
  const userInput = () => {
    programmatic.current = false;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    userInput();
    if (e.key === "Escape") {
      text.clear();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && range !== null) {
      e.preventDefault();
      navigator.clipboard
        .writeText(coveredText(diff, rows, range))
        .catch((err: unknown) => console.error("Copying the diff text failed", err));
    }
  };

  const onMenu = (e: React.MouseEvent) => {
    if (!onContextMenu) return;
    const wrapper = (e.target as Element).closest("[data-index]");
    const target: MenuTarget | null =
      range !== null
        ? { kind: "range", range }
        : wrapper && { kind: "row", row: Number(wrapper.getAttribute("data-index")) };
    if (target === null) return;
    e.preventDefault();
    onContextMenu(target, e.clientX, e.clientY);
  };

  const renderRow = (row: DiffRow, index: number) => {
    const props = { diff, highlight, tint: text.tint(index) };
    return row.kind === "unified" ? (
      <UnifiedRow {...props} row={row} />
    ) : (
      <SplitRow {...props} row={row} />
    );
  };

  return (
    <section aria-label="Diff" className={styles.root}>
      <div
        ref={attach}
        className={styles.scroll}
        data-testid="diff-scroll"
        tabIndex={-1}
        data-focus-target
        onPointerDown={(e) => {
          userInput();
          text.onPointerDown(e);
        }}
        onPointerMove={text.onPointerMove}
        onPointerUp={text.onPointerUp}
        onPointerCancel={text.onPointerCancel}
        onLostPointerCapture={text.onLostPointerCapture}
        onDoubleClick={text.onDoubleClick}
        onKeyDown={onKeyDown}
        onWheel={userInput}
        onScroll={onScroll}
        onContextMenu={onMenu}
      >
        <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className={styles.item}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {renderRow(rows[item.index], item.index)}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
});
