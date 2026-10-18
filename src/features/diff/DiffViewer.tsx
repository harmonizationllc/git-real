import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useMemo, useRef } from "react";
import type { FileDiff, HunkAction, HunkSelection } from "../../lib/ipc";
import type { DiffMode } from "../../lib/store/diffPrefs";
import { HunkHeader } from "./HunkHeader";
import type { HighlightMap } from "./model/highlight";
import { buildRows, type DiffRow } from "./model/rows";
import { SplitRow } from "./SplitRow";
import { UnifiedRow } from "./UnifiedRow";
import type { UseLineSelection } from "./useLineSelection";
import styles from "./DiffViewer.module.css";

export interface DiffViewerProps {
  diff: FileDiff;
  mode: DiffMode;
  highlight: HighlightMap | null;
  selection?: UseLineSelection;
  onHunkAction?(action: HunkAction, selection: HunkSelection): void;
  actionsDisabledReason?: string;
}

/** Virtualized, read-only unless `selection` and `onHunkAction` are given. */
export function DiffViewer({
  diff,
  mode,
  highlight,
  selection,
  onHunkAction,
  actionsDisabledReason,
}: DiffViewerProps) {
  const rows = useMemo(() => buildRows(diff, mode), [diff, mode]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Keyed by row so measured heights follow their rows across mode switches and refetches.
  const getItemKey = useCallback((i: number) => rows[i].key, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 22,
    overscan: 20,
    getItemKey,
  });

  /** The hunk's selected lines, sorted, or null for the whole hunk. */
  const selectionFor = (hunkIndex: number): HunkSelection => ({
    hunkIndex,
    lines:
      selection && selection.hunkIndex === hunkIndex && selection.selected.size > 0
        ? [...selection.selected].sort((a, b) => a - b)
        : null,
  });

  const renderRow = (row: DiffRow) => {
    if (row.kind === "header") {
      return (
        <HunkHeader
          header={row.header}
          scope={diff.scope}
          selectedCount={selection?.hunkIndex === row.hunkIndex ? selection.selected.size : 0}
          disabledReason={actionsDisabledReason}
          onAction={onHunkAction && ((action) => onHunkAction(action, selectionFor(row.hunkIndex)))}
        />
      );
    }
    const props = { diff, highlight, selection, onGutterClick: selection?.click };
    return row.kind === "unified" ? (
      <UnifiedRow {...props} row={row} />
    ) : (
      <SplitRow {...props} row={row} />
    );
  };

  return (
    <section aria-label="Diff" className={styles.root}>
      <div ref={scrollRef} className={styles.scroll} data-testid="diff-scroll">
        <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className={styles.item}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {renderRow(rows[item.index])}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
