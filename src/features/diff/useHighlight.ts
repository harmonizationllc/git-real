import { useEffect, useState } from "react";
import type { FileDiff } from "../../lib/ipc";
import { highlightDiff, languageFor, loadParser, type HighlightMap } from "./model/highlight";
import { HIGHLIGHT_LIMIT, totalLines } from "./model/limits";

export type { HighlightMap } from "./model/highlight";

/** Syntax tokens per hunk, or null while loading / when highlighting is skipped. */
export function useHighlight(diff: FileDiff | undefined): HighlightMap | null {
  const [state, setState] = useState<{ diff: FileDiff; map: HighlightMap } | null>(null);
  useEffect(() => {
    if (!diff || diff.isBinary || totalLines(diff) > HIGHLIGHT_LIMIT) return;
    const desc = languageFor(diff.path);
    if (!desc) return;
    let active = true;
    loadParser(desc)
      .then((parser) => {
        if (active) setState({ diff, map: highlightDiff(diff, parser) });
      })
      .catch((e: unknown) => {
        console.error("language load failed", e);
      });
    return () => {
      active = false;
    };
  }, [diff]);
  return state !== null && state.diff === diff ? state.map : null;
}
