import { useCallback, useMemo, useState } from "react";
import type { FileDiff } from "../../lib/ipc";

export interface UseLineSelection {
  selected: ReadonlySet<number>;
  hunkIndex: number | null;
  click(hunk: number, line: number, shift: boolean): void;
  clear(): void;
}

type State =
  { hunkIndex: null } | { hunkIndex: number; anchor: number; selected: ReadonlySet<number> };

const EMPTY: State = { hunkIndex: null };
const NO_LINES: ReadonlySet<number> = new Set();

/** Selection of changed lines inside one hunk; resets whenever `diff` changes identity. */
export function useLineSelection(diff: FileDiff | undefined): UseLineSelection {
  const [state, setState] = useState<State>(EMPTY);
  const [seenDiff, setSeenDiff] = useState(diff);

  // Reset during render (not in an effect) so a stale selection is never painted.
  let current = state;
  if (seenDiff !== diff) {
    setSeenDiff(diff);
    setState(EMPTY);
    current = EMPTY;
  }

  const click = useCallback(
    (hunk: number, line: number, shift: boolean) => {
      const lines = diff?.hunks[hunk]?.lines;
      const kind = lines?.[line]?.kind;
      if (!lines || (kind !== "addition" && kind !== "deletion")) return;
      setState((prev) => {
        if (prev.hunkIndex !== hunk) {
          return { hunkIndex: hunk, anchor: line, selected: new Set([line]) };
        }
        const next = new Set(prev.selected);
        if (shift) {
          const [lo, hi] = prev.anchor < line ? [prev.anchor, line] : [line, prev.anchor];
          for (let i = lo; i <= hi; i++) if (lines[i].kind !== "context") next.add(i);
          return { ...prev, selected: next };
        }
        if (next.has(line)) next.delete(line);
        else next.add(line);
        return { hunkIndex: hunk, anchor: line, selected: next };
      });
    },
    [diff],
  );
  const clear = useCallback(() => setState(EMPTY), []);

  return useMemo(
    () => ({
      selected: current.hunkIndex === null ? NO_LINES : current.selected,
      hunkIndex: current.hunkIndex,
      click,
      clear,
    }),
    [current, click, clear],
  );
}
