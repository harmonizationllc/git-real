export type LayoutColumn = "refs" | "sidebar";

export { REFS_DEFAULT, SIDEBAR_DEFAULT } from "../lib/store/settings";

export const REFS_MIN = 160;
export const SIDEBAR_MIN = 240;
export const CENTER_MIN = 320;
export const KEY_STEP = 16;

/**
 * Fits the stored widths into `container` while the centre column keeps its minimum: the sidebar
 * shrinks first, then the refs column; neither goes below its minimum. An unmeasured (zero)
 * container passes the widths through.
 */
export function clampWidths(
  container: number,
  refs: number,
  sidebar: number,
): { refs: number; sidebar: number } {
  if (container <= 0) return { refs, sidebar };
  let r = Math.max(REFS_MIN, refs);
  let s = Math.max(SIDEBAR_MIN, sidebar);
  const over = r + s + CENTER_MIN - container;
  if (over > 0) {
    const cut = Math.min(over, s - SIDEBAR_MIN);
    s -= cut;
    r = Math.max(REFS_MIN, r - (over - cut));
  }
  return { refs: r, sidebar: s };
}

/** Largest width `column` may take beside `other` and the centre minimum; unbounded when unmeasured. */
export function maxWidth(container: number, column: LayoutColumn, other: number): number {
  if (container <= 0) return Infinity;
  const [min, otherMin] = column === "refs" ? [REFS_MIN, SIDEBAR_MIN] : [SIDEBAR_MIN, REFS_MIN];
  return Math.max(min, container - CENTER_MIN - Math.max(other, otherMin));
}
