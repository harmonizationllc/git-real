import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { FileDiff } from "../../lib/ipc";
import { useDiffSearchStore } from "../../lib/store/diffSearch";
import type { DiffViewerHandle } from "./DiffViewer";
import type { DiffRow } from "./model/rows";
import {
  buildMarks,
  findHits,
  hitAnchor,
  pickCurrent,
  type HitAnchor,
  type RowMarks,
  type SearchHit,
  type SearchResult,
} from "./model/search";

export interface DiffSearch {
  hits: SearchHit[];
  capped: boolean;
  /** Index into hits, null when there are none. */
  current: number | null;
  marks: ReadonlyMap<number, RowMarks>;
  next(): void;
  prev(): void;
}

const NONE: SearchResult = { hits: [], capped: false };
// Never equal to a real hit list, so the first render derives its current hit.
const UNSET: SearchHit[] = [];

/** Find in a diff: the hits, the current one (kept across rebuilds) and its row marks. */
export function useDiffSearch(
  diff: FileDiff,
  rows: DiffRow[],
  viewer: RefObject<DiffViewerHandle | null>,
  open: boolean,
): DiffSearch {
  const query = useDiffSearchStore((s) => s.query);
  const wholeWord = useDiffSearchStore((s) => s.wholeWord);
  const matchCase = useDiffSearchStore((s) => s.matchCase);
  const { hits, capped } = useMemo(
    () => (open ? findHits(diff, rows, query, { wholeWord, matchCase }) : NONE),
    [open, diff, rows, query, wholeWord, matchCase],
  );

  // The current hit with its identity, so it survives a rebuild of the hit list.
  const [state, setState] = useState<{
    hits: SearchHit[];
    index: number | null;
    anchor: HitAnchor | null;
    /** Bumped by every next/prev, so stepping always reveals. */
    steps: number;
  }>({ hits: UNSET, index: null, anchor: null, steps: 0 });
  // Re-derive on a new hit list while rendering, so no stale index is ever shown.
  let index = state.index;
  if (state.hits !== hits) {
    index = pickCurrent(hits, rows, state.anchor, viewer.current?.firstVisibleRow() ?? 0);
    const anchor = index === null ? state.anchor : hitAnchor(hits[index], rows);
    setState({ hits, index, anchor, steps: state.steps });
  }

  const step = useCallback(
    (delta: number) => {
      if (hits.length === 0) return;
      const from = index ?? (delta > 0 ? -1 : 0);
      const to = (from + delta + hits.length) % hits.length;
      setState((s) => ({ hits, index: to, anchor: hitAnchor(hits[to], rows), steps: s.steps + 1 }));
    },
    [hits, rows, index],
  );
  const next = useCallback(() => step(1), [step]);
  const prev = useCallback(() => step(-1), [step]);

  // Reveal when the current hit changes (a step, opening, a lost anchor), not when a rebuild
  // keeps the same hit: that must not pull the viewport back from where the user scrolled.
  const revealed = useRef<{ anchor: HitAnchor; steps: number } | null>(null);
  const { steps } = state;
  useEffect(() => {
    if (index === null) {
      revealed.current = null;
      return;
    }
    const anchor = hitAnchor(hits[index], rows);
    const last = revealed.current;
    const same =
      last !== null &&
      last.steps === steps &&
      last.anchor.key === anchor.key &&
      last.anchor.side === anchor.side &&
      last.anchor.start === anchor.start;
    if (same) return;
    revealed.current = { anchor, steps };
    viewer.current?.revealRow(hits[index].row);
  }, [hits, index, rows, steps, viewer]);

  const marks = useMemo(() => buildMarks(hits, rows, index), [hits, rows, index]);
  return { hits, capped, current: index, marks, next, prev };
}
