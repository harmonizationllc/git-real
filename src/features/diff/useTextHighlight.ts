import { useEffect, useState } from "react";
import { highlightText, languageFor, loadParser, type Token } from "./model/highlight";
import { HIGHLIGHT_LIMIT } from "./model/limits";

/** Syntax tokens per line of a whole file, or null while loading / when highlighting is skipped. */
export function useTextHighlight(
  path: string,
  lines: string[] | undefined,
): (Token[] | null)[] | null {
  const [state, setState] = useState<{ lines: string[]; tokens: (Token[] | null)[] } | null>(null);
  useEffect(() => {
    if (!lines || lines.length > HIGHLIGHT_LIMIT) return;
    const desc = languageFor(path);
    if (!desc) return;
    let active = true;
    loadParser(desc)
      .then((parser) => {
        if (active) setState({ lines, tokens: highlightText(lines, parser) });
      })
      .catch((e: unknown) => {
        console.error("language load failed", e);
      });
    return () => {
      active = false;
    };
  }, [path, lines]);
  return state !== null && state.lines === lines ? state.tokens : null;
}
