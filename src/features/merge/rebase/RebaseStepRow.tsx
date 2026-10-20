import type { DragEvent } from "react";
import type { RebaseAction } from "../../../lib/ipc";
import { shortOid } from "../../graph/model/layout";
import styles from "./RebaseStepRow.module.css";
import { ACTIONS, type PlanStep } from "./model/plan";

export interface RebaseStepRowProps {
  step: PlanStep;
  index: number;
  count: number;
  /** A squash or fixup with no kept step below it. */
  blocked: boolean;
  /** While a run is pending the row cannot be changed, moved or dragged. */
  disabled: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onAction(action: RebaseAction): void;
  onMove(to: number): void;
  onDragStart(): void;
  onDragOver(): void;
  onDrop(): void;
}

export function RebaseStepRow({
  step,
  index,
  count,
  blocked,
  disabled,
  dragging,
  dropTarget,
  onAction,
  onMove,
  onDragStart,
  onDragOver,
  onDrop,
}: RebaseStepRowProps) {
  const short = shortOid(step.oid);
  const fold = step.action === "squash" || step.action === "fixup";

  // WebKit starts a drag only when dragstart puts data on the transfer.
  const start = (e: DragEvent<HTMLLIElement>) => {
    if (disabled) return;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", step.oid);
    onDragStart();
  };
  const over = (e: DragEvent<HTMLLIElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    onDragOver();
  };
  const drop = (e: DragEvent<HTMLLIElement>) => {
    if (disabled) return;
    e.preventDefault();
    onDrop();
  };

  return (
    <li
      className={styles.row}
      draggable={!disabled}
      data-dropped={step.action === "drop" ? "true" : undefined}
      data-fold={fold ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      data-drop-target={dropTarget ? "true" : undefined}
      onDragStart={start}
      onDragOver={over}
      onDrop={drop}
    >
      <span className={styles.handle} aria-hidden="true">
        ⋮⋮
      </span>
      <select
        className={styles.select}
        aria-label={`Action for ${short}`}
        value={step.action}
        disabled={disabled}
        onChange={(e) => onAction(e.target.value as RebaseAction)}
      >
        {ACTIONS.map(({ action, label }) => (
          <option key={action} value={action}>
            {label}
          </option>
        ))}
      </select>
      <code className={styles.oid}>{short}</code>
      <span className={styles.subject} title={step.subject}>
        {step.subject}
      </span>
      <span className={styles.author}>{step.author.name}</span>
      <button
        type="button"
        aria-label="Move up"
        disabled={disabled || index === 0}
        onClick={() => onMove(index - 1)}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label="Move down"
        disabled={disabled || index === count - 1}
        onClick={() => onMove(index + 1)}
      >
        ↓
      </button>
      {blocked && (
        <p role="alert" className={styles.alert}>
          Cannot squash the oldest commit
        </p>
      )}
    </li>
  );
}
