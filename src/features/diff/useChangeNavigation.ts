import { useCallback, useMemo, useState } from "react";
import type { RefObject } from "react";
import type { FileDiff } from "../../lib/ipc";
import type { DiffViewerHandle } from "./DiffViewer";
import { changeBlocks } from "./model/changes";
import type { DiffRow } from "./model/rows";

export interface ChangeNavigation {
  count: number;
  current: number | null;
  next(): void;
  prev(): void;
  goTo(i: number): void;
  onUserScroll(): void;
}

/** Steps through the diff's change blocks; a manual scroll forgets the current one. */
export function useChangeNavigation(
  diff: FileDiff,
  rows: DiffRow[],
  viewer: RefObject<DiffViewerHandle | null>,
): ChangeNavigation {
  const blocks = useMemo(() => changeBlocks(diff, rows), [diff, rows]);
  const [state, setState] = useState<{ rows: DiffRow[]; current: number | null }>({
    rows,
    current: null,
  });
  // Reset on a new rows identity while rendering, so no stale index is ever shown.
  let current = state.current;
  if (state.rows !== rows) {
    current = null;
    setState({ rows, current: null });
  }

  const goTo = useCallback(
    (i: number) => {
      const index = Math.min(Math.max(i, 0), blocks.length - 1);
      setState({ rows, current: index });
      viewer.current?.scrollToRow(Math.max(0, blocks[index].firstRow - 3));
    },
    [blocks, rows, viewer],
  );

  const next = useCallback(() => {
    const c = current;
    if (c !== null) {
      if (c < blocks.length - 1) goTo(c + 1);
      return;
    }
    const top = viewer.current?.firstVisibleRow() ?? 0;
    const i = blocks.findIndex((b) => b.firstRow > top);
    if (i !== -1) goTo(i);
  }, [blocks, current, goTo, viewer]);

  const prev = useCallback(() => {
    const c = current;
    if (c !== null) {
      if (c > 0) goTo(c - 1);
      return;
    }
    const top = viewer.current?.firstVisibleRow() ?? 0;
    const below = blocks.filter((b) => b.firstRow < top).length;
    if (below > 0) goTo(below - 1);
  }, [blocks, current, goTo, viewer]);

  const onUserScroll = useCallback(() => setState((s) => ({ ...s, current: null })), []);

  return { count: blocks.length, current, next, prev, goTo, onUserScroll };
}
