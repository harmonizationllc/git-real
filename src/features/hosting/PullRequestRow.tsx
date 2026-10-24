import type { KeyboardEvent, Ref } from "react";
import type { CiState, PullRequest } from "../../lib/ipc";
import { fullDate } from "../graph/model/relativeTime";
import styles from "./PullRequestRow.module.css";

export interface PullRequestRowProps {
  pr: PullRequest;
  onOpen(): void;
  onContextMenu(x: number, y: number): void;
  /** Lands on the row button, so an open menu can tell a click on it from other clicks. */
  buttonRef?: Ref<HTMLButtonElement>;
}

const CI_TEXT: Record<Exclude<CiState, "none">, string> = {
  passing: "CI passing",
  failing: "CI failing",
  pending: "CI pending",
};

export function PullRequestRow({ pr, onOpen, onContextMenu, buttonRef }: PullRequestRowProps) {
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
        ref={buttonRef}
        type="button"
        className={styles.row}
        aria-haspopup="menu"
        onClick={(e) => openMenuAt(e.currentTarget)}
        title={fullDate(pr.updatedAt)}
        onKeyDown={onKeyDown}
      >
        <span className={styles.line}>
          <span className={styles.number}>#{pr.number}</span>{" "}
          <span className={styles.title}>{pr.title}</span>
        </span>
        <span className={styles.meta}>
          <span className={styles.branches}>
            {pr.author} · {pr.sourceBranch} → {pr.targetBranch}
          </span>
          {pr.draft && <span className={styles.badge}>Draft</span>}
          {pr.ciState !== "none" && (
            <span className={styles.badge} data-ci={pr.ciState}>
              {CI_TEXT[pr.ciState]}
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        className={styles.open}
        aria-label={`Open #${pr.number} in browser`}
        onClick={onOpen}
      >
        ↗
      </button>
    </li>
  );
}
