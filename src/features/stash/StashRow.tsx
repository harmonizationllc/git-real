import type { KeyboardEvent } from "react";
import type { StashEntry } from "../../lib/ipc";
import { fullDate, relativeTime } from "../graph/model/relativeTime";
import styles from "./StashRow.module.css";
import { stashSubject } from "./stashCopy";

export interface StashRowProps {
  entry: StashEntry;
  selected: boolean;
  /** The current time in Unix seconds, from the panel's clock. */
  now: number;
  onSelect(): void;
  onContextMenu(x: number, y: number): void;
}

export function StashRow({ entry, selected, now, onSelect, onContextMenu }: StashRowProps) {
  // Enter and Space select through the native button click.
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      // Without this WebKit also fires a native contextmenu on the row, opening the menu twice.
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      onContextMenu(r.left, r.bottom);
    }
  };

  return (
    <li
      className={styles.item}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
    >
      <button
        type="button"
        className={`${styles.row} ${selected ? styles.selected : ""}`}
        aria-current={selected || undefined}
        title={entry.message}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        <span className={styles.subject}>{stashSubject(entry.message)}</span>
        <span className={styles.meta}>
          {entry.branch !== null && <span>{entry.branch}</span>}
          <time title={fullDate(entry.time)}>{relativeTime(entry.time, now * 1000)}</time>
          {entry.hasUntracked && <span className={styles.marker}>untracked</span>}
        </span>
      </button>
    </li>
  );
}
