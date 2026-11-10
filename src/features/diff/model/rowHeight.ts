/**
 * The height in px of a single-line diff row at `fontSize` px. It mirrors the CSS: the `.code`
 * and `.sign` cells use line-height 1.4 at `--diff-font-size`, and the gutter's line numbers
 * (12 px × line-height 1.5) keep any row at least 18 px tall.
 *
 * Exactness matters: a measured row that matches its estimate never changes the list's
 * `scrollHeight`, and Chromium loses a scrollbar thumb drag's motion whenever it does.
 */
export function rowHeightEstimate(fontSize: number): number {
  return Math.max(18, Math.round(fontSize * 1.4));
}
