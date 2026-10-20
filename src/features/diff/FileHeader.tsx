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
  /** Disables the Blame option; shown as its title. */
  blameDisabledReason?: string;
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
  blameDisabledReason,
}: FileHeaderProps) {
  const groupName = useId();
  return (
    <div className={styles.root}>
      <span className={styles.path}>{oldPath ? `${oldPath} → ${path}` : path}</span>
      <div role="radiogroup" aria-label="View" className={styles.views}>
        {(["diff", "blame"] as const).map((v) => {
          const reason = v === "blame" ? blameDisabledReason : undefined;
          return (
            <label key={v} className={styles.option} title={reason}>
              <input
                type="radio"
                name={groupName}
                value={v}
                checked={view === v}
                disabled={reason !== undefined}
                onChange={() => onViewChange(v)}
              />
              {VIEW_LABELS[v]}
            </label>
          );
        })}
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
