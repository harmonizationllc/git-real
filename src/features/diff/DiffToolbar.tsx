import { useId, useMemo } from "react";
import type { FileDiff } from "../../lib/ipc";
import type { DiffMode } from "../../lib/ipc";
import { encodingNotice } from "./model/encoding";
import { totalLines } from "./model/limits";
import styles from "./DiffToolbar.module.css";

interface Props {
  diff: FileDiff;
  mode: DiffMode;
  ignoreWhitespace: boolean;
  onModeChange(mode: DiffMode): void;
  onIgnoreWhitespaceChange(on: boolean): void;
  onLoadFull(): void;
}

const MODE_LABELS: Record<DiffMode, string> = { split: "Side by side", unified: "Unified" };

export function DiffToolbar({
  diff,
  mode,
  ignoreWhitespace,
  onModeChange,
  onIgnoreWhitespaceChange,
  onLoadFull,
}: Props) {
  const groupName = useId();
  const { additions, deletions } = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const h of diff.hunks) {
      for (const l of h.lines) {
        if (l.kind === "addition") additions++;
        else if (l.kind === "deletion") deletions++;
      }
    }
    return { additions, deletions };
  }, [diff]);
  const notice = encodingNotice(diff);
  return (
    <div className={styles.root}>
      <div className={styles.row}>
        <span className={styles.summary}>
          <span className={styles.added}>{`+${additions}`}</span>{" "}
          <span className={styles.removed}>{`−${deletions}`}</span>
        </span>
        <div role="radiogroup" aria-label="View mode" className={styles.modes}>
          {(["split", "unified"] as const).map((m) => (
            <label key={m} className={styles.option}>
              <input
                type="radio"
                name={groupName}
                value={m}
                checked={mode === m}
                onChange={() => onModeChange(m)}
              />
              {MODE_LABELS[m]}
            </label>
          ))}
        </div>
        <label className={styles.option}>
          <input
            type="checkbox"
            checked={ignoreWhitespace}
            onChange={(e) => onIgnoreWhitespaceChange(e.target.checked)}
          />
          Hide whitespace changes
        </label>
      </div>
      {notice && (
        <div className={styles.notice} data-testid="encoding-notice">
          {notice}
        </div>
      )}
      {diff.truncated && (
        <div className={styles.notice}>
          {/* Only the text is live, so the button label is not announced as status. */}
          <span role="status">{`Showing the first ${totalLines(diff)} lines`}</span>
          <button type="button" onClick={onLoadFull}>
            Load full diff
          </button>
        </div>
      )}
    </div>
  );
}
