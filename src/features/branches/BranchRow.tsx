import type { DragEvent, KeyboardEvent } from "react";
import type { LocalBranch, RemoteBranch, Tracking } from "../../lib/ipc";
import styles from "./BranchRow.module.css";

export type BranchTarget =
  { kind: "local"; branch: LocalBranch } | { kind: "remote"; branch: RemoteBranch };

/** The name git resolves for a row: `name` for local, `remote/name` for remote-tracking. */
export const branchId = (t: BranchTarget): string =>
  t.kind === "local" ? t.branch.name : `${t.branch.remote}/${t.branch.name}`;

/** Drag-to-merge wiring; the panel owns the state, the row only reports events. */
export interface BranchDrag {
  /** The row can be picked up. */
  draggable: boolean;
  /** The row accepts a drop: the current branch while another branch is dragged. */
  target: boolean;
  /** A dragged branch is over the row. */
  over: boolean;
  onDragStart(): void;
  onDragEnd(): void;
  onDragEnter(): void;
  onDragLeave(): void;
  onDrop(x: number, y: number): void;
}

export interface BranchRowProps {
  target: BranchTarget;
  current: boolean;
  drag?: BranchDrag;
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

/** The `<li>` props for drag-to-merge; none without `drag`. */
function dragProps(drag: BranchDrag | undefined, id: string) {
  if (drag === undefined) return {};
  return {
    draggable: drag.draggable || undefined,
    "data-drop-over": drag.over ? "true" : undefined,
    // dragstart bubbles from a text-selection drag inside a non-draggable row.
    onDragStart: (e: DragEvent<HTMLLIElement>) => {
      if (!drag.draggable) return;
      // WebKit starts a drag only when dragstart puts data on the transfer.
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
      drag.onDragStart();
    },
    onDragEnd: drag.onDragEnd,
    onDragEnter: () => {
      if (drag.target) drag.onDragEnter();
    },
    onDragLeave: () => {
      if (drag.target) drag.onDragLeave();
    },
    onDragOver: (e: DragEvent<HTMLLIElement>) => {
      if (!drag.target) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onDrop: (e: DragEvent<HTMLLIElement>) => {
      if (!drag.target) return;
      e.preventDefault();
      drag.onDrop(e.clientX, e.clientY);
    },
  };
}

export function BranchRow({ target, current, drag, onActivate, onContextMenu }: BranchRowProps) {
  const { branch } = target;
  const id = branchId(target);
  const fullRef = target.kind === "local" ? `refs/heads/${id}` : `refs/remotes/${id}`;

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
      {...dragProps(drag, id)}
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
