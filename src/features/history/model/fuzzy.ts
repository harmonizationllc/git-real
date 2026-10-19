/** The picker never renders more rows than this. */
export const MAX_PICKER_ROWS = 200;

const BASENAME_BONUS = 1000;

/**
 * Case-insensitive subsequence match of `query` in `path`, scored by the matched span (lower is
 * better). The walk takes the leftmost occurrence of each character, so the span is the greedy
 * one. A query found inside the basename scores far above any scattered match. Null: no match.
 */
export function fuzzyMatch(query: string, path: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  let first = -1;
  let at = -1;
  for (const ch of q) {
    at = p.indexOf(ch, at + 1);
    if (at === -1) return null;
    if (first === -1) first = at;
  }
  const span = at - first + 1;
  const basename = p.slice(p.lastIndexOf("/") + 1);
  return basename.includes(q) ? span - BASENAME_BONUS : span;
}

/**
 * The best `limit` matches for `query`, by score then code-unit path order (locale independent,
 * like the backend's byte-order sort). An empty query keeps the input order.
 */
export function rankFiles(query: string, paths: string[], limit: number): string[] {
  if (query === "") return paths.slice(0, limit);
  const scored: [number, string][] = [];
  for (const path of paths) {
    const score = fuzzyMatch(query, path);
    if (score !== null) scored.push([score, path]);
  }
  scored.sort(([sa, pa], [sb, pb]) => sa - sb || Number(pa > pb) - Number(pa < pb));
  return scored.slice(0, limit).map(([, path]) => path);
}
