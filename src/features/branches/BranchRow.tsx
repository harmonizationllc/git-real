import type { KeyboardEvent } from "react";
import type { LocalBranch, RemoteBranch, Tracking } from "../../lib/ipc";
import styles from "./BranchRow.module.css";

export type BranchTarget =
  { kind: "local"; branch: LocalBranch } | { kind: "remote"; branch: RemoteBranch };

export interface BranchRowProps {
  target: BranchTarget;
  current: boolean;
  onActivate(): void;
  onContextMenu(x: number, y: number): void;
}

function TrackingBadge({ tracking }: { tracking: Tracking }) {
  const { ahead, behind } = tracking;
  if (ahead === null || behind === null) return <span className={styles.badge}>gone</span>;
  return (
    <span className={styles.badge} aria-label={`${ahead} ahead, ${behind} behind`}>
      {`↑${ahead} ↓${behind}`}
    </span>
  );
}

export function BranchRow({ target, current, onActivate, onContextMenu }: BranchRowProps) {
  const { branch } = target;
  const fullRef =
    target.kind === "local"
      ? `refs/heads/${branch.name}`
      : `refs/remotes/${target.branch.remote}/${branch.name}`;

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter") {
      onActivate();
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
        className={`${styles.row} ${current ? styles.current : ""}`}
        aria-current={current || undefined}
        title={fullRef}
        onDoubleClick={onActivate}
        onKeyDown={onKeyDown}
      >
        <span className={styles.name}>{branch.name}</span>
        {target.kind === "local" && target.branch.tracking !== null && (
          <TrackingBadge tracking={target.branch.tracking} />
        )}
      </button>
    </li>
  );
}
