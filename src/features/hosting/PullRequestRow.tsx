import type { KeyboardEvent } from "react";
import type { CiState, PullRequest } from "../../lib/ipc";
import { fullDate } from "../graph/model/relativeTime";
import styles from "./PullRequestRow.module.css";

export interface PullRequestRowProps {
  pr: PullRequest;
  onOpen(): void;
  onContextMenu(x: number, y: number): void;
}

const CI_TEXT: Record<Exclude<CiState, "none">, string> = {
  passing: "CI passing",
  failing: "CI failing",
  pending: "CI pending",
};

export function PullRequestRow({ pr, onOpen, onContextMenu }: PullRequestRowProps) {
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
      {/* No click action: the row is a focus stop for the context menu; the title says when it last changed. */}
      <button
        type="button"
        className={styles.row}
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
