import type { FileHistoryEntry } from "../../lib/ipc";
import { fullDate, relativeTime } from "../graph/model/relativeTime";
import { StatusBadge } from "../worktree/StatusBadge";
import styles from "./HistoryRow.module.css";

/** Two lines: the subject, then author and date. */
export const HISTORY_ROW_HEIGHT = 44;
/** The extra `old → new` line of a renamed entry. */
export const RENAME_LINE_HEIGHT = 16;
export const historyRowHeight = (e: FileHistoryEntry) =>
  HISTORY_ROW_HEIGHT + (e.oldPath === null ? 0 : RENAME_LINE_HEIGHT);

export interface HistoryRowProps {
  entry: FileHistoryEntry;
  /** The current time in Unix seconds; the row never reads the clock itself. */
  now: number;
  selected: boolean;
  id: string;
  onSelect(): void;
}

/** One commit of a file's history, stacked to fit the narrow refs column. */
export function HistoryRow({ entry, now, selected, id, onSelect }: HistoryRowProps) {
  return (
    <div
      role="option"
      id={id}
      aria-selected={selected}
      className={selected ? `${styles.row} ${styles.selected}` : styles.row}
      onClick={onSelect}
    >
      <span className={styles.line}>
        <StatusBadge kind={entry.change} />
        <span className={styles.subject}>{entry.subject}</span>
      </span>
      {entry.oldPath !== null && (
        <span className={`${styles.line} ${styles.muted}`}>
          <span className={styles.text}>{`${entry.oldPath} → ${entry.path}`}</span>
        </span>
      )}
      <span className={`${styles.line} ${styles.muted}`}>
        <span className={styles.text} title={entry.authorEmail}>
          {entry.authorName}
        </span>
        ·
        <span className={styles.date} title={fullDate(entry.authorTime)}>
          {relativeTime(entry.authorTime, now * 1000)}
        </span>
      </span>
    </div>
  );
}
