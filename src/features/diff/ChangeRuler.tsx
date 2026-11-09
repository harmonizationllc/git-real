import { memo, useMemo } from "react";
import type { ChangeBlock } from "./model/changes";
import { rulerMarks } from "./model/ruler";
import styles from "./ChangeRuler.module.css";

export interface ChangeRulerProps {
  blocks: ChangeBlock[];
  /** Total rows in the viewer; marks are placed as a percentage of it. */
  rowCount: number;
  current: number | null;
  onSelect(index: number): void;
}

/** A thin strip of marks for the change blocks, placed by row range; click to jump. */
export const ChangeRuler = memo(function ChangeRuler({
  blocks,
  rowCount,
  current,
  onSelect,
}: ChangeRulerProps) {
  const marks = useMemo(() => rulerMarks(blocks, rowCount), [blocks, rowCount]);
  if (blocks.length === 0) return null;
  return (
    // Mouse down must not move focus out of the diff; click still fires.
    <div
      className={styles.ruler}
      data-testid="change-ruler"
      role="group"
      aria-label="Change ruler"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className={styles.track}>
        {marks.map((m) => {
          const label =
            m.firstBlock === m.lastBlock
              ? `Change ${m.firstBlock + 1} of ${blocks.length}: ${m.kind}`
              : `Changes ${m.firstBlock + 1}–${m.lastBlock + 1} of ${blocks.length}: ${m.kind}`;
          return (
            <button
              key={m.firstBlock}
              type="button"
              tabIndex={-1}
              data-focus-target
              className={styles.mark}
              data-kind={m.kind}
              aria-label={label}
              title={label}
              aria-current={
                current !== null && current >= m.firstBlock && current <= m.lastBlock
                  ? "true"
                  : undefined
              }
              // Multiply before dividing: (3 / 10) * 100 is 30.000000000000004.
              style={{
                top: `${(m.firstRow * 100) / rowCount}%`,
                height: `${((m.lastRow - m.firstRow + 1) * 100) / rowCount}%`,
              }}
              onClick={() => onSelect(m.firstBlock)}
            />
          );
        })}
      </div>
    </div>
  );
});
