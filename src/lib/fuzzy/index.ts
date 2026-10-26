/** The file picker never renders more rows than this. */
export const MAX_PICKER_ROWS = 200;

/** The command palette never renders more rows than this after ranking. */
export const MAX_PALETTE_ROWS = 50;

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

/**
 * The indices in `text` matched by the greedy leftmost walk of `query` (case-insensitive), for
 * highlighting each matched character. An empty query matches nothing (`[]`); `null` when `query`
 * is not a subsequence of `text`. Mirrors {@link fuzzyMatch}'s walk so the marks match the score.
 */
export function fuzzyIndices(query: string, text: string): number[] | null {
  if (query === "") return [];
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const indices: number[] = [];
  let at = -1;
  for (const ch of q) {
    at = t.indexOf(ch, at + 1);
    if (at === -1) return null;
    indices.push(at);
  }
  return indices;
}

/** Anything the palette can rank: a label and an optional detail line. */
export interface Rankable {
  label: string;
  detail?: string;
}

export interface Ranked<T> {
  item: T;
  matched: "label" | "detail" | null;
}

/**
 * Ranks `items` for `query` against the label first, then the detail. A blank query keeps the
 * input order with nothing marked. Matches sort by score, then label-before-detail, then input
 * order (stable); non-matches are dropped.
 */
export function rankCommands<T extends Rankable>(query: string, items: readonly T[]): Ranked<T>[] {
  if (query === "") return items.map((item) => ({ item, matched: null }));
  const scored: {
    item: T;
    matched: "label" | "detail";
    score: number;
    kind: number;
    index: number;
  }[] = [];
  items.forEach((item, index) => {
    const labelScore = fuzzyMatch(query, item.label);
    if (labelScore !== null) {
      scored.push({ item, matched: "label", score: labelScore, kind: 0, index });
      return;
    }
    const detailScore = item.detail !== undefined ? fuzzyMatch(query, item.detail) : null;
    if (detailScore !== null) {
      scored.push({ item, matched: "detail", score: detailScore, kind: 1, index });
    }
  });
  scored.sort((a, b) => a.score - b.score || a.kind - b.kind || a.index - b.index);
  return scored.map(({ item, matched }) => ({ item, matched }));
}
