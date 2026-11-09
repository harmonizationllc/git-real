import type { ChangeBlock } from "./model/changes";
import styles from "./ChangeRuler.module.css";

export interface ChangeRulerProps {
  blocks: ChangeBlock[];
  /** Total rows in the viewer; marks are placed as a percentage of it. */
  rowCount: number;
  current: number | null;
  onSelect(index: number): void;
}

/** A thin strip of one mark per change block, placed by row range; click to jump. */
export function ChangeRuler({ blocks, rowCount, current, onSelect }: ChangeRulerProps) {
  if (blocks.length === 0) return null;
  return (
    <div className={styles.ruler} data-testid="change-ruler">
      {blocks.map((block, i) => {
        const label = `Change ${i + 1} of ${blocks.length}: ${block.kind}`;
        return (
          <button
            key={`${block.hunkIndex}:${block.firstRow}`}
            type="button"
            tabIndex={-1}
            data-focus-target
            className={styles.mark}
            data-kind={block.kind}
            aria-label={label}
            title={label}
            aria-current={current === i ? "true" : undefined}
            // Multiply before dividing: (3 / 10) * 100 is 30.000000000000004.
            style={{
              top: `${(block.firstRow * 100) / rowCount}%`,
              height: `${((block.lastRow - block.firstRow + 1) * 100) / rowCount}%`,
            }}
            onClick={() => onSelect(i)}
          />
        );
      })}
    </div>
  );
}
