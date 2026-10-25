import type { BlockLabels } from "./model/blocks";
import styles from "./ConflictToolbar.module.css";

export interface ConflictToolbarProps {
  path: string;
  /** null while loading or on the placeholder: only the path and Close show. */
  remaining: number | null;
  /** Some block is still unresolved, so Keep all / Take all have something to pick. */
  canPickAll: boolean;
  labels: BlockLabels;
  pending: boolean;
  // Optional: the count-less toolbar (loading, placeholder) renders only the path and Close.
  onPrevious?(): void;
  onNext?(): void;
  onKeepAll?(): void;
  onTakeAll?(): void;
  onMarkResolved?(): void;
  /** Launches the external merge tool; the button shows on both toolbars when given. */
  onOpenMergeTool?(): void;
  /** The external merge tool is open, so the button is busy and disabled. */
  mergeToolRunning?: boolean;
  onClose(): void;
}

function countCopy(remaining: number): string {
  if (remaining === 0) return "All conflicts resolved";
  return remaining === 1 ? "1 conflict remaining" : `${remaining} conflicts remaining`;
}

/** Why Mark resolved is disabled, or undefined when it is enabled. */
function markResolvedReason(remaining: number, pending: boolean): string | undefined {
  if (remaining > 0) return "Resolve all conflicts first";
  return pending ? "Saving…" : undefined;
}

/** The conflict editor's header: path, live count, navigation, bulk picks, Mark resolved and Close. */
export function ConflictToolbar({
  path,
  remaining,
  canPickAll,
  labels,
  pending,
  onPrevious,
  onNext,
  onKeepAll,
  onTakeAll,
  onMarkResolved,
  onOpenMergeTool,
  mergeToolRunning,
  onClose,
}: ConflictToolbarProps) {
  const close = (
    <button type="button" onClick={onClose}>
      Close
    </button>
  );
  const mergeToolButton = onOpenMergeTool && (
    <button type="button" disabled={mergeToolRunning} onClick={onOpenMergeTool}>
      {mergeToolRunning ? "Merge tool open…" : "Open in merge tool"}
    </button>
  );
  if (remaining === null) {
    return (
      <div className={styles.root}>
        <span className={styles.path}>{path}</span>
        <span className={styles.spacer} />
        {mergeToolButton}
        {close}
      </div>
    );
  }
  const none = remaining === 0;
  const pickDisabled = none || !canPickAll || pending;
  const reason = markResolvedReason(remaining, pending);
  return (
    <div className={styles.root}>
      <span className={styles.path}>{path}</span>
      <span className={styles.count}>{countCopy(remaining)}</span>
      <span className={styles.spacer} />
      <button type="button" disabled={none} onClick={onPrevious}>
        Previous
      </button>
      <button type="button" disabled={none} onClick={onNext}>
        Next
      </button>
      <button type="button" disabled={pickDisabled} onClick={onKeepAll}>
        Keep all {labels.ours}
      </button>
      <button type="button" disabled={pickDisabled} onClick={onTakeAll}>
        Take all {labels.theirs}
      </button>
      <button type="button" disabled={reason !== undefined} title={reason} onClick={onMarkResolved}>
        Mark resolved
      </button>
      {mergeToolButton}
      {close}
    </div>
  );
}
