import type { KeyboardEvent } from "react";
import type { LinkedWorktree } from "../../lib/ipc";
import styles from "./WorktreeRow.module.css";
import { headText } from "./worktreeCopy";
import { folderName } from "./worktreePath";

export interface WorktreeRowProps {
  worktree: LinkedWorktree;
  onOpen(): void;
  onContextMenu(x: number, y: number): void;
}

export function WorktreeRow({ worktree, onOpen, onContextMenu }: WorktreeRowProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter") {
      onOpen();
    } else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
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
        className={`${styles.row} ${worktree.isCurrent ? styles.current : ""}`}
        aria-current={worktree.isCurrent || undefined}
        title={worktree.path}
        onDoubleClick={onOpen}
        onKeyDown={onKeyDown}
      >
        <span className={styles.line}>
          <span className={styles.name}>{folderName(worktree.path)}</span>
          {worktree.isMain && <span className={styles.badge}>main</span>}
          {worktree.isCurrent && <span className={styles.badge}>current</span>}
          {worktree.missing && <span className={styles.badge}>missing</span>}
          {worktree.locked !== null && (
            <span className={styles.badge} title={worktree.locked || "Locked"}>
              locked
            </span>
          )}
        </span>
        <span className={styles.head}>{headText(worktree.head)}</span>
      </button>
    </li>
  );
}
