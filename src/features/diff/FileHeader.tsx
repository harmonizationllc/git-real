import { useId } from "react";
import type { CentreView } from "../../lib/store/workspace";
import styles from "./FileHeader.module.css";

export interface FileHeaderProps {
  path: string;
  oldPath?: string | null;
  view: CentreView;
  onViewChange(view: CentreView): void;
  onHistory(): void;
  onClose(): void;
}

const VIEW_LABELS: Record<CentreView, string> = { diff: "Diff", blame: "Blame" };

/** The selected file's path, the Diff/Blame toggle, History and Close; tops every centre state. */
export function FileHeader({
  path,
  oldPath,
  view,
  onViewChange,
  onHistory,
  onClose,
}: FileHeaderProps) {
  const groupName = useId();
  return (
    <div className={styles.root}>
      <span className={styles.path}>{oldPath ? `${oldPath} → ${path}` : path}</span>
      <div role="radiogroup" aria-label="View" className={styles.views}>
        {(["diff", "blame"] as const).map((v) => (
          <label key={v} className={styles.option}>
            <input
              type="radio"
              name={groupName}
              value={v}
              checked={view === v}
              onChange={() => onViewChange(v)}
            />
            {VIEW_LABELS[v]}
          </label>
        ))}
      </div>
      <button type="button" aria-label="Show file history" onClick={onHistory}>
        History
      </button>
      <CloseDiffButton onClick={onClose} />
    </div>
  );
}

export function CloseDiffButton({ onClick }: { onClick(): void }) {
  return (
    <button type="button" aria-label="Close diff" onClick={onClick}>
      ✕
    </button>
  );
}
