/** Room kept for the subject beside the pills (the 8ch the old CSS cap reserved). */
export const SUBJECT_RESERVE_PX = 64;

/** Width assumed for the `+N` pill while it is not rendered or does not measure. */
export const MORE_PILL_PX = 36;

/**
 * How many candidate pills show: the largest `k ≥ 1` whose first `k` widths fit `budget`,
 * with `k − 1` gaps when `k` is every candidate, else with the `+N` pill and `k` gaps.
 */
export function fitLabels(
  widths: number[],
  gap: number,
  budget: number,
  moreWidth: number,
): number {
  let shown = 1;
  let sum = 0;
  widths.forEach((width, i) => {
    const k = i + 1;
    sum += width;
    const total = k === widths.length ? sum + (k - 1) * gap : sum + moreWidth + k * gap;
    if (total <= budget) shown = k;
  });
  return shown;
}
