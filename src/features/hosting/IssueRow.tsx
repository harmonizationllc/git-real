import type { KeyboardEvent } from "react";
import type { Issue } from "../../lib/ipc";
import { fullDate } from "../graph/model/relativeTime";
import styles from "./IssueRow.module.css";

export interface IssueRowProps {
  issue: Issue;
  onOpen(): void;
  onContextMenu(x: number, y: number): void;
}

export function IssueRow({ issue, onOpen, onContextMenu }: IssueRowProps) {
  // The menu opens at the row button's bottom-left, as from a pointer at that corner.
  const openMenuAt = (button: HTMLButtonElement) => {
    const r = button.getBoundingClientRect();
    onContextMenu(r.left, r.bottom);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      // Without this WebKit also fires a native contextmenu on the row, opening the menu twice.
      e.preventDefault();
      openMenuAt(e.currentTarget);
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
      {/* The row is the context menu's button (a click or Enter opens it); the title says when it last changed. */}
      <button
        type="button"
        className={styles.row}
        aria-haspopup="menu"
        onClick={(e) => openMenuAt(e.currentTarget)}
        title={fullDate(issue.updatedAt)}
        onKeyDown={onKeyDown}
      >
        <span className={styles.line}>
          <span className={styles.number}>#{issue.number}</span>{" "}
          <span className={styles.title}>{issue.title}</span>
        </span>
        <span className={styles.meta}>
          <span className={styles.author}>{issue.author}</span>
          {issue.labels.map((label) => (
            <span key={label} className={styles.badge}>
              {label}
            </span>
          ))}
        </span>
      </button>
      <button
        type="button"
        className={styles.open}
        aria-label={`Open #${issue.number} in browser`}
        onClick={onOpen}
      >
        ↗
      </button>
    </li>
  );
}
