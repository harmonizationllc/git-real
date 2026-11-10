import type { Compartment } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { useEffect, type RefObject } from "react";
import { languageFor, loadLanguage } from "../../diff/model/highlight";

/**
 * Loads syntax highlighting for `path` into `languageComp`, or clears it when the file is `big` or
 * of an unknown language. The view must exist before the effect runs (EditorPane's child effect).
 */
export function useEditorLanguage(
  viewRef: RefObject<EditorView | null>,
  languageComp: Compartment,
  path: string,
  big: boolean,
): void {
  useEffect(() => {
    const v = viewRef.current as EditorView;
    const desc = big ? null : languageFor(path);
    if (desc === null) {
      // Also drops highlighting when a reload crosses the limit.
      v.dispatch({ effects: languageComp.reconfigure([]) });
      return;
    }
    let cancelled = false;
    loadLanguage(desc).then(
      (support) => {
        if (!cancelled) v.dispatch({ effects: languageComp.reconfigure(support) });
      },
      (e: unknown) => console.error("language load failed", e),
    );
    return () => {
      cancelled = true;
    };
  }, [viewRef, languageComp, path, big]);
}
